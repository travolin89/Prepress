// Shared engine logic (runs inside the engine worker; also testable in Node).
// Works on MuPDF.js PDFDocument / PDFObject instances. Never rewrites a file:
// saving is done incrementally so the original bytes stay untouched.

export const PT_TO_MM = 25.4 / 72;
export const PROCESS_INKS = { Cyan: [0, 174, 239], Magenta: [236, 0, 140], Yellow: [255, 242, 0], Black: [35, 31, 32] };
export const FALLBACK_RGB = [150, 150, 150];
export const BOX_NAMES = ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"];
const SKIP_INKS = new Set(["All", "None"]);

const has = (o) => o && !o.isNull();
const nums = (a) => { const r = []; for (let i = 0; i < a.length; i++) r.push(a.get(i).asNumber()); return r; };
const keysOf = (d) => { const k = []; d.forEach((_, key) => k.push(key)); return k; };
const valsOf = (d) => { const v = []; if (has(d)) d.forEach((val) => v.push(val)); return v; };

// ------------------------------------------------------------------ page info
export function pageBoxes(doc, i) {
  const p = doc.loadPage(i).getObject();
  const boxes = {};
  for (const n of BOX_NAMES) {
    const v = n === "MediaBox" || n === "CropBox" ? p.getInheritable(n) : p.get(n);
    if (has(v) && v.isArray() && v.length === 4) {
      const [a, b, c, d] = nums(v);
      boxes[n] = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }
  }
  return boxes;
}

export function pageRotation(doc, i) {
  const r = doc.loadPage(i).getObject().getInheritable("Rotate");
  return has(r) ? ((r.asNumber() % 360) + 360) % 360 : 0;
}

export function setPageBox(doc, i, name, rect) {
  if (!BOX_NAMES.includes(name) || name === "MediaBox") throw new Error("Only Crop/Bleed/Trim/Art boxes can be edited");
  const p = doc.loadPage(i).getObject();
  p.put(name, rect.map((v) => Math.round(v * 1000) / 1000));
}

// ------------------------------------------------------------------ report
export function xmpText(doc) {
  const m = doc.getTrailer().get("Root").get("Metadata");
  if (!has(m) || !m.isStream()) return "";
  try { return new TextDecoder().decode(m.readStream().asUint8Array()); } catch { return ""; }
}

