// Page content editor. Parses a page's drawing operators, finds the painted
// objects (paths, text blocks, images, placed forms) with their page-space
// bounds, and applies edits by splicing the original bytes: everything not
// edited stays byte-for-byte identical.

const isWS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const DELIM = "()<>[]{}/%";

// ------------------------------------------------------------------ parsing
export function parseOps(s) {
  const ops = [];
  const n = s.length;
  let i = 0, operands = [], opStart = -1;

  const skipWS = () => {
    while (i < n) {
      if (isWS(s.charCodeAt(i))) i++;
      else if (s[i] === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; }
      else break;
    }
  };
  const readLiteral = () => {
    let depth = 1, out = "";
    i++;
    while (i < n && depth > 0) {
      const c = s[i++];
      if (c === "\\") {
        const e = s[i++];
        if (e >= "0" && e <= "7") {
          let oct = e;
          while (oct.length < 3 && s[i] >= "0" && s[i] <= "7") oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === "\r") { if (s[i] === "\n") i++; }
        else if (e !== "\n") out += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[e] ?? e;
      } else {
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
        out += c;
      }
    }
    return out;
  };
  const readValue = () => {
    const c = s[i];
    if (c === "/") {
      let j = i + 1;
      while (j < n && !isWS(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
      const name = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      i = j;
      return { name };
    }
    if (c === "(") return { str: readLiteral() };
    if (c === "<" && s[i + 1] === "<") {
      i += 2;
      const dict = {};
      for (;;) {
        skipWS();
        if (i >= n) return { dict };
        if (s[i] === ">" && s[i + 1] === ">") { i += 2; return { dict }; }
        const k = readValue();
        skipWS();
        const v = readValue();
        if (k.name !== undefined) dict[k.name] = v;
      }
    }
    if (c === "<") {
      const j = s.indexOf(">", i);
      let hex = s.slice(i + 1, j < 0 ? n : j).replace(/\s/g, "");
      if (hex.length % 2) hex += "0";
      let str = "";
      for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
      i = j < 0 ? n : j + 1;
      return { str };
    }
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        skipWS();
        if (i >= n) return { arr };
        if (s[i] === "]") { i++; return { arr }; }
        arr.push(readValue());
      }
    }
    let j = i;
    while (j < n && !isWS(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
    if (j === i) { i++; return { kw: c }; }
    const tok = s.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return { num: parseFloat(tok) };
    return { kw: tok };
  };

  for (;;) {
    skipWS();
    if (i >= n) break;
    if (opStart < 0) opStart = i;
    const v = readValue();
    if (v.kw === undefined) { operands.push(v); continue; }
    if (v.kw === "true" || v.kw === "false" || v.kw === "null") { operands.push({ num: v.kw === "true" ? 1 : 0 }); continue; }
    if (v.kw === "BI") {
      const id = s.indexOf("ID", i);
      let p = id + 3, end = n;
      for (;;) {
        const ei = s.indexOf("EI", p);
        if (ei < 0) break;
        if (isWS(s.charCodeAt(ei - 1)) && (ei + 2 >= n || isWS(s.charCodeAt(ei + 2)))) { end = ei + 2; break; }
        p = ei + 2;
      }
      i = end;
      ops.push({ op: "BI", args: [], s: opStart, e: i });
    } else {
      ops.push({ op: v.kw, args: operands, s: opStart, e: i });
    }
    operands = [];
    opStart = -1;
  }
  return ops;
}

// ------------------------------------------------------------------ geometry
export const IDENT = [1, 0, 0, 1, 0, 0];
export const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];
const tp = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const grow = (bb, p) => { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); };
const emptyBox = () => [Infinity, Infinity, -Infinity, -Infinity];
const rectCorners = (m, x0, y0, x1, y1, bb) => { grow(bb, tp(m, x0, y0)); grow(bb, tp(m, x1, y0)); grow(bb, tp(m, x0, y1)); grow(bb, tp(m, x1, y1)); };