export function xmpValue(xmp, key) {
  const m = xmp.match(new RegExp("(?:\\w+:)?" + key + '(?:\\s*=\\s*"([^"]*)"|\\s*>([^<]*)<)'));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

const mm = (b) => `${((b[2] - b[0]) * PT_TO_MM).toFixed(2)} × ${((b[3] - b[1]) * PT_TO_MM).toFixed(2)} mm`;

export function documentReport(doc) {
  const v = doc.getVersion();
  const L = [`PDF version: ${Math.floor(v / 10)}.${v % 10}`, `Pages: ${doc.countPages()}`];
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");
  const info = trailer.get("Info");
  const xInfo = has(info) && has(info.get("GTS_PDFXVersion")) ? info.get("GTS_PDFXVersion").asString() : null;
  const xmp = xmpText(doc);
  L.push(`PDF/X (Info): ${xInfo || "–"}   PDF/X (XMP): ${xmpValue(xmp, "GTS_PDFXVersion") || "–"}`);
  const creator = xmpValue(xmp, "CreatorTool") || (has(info) && has(info.get("Creator")) ? info.get("Creator").asString() : null);
  L.push(`Creator: ${creator || "–"}`);
  L.push(xmp ? `XMP packet: ${xmp.length} bytes` : "XMP packet: none");

  const intents = root.get("OutputIntents");
  if (has(intents) && intents.isArray() && intents.length) {
    for (let i = 0; i < intents.length; i++) {
      const oi = intents.get(i);
      const cond = oi.get("OutputConditionIdentifier");
      L.push(`Output intent ${has(oi.get("S")) ? oi.get("S").asName() : "?"}: ${has(cond) ? cond.asString() : "–"} (${has(oi.get("DestOutputProfile")) ? "ICC embedded" : "no ICC"})`);
    }
  } else L.push("Output intents: none");

  const pieces = new Set();
  if (has(root.get("PieceInfo"))) keysOf(root.get("PieceInfo")).forEach((k) => pieces.add(k));
  for (let i = 0; i < doc.countPages(); i++) {
    const pi = doc.loadPage(i).getObject().get("PieceInfo");
    if (has(pi)) keysOf(pi).forEach((k) => pieces.add(k));
  }
  L.push(`Private app data (PieceInfo): ${pieces.size ? [...pieces].sort().join(", ") : "none"}`);

  const ocgs = root.get("OCProperties", "OCGs");
  if (has(ocgs) && ocgs.isArray()) {
    const names = [];
    for (let i = 0; i < ocgs.length; i++) { const n = ocgs.get(i).get("Name"); if (has(n)) names.push(n.asString()); }
    L.push(`Layers: ${names.join(", ") || "present"}`);
  }
  for (let i = 0; i < doc.countPages(); i++) {
    const rot = pageRotation(doc, i);
    const parts = Object.entries(pageBoxes(doc, i)).map(([n, b]) => `${n.replace("Box", "")} ${mm(b)}`);
    L.push(`Page ${i + 1}${rot ? ` (rotated ${rot}°)` : ""}: ${parts.join("; ")}`);
  }
  return L;
}

// ------------------------------------------------------------------ inks
export function scanPageInks(doc, i) {
  const found = {};
  walkResources(doc.loadPage(i).getObject().getInheritable("Resources"), found, new Set());
  return found;
}

function markSeen(o, seen) {
  if (!o.isIndirect()) return false;
  const n = o.asIndirect();
  if (seen.has(n)) return true;
  seen.add(n);
  return false;
}

function walkResources(res, found, seen) {
  if (!has(res) || !res.isDictionary() || markSeen(res, seen)) return;
  valsOf(res.get("ColorSpace")).forEach((cs) => addCS(cs, found));
  for (const xo of valsOf(res.get("XObject"))) {
    const st = xo.get("Subtype");
    if (!has(st)) continue;
    if (st.asName() === "Image" && has(xo.get("ColorSpace"))) addCS(xo.get("ColorSpace"), found);
    else if (st.asName() === "Form" && !markSeen(xo, seen)) {
      if (has(xo.get("Group", "CS"))) addCS(xo.get("Group", "CS"), found);
      walkResources(xo.get("Resources"), found, seen);
    }
  }
  for (const sh of valsOf(res.get("Shading"))) if (has(sh.get("ColorSpace"))) addCS(sh.get("ColorSpace"), found);
  for (const pat of valsOf(res.get("Pattern"))) {
    if (has(pat.get("Resources"))) walkResources(pat.get("Resources"), found, seen);
    if (has(pat.get("Shading", "ColorSpace"))) addCS(pat.get("Shading", "ColorSpace"), found);
  }
  for (const gs of valsOf(res.get("ExtGState"))) {
    const g = gs.isDictionary() ? gs.get("SMask") : null;
    if (g && has(g) && g.isDictionary() && has(g.get("G"))) walkResources(g.get("G").get("Resources"), found, seen);
  }
}

function remember(found, name, rgb) {
  if (SKIP_INKS.has(name) || name in PROCESS_INKS) return;
  if (!found[name]) found[name] = rgb;
}

function addCS(cs, found) {
  if (!has(cs) || !cs.isArray() || !cs.length) return;
  const fam = cs.get(0).asName();
  if (fam === "Separation" && cs.length >= 4) {
    remember(found, cs.get(1).asName(), tintColour(cs.get(2), cs.get(3), [1]));
  } else if (fam === "DeviceN" && cs.length >= 4) {
    const arr = cs.get(1);
    const names = [];
    for (let i = 0; i < arr.length; i++) names.push(arr.get(i).asName());
    const colorants = cs.length > 4 ? cs.get(4).get("Colorants") : null;
    names.forEach((n, i) => {
      let rgb = null;
      const sub = colorants && has(colorants) ? colorants.get(n) : null;
      if (sub && has(sub) && sub.isArray() && sub.length >= 4) rgb = tintColour(sub.get(2), sub.get(3), [1]);
      if (!rgb) { const inp = names.map((_, k) => (k === i ? 1 : 0)); rgb = tintColour(cs.get(2), cs.get(3), inp); }
      remember(found, n, rgb);
    });
  } else if ((fam === "Indexed" || fam === "Pattern") && cs.length > 1) addCS(cs.get(1), found);
}

export function tintColour(alt, fn, inputs) {
  try { return altToRgb(alt, evalFunction(fn, inputs)); } catch { return null; }
}

function altToRgb(alt, v) {
  let fam, params = null;
  if (alt.isName()) fam = alt.asName();
  else { fam = alt.get(0).asName(); if (alt.length > 1) params = alt.get(1); }
  if (fam === "ICCBased") fam = { 1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK" }[params.get("N").asNumber()];
  let rgb;
  const cl = (x) => Math.min(Math.max(x, 0), 1);
  if (fam === "DeviceCMYK") { const [c, m, y, k] = v.map(cl); rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
  else if (fam === "DeviceRGB" || fam === "CalRGB") rgb = v.slice(0, 3);
  else if (fam === "DeviceGray" || fam === "CalGray") rgb = [v[0], v[0], v[0]];
  else if (fam === "Lab") {
    const wp = params && has(params.get("WhitePoint")) ? nums(params.get("WhitePoint")) : [0.9642, 1, 0.8249];
    rgb = labToSrgb(v[0], v[1], v[2], wp);
  } else return null;
  return rgb.map((x) => Math.round(cl(x) * 255));
}

function labToSrgb(L, a, b, wp) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, d = 6 / 29;
  const f = (t) => (t > d ? t ** 3 : 3 * d * d * (t - 4 / 29));
  const X = wp[0] * f(fx), Y = wp[1] * f(fy), Z = wp[2] * f(fz);
  const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const g = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const enc = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.max(u, 0) ** (1 / 2.4) - 0.055);
  return [enc(r), enc(g), enc(bl)];
}

function optNums(o, key, dflt) { const v = o.get(key); return has(v) ? nums(v) : dflt; }

export function evalFunction(fn, inputs) {
  if (fn.isArray()) { const out = []; for (let i = 0; i < fn.length; i++) out.push(evalFunction(fn.get(i), inputs)[0]); return out; }
  const type = fn.get("FunctionType").asNumber();
  const dom = optNums(fn, "Domain", null);
  const x = dom ? inputs.map((v, i) => Math.min(Math.max(v, dom[2 * i]), dom[2 * i + 1])) : inputs.slice();
  let out;
  if (type === 2) {
    const c0 = optNums(fn, "C0", [0]), c1 = optNums(fn, "C1", [1]);
    const n = has(fn.get("N")) ? fn.get("N").asNumber() : 1;
    out = c0.map((a, i) => a + x[0] ** n * (c1[i] - a));
  } else if (type === 0) out = sampled(fn, x, dom);
  else if (type === 3) out = stitching(fn, x[0], dom);
  else if (type === 4) {
    const st = x.slice();
    psExec(psParse(new TextDecoder("latin1").decode(fn.readStream().asUint8Array())), st);
    out = st.map(Number);
  } else throw new Error("FunctionType " + type);
  const rng = optNums(fn, "Range", null);
  if (rng) out = out.slice(0, rng.length / 2).map((v, i) => Math.min(Math.max(v, rng[2 * i]), rng[2 * i + 1]));
  return out;
}

function sampled(fn, x, dom) {
  const size = nums(fn.get("Size")), bps = fn.get("BitsPerSample").asNumber(), rng = nums(fn.get("Range"));
  const m = rng.length / 2;
  const enc = optNums(fn, "Encode", size.flatMap((s) => [0, s - 1]));
  const dec = optNums(fn, "Decode", rng);
  const data = fn.readStream().asUint8Array();
  let off = 0, stride = 1;
  x.forEach((xi, i) => {
    const d0 = dom[2 * i], d1 = dom[2 * i + 1];
    const e = enc[2 * i] + ((xi - d0) * (enc[2 * i + 1] - enc[2 * i])) / (d1 - d0 || 1);
    off += Math.round(Math.min(Math.max(e, 0), size[i] - 1)) * stride;
    stride *= size[i];
  });
  const max = 2 ** bps - 1, out = [];
  for (let j = 0; j < m; j++) {
    const bit = (off * m + j) * bps;
    let s = 0;
    for (let b = 0; b < bps; b++) s = s * 2 + ((data[(bit + b) >> 3] >> (7 - ((bit + b) & 7))) & 1);
    out.push(dec[2 * j] + (s * (dec[2 * j + 1] - dec[2 * j])) / max);
  }
  return out;
}

function stitching(fn, x, dom) {
  const funcs = fn.get("Functions"), bounds = optNums(fn, "Bounds", []), enc = nums(fn.get("Encode"));
  const edges = [dom[0], ...bounds, dom[1]];
  let k = bounds.findIndex((b) => x < b);
  if (k < 0) k = bounds.length;
  const lo = edges[k], hi = edges[k + 1];
  return evalFunction(funcs.get(k), [enc[2 * k] + ((x - lo) * (enc[2 * k + 1] - enc[2 * k])) / (hi - lo || 1)]);
}

// Minimal PostScript calculator (Type 4 functions)
function psParse(src) {
  const t = src.match(/[{}]|[^\s{}]+/g) || [];
  let i = 0;
  const parse = () => { const out = []; while (i < t.length) { const s = t[i++]; if (s === "{") out.push(parse()); else if (s === "}") return out; else out.push(s); } return out; };
  const prog = parse();
  return prog.length === 1 && Array.isArray(prog[0]) ? prog[0] : prog;
}
const isB = (v) => typeof v === "boolean";
const BIN = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b,
  idiv: (a, b) => Math.trunc(a / b), mod: (a, b) => a % b, exp: (a, b) => a ** b,
  atan: (a, b) => ((Math.atan2(a, b) * 180) / Math.PI + 360) % 360,
  eq: (a, b) => a === b, ne: (a, b) => a !== b, gt: (a, b) => a > b, ge: (a, b) => a >= b, lt: (a, b) => a < b, le: (a, b) => a <= b,
  and: (a, b) => (isB(a) ? a && b : a & b), or: (a, b) => (isB(a) ? a || b : a | b), xor: (a, b) => (isB(a) ? a !== b : a ^ b),
  bitshift: (a, b) => (b >= 0 ? a << b : a >> -b),
};
const UN = {
  neg: (a) => -a, abs: Math.abs, ceiling: Math.ceil, floor: Math.floor, round: (a) => Math.floor(a + 0.5),
  truncate: Math.trunc, sqrt: Math.sqrt, ln: Math.log, log: Math.log10,
  sin: (a) => Math.sin((a * Math.PI) / 180), cos: (a) => Math.cos((a * Math.PI) / 180),
  cvi: Math.trunc, cvr: (a) => a, not: (a) => (isB(a) ? !a : ~a),
};
function psExec(proc, st) {
  for (const t of proc) {
    if (Array.isArray(t)) st.push(t);
    else if (t in BIN) { const b = st.pop(), a = st.pop(); st.push(BIN[t](a, b)); }
    else if (t in UN) st.push(UN[t](st.pop()));
    else if (t === "true") st.push(true);
    else if (t === "false") st.push(false);
    else if (t === "dup") st.push(st[st.length - 1]);
    else if (t === "exch") { const n = st.length; [st[n - 1], st[n - 2]] = [st[n - 2], st[n - 1]]; }
    else if (t === "pop") st.pop();
    else if (t === "copy") { const n = st.pop(); if (n > 0) st.push(...st.slice(-n)); }
    else if (t === "index") { const n = st.pop(); st.push(st[st.length - 1 - n]); }
    else if (t === "roll") {
      let j = st.pop(); const n = st.pop();
      if (n) { j = ((j % n) + n) % n; const seg = st.splice(st.length - n, n); st.push(...seg.slice(n - j), ...seg.slice(0, n - j)); }
    }
    else if (t === "if") { const p = st.pop(), c = st.pop(); if (c) psExec(p, st); }
    else if (t === "ifelse") { const p2 = st.pop(), p1 = st.pop(), c = st.pop(); psExec(c ? p1 : p2, st); }
    else { const n = Number(t); if (Number.isNaN(n)) throw new Error("PS op " + t); st.push(n); }
  }
}