const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const CONSTRUCT = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const COLOUR_OPS = new Set(["g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "SC", "scn", "SCN"]);
export const STATE_OPS = new Set(["w", "J", "j", "M", "d", "ri", "i", "gs", ...COLOUR_OPS, "Tc", "Tw", "Tz", "TL", "Tf", "Tr", "Ts"]);
const num = (a) => (a && a.num !== undefined ? a.num : 0);

// ctx: { font(name) -> {twoByte, width(code)}, xobject(name) -> {kind, bbox, matrix}, colour(name) -> label }
export function findObjects(ops, ctx) {
  let g = { ctm: IDENT, fill: "Black (Gray 0)", stroke: "Black (Gray 0)", fcs: "DeviceGray", scs: "DeviceGray", font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
  const stack = [];
  const objs = [];
  const mc = [];      // open marked-content sequences: {k, tag, prop, dict}
  const mcEnd = {};   // BDC/BMC op index -> matching EMC op index
  let pathStart = -1, pathBox = emptyBox(), clip = false, pathMc = null;
  let text = null, Tm = IDENT, Tlm = IDENT;
  const colourLabel = (space, args) => {
    const v = args.filter((a) => a.num !== undefined).map((a) => +a.num.toFixed(3));
    if (space === "DeviceGray") return `Gray ${v[0] ?? 0}`;
    if (space === "DeviceRGB") return `RGB ${v.join(" ")}`;
    if (space === "DeviceCMYK") return `CMYK ${v.map((x) => Math.round(x * 100)).join("/")}`;
    const nm = ctx.colour(space);
    return v.length === 1 ? `${nm} ${Math.round(v[0] * 100)}%` : `${nm} ${v.join(" ")}`;
  };
  const show = (bytes, isTJ) => {
    const f = g.font ? ctx.font(g.font) : null;
    const items = isTJ ? bytes : [{ str: bytes }];
    let adv = 0;
    for (const it of items) {
      if (it.num !== undefined) { adv += (-it.num / 1000) * g.size * g.Th; continue; }
      const str = it.str ?? "";
      const step = f && f.twoByte ? 2 : 1;
      for (let k = 0; k < str.length; k += step) {
        const code = step === 2 ? (str.charCodeAt(k) << 8) | (str.charCodeAt(k + 1) || 0) : str.charCodeAt(k);
        const w = f ? f.width(code) : 500;
        adv += ((w / 1000) * g.size + g.Tc + (step === 1 && code === 32 ? g.Tw : 0)) * g.Th;
      }
    }
    const m = mul(Tm, g.ctm);
    if (!text.tm) { text.tm = m; text.size = g.size; text.font = g.font; }
    rectCorners(m, 0, g.Ts - 0.22 * g.size, adv, g.Ts + 0.8 * g.size, text.box);
    Tm = mul([1, 0, 0, 1, adv, 0], Tm);
  };

  ops.forEach((o, k) => {
    const a = o.args;
    switch (o.op) {
      case "q": stack.push({ ...g }); break;
      case "Q": if (stack.length) g = stack.pop(); break;
      case "cm": g.ctm = mul(a.map(num), g.ctm); break;
      case "g": g.fcs = "DeviceGray"; g.fill = colourLabel("DeviceGray", a); break;
      case "G": g.scs = "DeviceGray"; g.stroke = colourLabel("DeviceGray", a); break;
      case "rg": g.fcs = "DeviceRGB"; g.fill = colourLabel("DeviceRGB", a); break;
      case "RG": g.scs = "DeviceRGB"; g.stroke = colourLabel("DeviceRGB", a); break;
      case "k": g.fcs = "DeviceCMYK"; g.fill = colourLabel("DeviceCMYK", a); break;
      case "K": g.scs = "DeviceCMYK"; g.stroke = colourLabel("DeviceCMYK", a); break;
      case "cs": g.fcs = a[0]?.name ?? "DeviceGray"; g.fill = colourLabel(g.fcs, []); break;
      case "CS": g.scs = a[0]?.name ?? "DeviceGray"; g.stroke = colourLabel(g.scs, []); break;
      case "sc": case "scn": g.fill = colourLabel(g.fcs, a); break;
      case "SC": case "SCN": g.stroke = colourLabel(g.scs, a); break;
      case "W": case "W*": clip = true; break;
      case "BDC": case "BMC": mc.push({ k, tag: a[0]?.name, prop: a[1]?.name ?? null, dict: a[1]?.dict ?? null }); break;
      case "EMC": { const e = mc.pop(); if (e) mcEnd[e.k] = k; break; }
      case "BT": text = { a: k, box: emptyBox(), ctm: g.ctm, mc: mc.slice(), tm: null, size: 0, font: null }; Tm = Tlm = IDENT; break;
      case "ET":
        if (text) {
          const sz = text.tm ? text.size * Math.sqrt(Math.abs(text.tm[0] * text.tm[3] - text.tm[1] * text.tm[2])) : g.size;
          objs.push({ type: "text", a: text.a, b: k, ctm: text.ctm, bbox: text.box, mc: text.mc, tm: text.tm, size: sz, fontRes: text.font ?? g.font,
            desc: `Text · ${text.font ?? g.font ?? "?"} ${+sz.toFixed(2)} pt · ${g.fill}` });
          text = null;
        }
        break;
      case "Tf": g.font = a[0]?.name ?? null; g.size = num(a[1]); break;
      case "Tc": g.Tc = num(a[0]); break;
      case "Tw": g.Tw = num(a[0]); break;
      case "Tz": g.Th = num(a[0]) / 100; break;
      case "TL": g.TL = num(a[0]); break;
      case "Ts": g.Ts = num(a[0]); break;
      case "Td": Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = Tlm; break;
      case "TD": g.TL = -num(a[1]); Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = Tlm; break;
      case "Tm": Tlm = Tm = a.map(num); break;
      case "T*": Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm); Tm = Tlm; break;
      case "Tj": if (text) show(a[0]?.str ?? "", false); break;
      case "TJ": if (text) show(a[0]?.arr ?? [], true); break;
      case "'": if (text) { Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm); Tm = Tlm; show(a[0]?.str ?? "", false); } break;
      case '"': if (text) { g.Tw = num(a[0]); g.Tc = num(a[1]); Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm); Tm = Tlm; show(a[2]?.str ?? "", false); } break;
      case "Do": {
        const name = a[0]?.name;
        const x = name ? ctx.xobject(name) : null;
        const bb = emptyBox();
        if (x && x.kind === "Form") rectCorners(mul(x.matrix, g.ctm), ...x.bbox, bb);
        else rectCorners(g.ctm, 0, 0, 1, 1, bb);
        const label = x && x.kind === "Form" ? (x.barcode ? `Barcode · ${x.barcode}` : `Placed artwork /${name}`) : `Image /${name}`;
        objs.push({ type: x && x.kind === "Form" ? "form" : "image", a: k, b: k, ctm: g.ctm, bbox: bb, desc: label, mc: mc.slice(), xname: name, xoc: x ? x.oc : null, barcode: x ? x.meta : null });
        break;
      }
      case "BI": { const bb = emptyBox(); rectCorners(g.ctm, 0, 0, 1, 1, bb); objs.push({ type: "image", a: k, b: k, ctm: g.ctm, bbox: bb, desc: "Inline image", mc: mc.slice() }); break; }
      default:
        if (CONSTRUCT.has(o.op)) {
          if (pathStart < 0) { pathStart = k; pathMc = mc.slice(); }
          const v = a.map(num);
          if (o.op === "re") rectCorners(g.ctm, v[0], v[1], v[0] + v[2], v[1] + v[3], pathBox);
          else for (let p = 0; p + 1 < v.length; p += 2) grow(pathBox, tp(g.ctm, v[p], v[p + 1]));
        } else if (PAINT.has(o.op)) {
          if (pathStart >= 0 && o.op !== "n" && Number.isFinite(pathBox[0])) {
            const filled = !["S", "s"].includes(o.op), stroked = ["S", "s", "B", "B*", "b", "b*"].includes(o.op);
            const parts = [filled ? `fill ${g.fill}` : null, stroked ? `stroke ${g.stroke}` : null].filter(Boolean);
            objs.push({ type: "path", a: pathStart, b: k, ctm: g.ctm, bbox: pathBox, clip, mc: pathMc, desc: `Path · ${parts.join(" · ")}${clip ? " · clipping" : ""}` });
          }
          pathStart = -1; pathBox = emptyBox(); clip = false;
        }
    }
  });
  const out = objs.filter((o) => Number.isFinite(o.bbox[0]));
  // our own wrapper: /PPObj <<...>> BDC ... EMC holding exactly one object
  // (it may also hold that object's own q/cm/Q from earlier edits)
  const inside = new Map();
  for (const o of objs) {
    const top = o.mc && o.mc[o.mc.length - 1];
    if (top && top.tag === "PPObj") inside.set(top.k, (inside.get(top.k) || 0) + 1);
  }
  for (const o of out) {
    const top = o.mc && o.mc[o.mc.length - 1];
    o.wrap = top && top.tag === "PPObj" && inside.get(top.k) === 1 && mcEnd[top.k] !== undefined
      ? { bdc: top.k, emc: mcEnd[top.k], props: plainDict(top.dict) } : null;
    o.outer = o.wrap ? o.mc.slice(0, -1) : o.mc || [];
    o.layers = o.outer.filter((e) => e.tag === "OC" && e.prop).map((e) => e.prop);
  }
  return out;
}

// marked-content property dict -> plain JS (numbers, strings as raw bytes, names)
function plainDict(d) {
  const out = {};
  if (!d) return out;
  for (const [k, v] of Object.entries(d)) out[k] = v.num !== undefined ? v.num : v.str !== undefined ? v.str : v.name !== undefined ? v.name : null;
  return out;
}
export const utf16hex = (t) => { let h = "FEFF"; for (let i = 0; i < t.length; i++) h += t.charCodeAt(i).toString(16).padStart(4, "0"); return `<${h.toUpperCase()}>`; };
export const fromUtf16 = (raw) => {
  if (!raw) return "";
  if (raw.charCodeAt(0) !== 0xfe || raw.charCodeAt(1) !== 0xff) return raw;
  let t = "";
  for (let i = 2; i + 1 < raw.length; i += 2) t += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
  return t;
};
const hexBytes = (t) => "<" + [...t].map((c) => (c.charCodeAt(0) & 255).toString(16).padStart(2, "0")).join("") + ">";
// serialise props; strings are written as hex so any content is safe
export function propsToPdf(p) {
  const parts = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || v === "") continue;
    parts.push(`/${k} ${typeof v === "number" ? +v.toFixed(4) : typeof v === "string" && v.startsWith("<") ? v : hexBytes(String(v))}`);
  }
  return `<<${parts.join(" ")}>>`;
}
export function invert(m) {
  const [a, b, c, d, e, f] = m, det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// state at the end of the stream: is it safe to append page-space content directly?
export function endIsClean(ops) {
  let depth = 0, ctm = IDENT, bt = false, mcd = 0;
  const stack = [];
  for (const o of ops) {
    if (o.op === "q") { stack.push(ctm); depth++; }
    else if (o.op === "Q") { if (stack.length) ctm = stack.pop(); depth--; }
    else if (o.op === "cm") ctm = mul(o.args.map(num), ctm);
    else if (o.op === "BT") bt = true; else if (o.op === "ET") bt = false;
    else if (o.op === "BDC" || o.op === "BMC") mcd++; else if (o.op === "EMC") mcd--;
  }
  return depth === 0 && !bt && mcd === 0 && ctm.every((v, i) => Math.abs(v - IDENT[i]) < 1e-9);
}

// ------------------------------------------------------------------ editing
const f4 = (v) => +v.toFixed(4);
const opText = (s, o) => s.slice(o.s, o.e);

// edit: { action, ... }. Returns the new content string. Everything outside
// the edited object is kept byte-for-byte.
export function editContent(s, ops, objs, edit) {
  const o = objs[edit.obj];
  if (!o) throw new Error("Object not found");
  if (o.clip) throw new Error("This path is also a clipping path; editing it would change other artwork.");
  const start = ops[o.a].s, end = ops[o.b].e;
  // the object plus our wrapper, if it has one
  const fullS = o.wrap ? ops[o.wrap.bdc].s : start, fullE = o.wrap ? ops[o.wrap.emc].e : end;
  // State set inside the object (legal inside text; common, if non-standard, inside paths)
  // still applies to later artwork, so it is replayed after any q/Q isolation.
  const inner = ops.slice(o.a, o.b + 1);
  const replay = inner.filter((x) => STATE_OPS.has(x.op)).map((x) => opText(s, x)).join("\n");
  const tail = replay ? `\n${replay}\n` : "\n";
  const splice = (a, b, rep) => s.slice(0, a) + rep + s.slice(b);

  switch (edit.action) {
    case "delete":
      return splice(fullS, fullE, tail);
    case "move": {
      const [a, b, c, d] = o.ctm, det = a * d - b * c;
      if (Math.abs(det) < 1e-12) throw new Error("Object has a degenerate transform");
      const ux = (edit.dx * d - edit.dy * c) / det, uy = (edit.dy * a - edit.dx * b) / det;
      return splice(start, end, `\nq 1 0 0 1 ${f4(ux)} ${f4(uy)} cm\n${s.slice(start, end)}\nQ${tail}`);
    }
    case "recolour": {
      if (o.type !== "path" && o.type !== "text") throw new Error("Only paths and text can change ink");
      const keep = (x) => !COLOUR_OPS.has(x.op);
      if (o.type === "path") return splice(start, end, `\nq\n${edit.colour}\n${inner.filter(keep).map((x) => opText(s, x)).join("\n")}\nQ${tail}`);
      return splice(start, end, `\nq\nBT\n${edit.colour}\n${inner.slice(1, -1).filter(keep).map((x) => opText(s, x)).join("\n")}\nET\nQ${tail}`);
    }
    case "props": {
      // merge/clear our wrapper properties (group id, lock, text settings)
      const props = { ...(o.wrap ? o.wrap.props : {}), ...edit.props };
      for (const k of Object.keys(props)) if (props[k] === null || props[k] === undefined) delete props[k];
      const empty = Object.keys(props).length === 0;
      if (o.wrap) {
        const bdc = ops[o.wrap.bdc], emc = ops[o.wrap.emc];
        const head = empty ? "" : `/PPObj ${propsToPdf(props)} BDC`;
        return s.slice(0, bdc.s) + head + s.slice(bdc.e, emc.s) + (empty ? "" : "EMC") + s.slice(emc.e);
      }
      if (empty) return s;
      return splice(start, end, `/PPObj ${propsToPdf(props)} BDC\n${s.slice(start, end)}\nEMC`);
    }
    case "layer": {
      // close enclosing sequences down to (and including) the outermost layer,
      // put the object in the new layer (keeping its other tags), then reopen
      const outer = o.outer;
      const j = outer.findIndex((e) => e.tag === "OC");
      const seg = s.slice(fullS, fullE);
      let rep;
      if (j < 0) {
        rep = edit.res ? `/OC /${edit.res} BDC\n${seg}\nEMC` : seg;
      } else {
        const closing = outer.slice(j).map(() => "EMC").join("\n");
        const keepTags = outer.slice(j + 1).filter((e) => e.tag !== "OC").map((e) => opText(s, ops[e.k]));
        const open = (edit.res ? [`/OC /${edit.res} BDC`] : []).concat(keepTags);
        const reopen = outer.slice(j).map((e) => opText(s, ops[e.k])).join("\n");
        rep = `\n${closing}\n${open.join("\n")}\n${seg}\n${open.map(() => "EMC").join("\n")}\n${reopen}\n`;
      }
      return splice(fullS, fullE, rep);
    }
    case "replaceText": {
      // new text drawn in page space at the original text's position and angle
      const inv = invert(o.ctm);
      const body = `q ${inv.map(f4).join(" ")} cm\n${edit.block}\nQ`;
      const props = { ...(o.wrap ? o.wrap.props : {}), ...edit.props };
      return splice(fullS, fullE, `/PPObj ${propsToPdf(props)} BDC\n${body}\nEMC${tail}`);
    }
    case "swapForm":
      return splice(ops[o.a].s, ops[o.a].e, `/${edit.name} Do`);
    default:
      throw new Error("Unknown edit " + edit.action);
  }
}

// Append page-space content, isolating it from whatever state the existing
// content leaves behind (only wrapped when that state isn't already clean).
export function appendBlock(s, ops, block) {
  return endIsClean(ops) ? `${s}\n${block}\n` : `q\n${s}\nQ\n${block}\n`;
}