// ------------------------------------------------------------------ compare
// Walks both object trees from /Root and /Info in parallel. Object numbers may
// differ, so structure and content are compared, not byte positions.
function kind(o) {
  if (o.isNull()) return "null";
  if (o.isStream()) return "stream";
  if (o.isDictionary()) return "dict";
  if (o.isArray()) return "array";
  if (o.isName()) return "name";
  if (o.isString()) return "string";
  if (o.isBoolean()) return "bool";
  if (o.isNumber()) return "number";
  return "other";
}
function streamBytes(s) {
  try { return [s.readStream().asUint8Array(), true]; } catch { return [s.readRawStream().asUint8Array(), false]; }
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function compareDocs(a, b, maxDiffs = 200) {
  const diffs = [], seen = new Set();
  const walk = (x0, y0, p0) => {
    const stack = [[x0, y0, p0]];
    while (stack.length && diffs.length < maxDiffs) {
      const [x, y, path] = stack.pop();
      const kx = kind(x), ky = kind(y);
      if (kx !== ky) { diffs.push(`${path}: type ${kx} → ${ky}`); continue; }
      if ((kx === "dict" || kx === "array" || kx === "stream") && x.isIndirect() && y.isIndirect()) {
        const key = x.asIndirect() + ":" + y.asIndirect();
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (kx === "stream" || kx === "dict") {
        let ignore = new Set();
        if (kx === "stream") {
          const [dx, okx] = streamBytes(x), [dy, oky] = streamBytes(y);
          if (!sameBytes(dx, dy)) diffs.push(`${path}: stream data differs`);
          ignore = new Set(okx && oky ? ["Length", "Filter", "DecodeParms"] : ["Length"]);
        }
        const kxs = new Set(keysOf(x).filter((k) => !ignore.has(k)));
        const kys = new Set(keysOf(y).filter((k) => !ignore.has(k)));
        [...kxs].filter((k) => !kys.has(k)).sort().forEach((k) => diffs.push(`${path}/${k}: missing after save`));
        [...kys].filter((k) => !kxs.has(k)).sort().forEach((k) => diffs.push(`${path}/${k}: added after save`));
        [...kxs].filter((k) => kys.has(k)).sort().reverse().forEach((k) => stack.push([x.get(k), y.get(k), `${path}/${k}`]));
      } else if (kx === "array") {
        if (x.length !== y.length) { diffs.push(`${path}: array length ${x.length} → ${y.length}`); continue; }
        for (let i = x.length - 1; i >= 0; i--) stack.push([x.get(i), y.get(i), `${path}[${i}]`]);
      } else if (kx === "number") {
        if (Math.abs(x.asNumber() - y.asNumber()) > 1e-9) diffs.push(`${path}: ${+x.asNumber().toFixed(4)} → ${+y.asNumber().toFixed(4)}`);
      } else if (kx === "name") {
        if (x.asName() !== y.asName()) diffs.push(`${path}: /${x.asName()} → /${y.asName()}`);
      } else if (kx === "string") {
        if (!sameBytes(x.asByteString(), y.asByteString())) diffs.push(`${path}: string changed`);
      } else if (kx === "bool") {
        if (x.asBoolean() !== y.asBoolean()) diffs.push(`${path}: ${x.asBoolean()} → ${y.asBoolean()}`);
      }
    }
  };
  const ta = a.getTrailer(), tb = b.getTrailer();
  walk(ta.get("Root"), tb.get("Root"), "/Root");
  const ia = ta.get("Info"), ib = tb.get("Info");
  if (has(ia) !== has(ib)) diffs.push("/Info: presence differs");
  else if (has(ia)) walk(ia, ib, "/Info");
  const ida = ta.get("ID"), idb = tb.get("ID");
  if (has(ida) && has(idb) && !sameBytes(ida.get(0).asByteString(), idb.get(0).asByteString())) diffs.push("/ID[0]: permanent file identifier changed");
  if (a.getVersion() !== b.getVersion()) diffs.push(`PDF version ${a.getVersion() / 10} → ${b.getVersion() / 10}`);
  return diffs;
}
