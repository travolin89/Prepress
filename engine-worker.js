// Engine worker: MuPDF (WebAssembly). All edits are kept in a log and can be
// replayed onto the original bytes; saving is incremental, so the original
// bytes stay untouched and edits are appended after them.
import * as mupdf from "./mupdf.js";
import * as core from "./pdfcore.js";
import { parseOps, findObjects, editContent, appendForm, IDENT } from "./content.js";
import { buildBarcode, TYPES } from "./barcode.js";
import { runPreflight } from "./preflight.js";

let doc = null;
let baseline = null; // bytes exactly as first opened
let current = null;  // bytes of the latest saved state
let log = [];        // edits since the last save

const has = (o) => o && !o.isNull();
const nums = (a) => { const r = []; for (let i = 0; i < a.length; i++) r.push(a.get(i).asNumber()); return r; };
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const PROCESS = { Cyan: 0, Magenta: 1, Yellow: 2, Black: 3 };

// byte-exact text <-> bytes (content streams are binary-safe "latin1")
function bytesToStr(u8) { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; }
function strToBytes(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }

// ------------------------------------------------------------------ page content helpers
const pageObj = (d, i) => d.loadPage(i).getObject();
function readContent(pg) {
  const c = pg.get("Contents");
  const parts = [];
  if (has(c) && c.isArray()) for (let k = 0; k < c.length; k++) parts.push(bytesToStr(c.get(k).readStream().asUint8Array()));
  else if (has(c)) parts.push(bytesToStr(c.readStream().asUint8Array()));
  return parts.join("\n");
}
function writeContent(d, pg, s) { pg.put("Contents", d.addStream(strToBytes(s), d.newDictionary())); }
function ensureRes(d, pg) {
  let res = pg.getInheritable("Resources");
  if (!has(res)) { pg.put("Resources", d.newDictionary()); res = pg.get("Resources"); }
  return res;
}
function subDict(d, res, key) {
  if (!has(res.get(key))) res.put(key, d.newDictionary());
  return res.get(key);
}
function uniqueKey(dict, prefix) { let n = 1; while (has(dict.get(prefix + n))) n++; return prefix + n; }

function fontInfo(fd) {
  if (!has(fd)) return null;
  const sub = has(fd.get("Subtype")) ? fd.get("Subtype").asName() : "";
  if (sub === "Type0") {
    const df = fd.get("DescendantFonts", 0);
    const dw = has(df.get("DW")) ? df.get("DW").asNumber() : 1000;
    const map = new Map();
    const W = df.get("W");
    if (has(W)) {
      for (let k = 0; k < W.length; ) {
        const first = W.get(k).asNumber(), nxt = W.get(k + 1);
        if (nxt.isArray()) { for (let j = 0; j < nxt.length; j++) map.set(first + j, nxt.get(j).asNumber()); k += 2; }
        else { const last = nxt.asNumber(), w = W.get(k + 2).asNumber(); for (let c = first; c <= last && c - first < 70000; c++) map.set(c, w); k += 3; }
      }
    }
    return { twoByte: true, width: (c) => map.get(c) ?? dw };
  }
  const first = has(fd.get("FirstChar")) ? fd.get("FirstChar").asNumber() : 0;
  const widths = has(fd.get("Widths")) ? nums(fd.get("Widths")) : null;
  const missing = has(fd.get("FontDescriptor", "MissingWidth")) ? fd.get("FontDescriptor", "MissingWidth").asNumber() : 0;
  const k = sub === "Type3" && has(fd.get("FontMatrix")) ? fd.get("FontMatrix").get(0).asNumber() * 1000 : 1;
  return { twoByte: false, width: (c) => (widths ? (widths[c - first] ?? missing) * k : 500) || 500 };
}

function contextFor(pg) {
  const res = pg.getInheritable("Resources");
  const cache = new Map();
  const get = (key, name) => (has(res) ? res.get(key, name) : null);
  return {
    font(name) {
      if (!cache.has("F" + name)) cache.set("F" + name, fontInfo(get("Font", name)));
      return cache.get("F" + name);
    },
    xobject(name) {
      const x = get("XObject", name);
      if (!has(x)) return null;
      const kind = has(x.get("Subtype")) ? x.get("Subtype").asName() : "Image";
      const bc = x.get("PPBarcode");
      return {
        kind,
        bbox: has(x.get("BBox")) ? nums(x.get("BBox")) : [0, 0, 1, 1],
        matrix: has(x.get("Matrix")) ? nums(x.get("Matrix")) : IDENT,
        barcode: has(bc) ? `${bc.get("Type").asString()} ${bc.get("Data").asString()}` : null,
      };
    },
    colour(name) {
      const cs = get("ColorSpace", name);
      if (!has(cs)) return name;
      if (cs.isArray()) {
        const fam = cs.get(0).asName();
        if (fam === "Separation") return cs.get(1).asName();
        if (fam === "DeviceN") { const n = []; for (let k = 0; k < cs.get(1).length; k++) n.push(cs.get(1).get(k).asName()); return n.join("+"); }
        if (fam === "ICCBased") return `ICC (${cs.get(1).get("N").asNumber()} ch)`;
        return fam;
      }
      return cs.isName() ? cs.asName() : name;
    },
  };
}

function pageObjects(d, i) {
  const pg = pageObj(d, i);
  const s = readContent(pg);
  const ops = parseOps(s);
  return { pg, s, ops, objs: findObjects(ops, contextFor(pg)) };
}

// ------------------------------------------------------------------ inks
function deepCopy(d, o) {
  if (o.isIndirect()) return o;
  if (o.isArray()) { const a = d.newArray(); for (let k = 0; k < o.length; k++) a.push(deepCopy(d, o.get(k))); return a; }
  if (o.isDictionary()) { const n = d.newDictionary(); o.forEach((v, k) => n.put(k, deepCopy(d, v))); return n; }
  if (o.isName()) return d.newName(o.asName());
  if (o.isString()) return d.newByteString(o.asByteString());
  if (o.isBoolean()) return d.newBoolean(o.asBoolean());
  if (o.isInteger()) return d.newInteger(o.asNumber());
  if (o.isNumber()) return d.newReal(o.asNumber());
  return d.newNull();
}

function findSpotCS(d, name) {
  for (let i = 0; i < d.countPages(); i++) {
    let hit = null;
    const seen = new Set();
    const walk = (res) => {
      if (hit || !has(res) || !res.isDictionary()) return;
      if (res.isIndirect()) { if (seen.has(res.asIndirect())) return; seen.add(res.asIndirect()); }
      const cs = res.get("ColorSpace");
      if (has(cs)) cs.forEach((v) => {
        if (hit || !v.isArray() || v.length < 4) return;
        const fam = v.get(0).asName();
        if (fam === "Separation" && v.get(1).asName() === name) hit = deepCopy(d, v);
        else if (fam === "DeviceN") {
          const names = v.get(1);
          const sub = v.length > 4 ? v.get(4).get("Colorants", name) : null;
          if (sub && has(sub)) hit = deepCopy(d, sub);
          else if (names.length === 1 && names.get(0).asName() === name) {
            // a one-ink DeviceN is equivalent to a Separation with the same tint transform
            const a = d.newArray();
            a.push(d.newName("Separation")); a.push(d.newName(name)); a.push(deepCopy(d, v.get(2))); a.push(deepCopy(d, v.get(3)));
            hit = a;
          }
        }
      });
      const xo = res.get("XObject");
      if (has(xo)) xo.forEach((x) => walk(x.get("Resources")));
    };
    walk(pageObj(d, i).getInheritable("Resources"));
    if (hit) return hit.isIndirect() ? hit : d.addObject(hit);
  }
  return null;
}

// ink: {name, cmyk?} ; returns a Separation colour space object
function spotSpace(d, ink) {
  const found = findSpotCS(d, ink.name);
  if (found) return found;
  if (!ink.cmyk) throw new Error(`Spot ink "${ink.name}" is not in this file`);
  const fn = d.newDictionary();
  fn.put("FunctionType", 2); fn.put("Domain", [0, 1]); fn.put("C0", [0, 0, 0, 0]); fn.put("C1", ink.cmyk.map((v) => v / 100)); fn.put("N", 1);
  const arr = d.newArray();
  arr.push(d.newName("Separation")); arr.push(d.newName(ink.name)); arr.push(d.newName("DeviceCMYK")); arr.push(fn);
  return d.addObject(arr);
}

function colourOps(d, pg, ink, tint) {
  const t = +(tint / 100).toFixed(4);
  if (ink.name in PROCESS) {
    const v = [0, 0, 0, 0];
    v[PROCESS[ink.name]] = t;
    return `${v.join(" ")} k ${v.join(" ")} K`;
  }
  const csd = subDict(d, ensureRes(d, pg), "ColorSpace");
  let key = null;
  csd.forEach((v, k) => { if (!key && k.startsWith("PPCS") && v.isArray() && v.get(1).asName() === ink.name) key = k; });
  if (!key) { key = uniqueKey(csd, "PPCS"); csd.put(key, spotSpace(d, ink)); }
  return `/${key} cs ${t} scn /${key} CS ${t} SCN`;
}

// ------------------------------------------------------------------ edits (replayable)
function applyOp(d, op) {
  if (op.kind === "box") return core.setPageBox(d, op.i, op.name, op.rect);
  if (op.kind === "edit") {
    const { pg, s, ops, objs } = pageObjects(d, op.i);
    const colour = op.action === "recolour" ? colourOps(d, pg, op.ink, op.tint) : null;
    return writeContent(d, pg, editContent(s, ops, objs, { ...op, colour }));
  }
  if (op.kind === "barcode") {
    const g = buildBarcode(op.spec);
    const pg = pageObj(d, op.i);
    const formRes = d.newDictionary();
    let colour;
    const t = +(op.tint / 100).toFixed(4);
    if (op.ink.name in PROCESS) { const v = [0, 0, 0, 0]; v[PROCESS[op.ink.name]] = t; colour = `${v.join(" ")} k`; }
    else { const csd = d.newDictionary(); csd.put("CS0", spotSpace(d, op.ink)); formRes.put("ColorSpace", csd); colour = `/CS0 cs ${t} scn`; }
    const dict = d.newDictionary();
    dict.put("Type", d.newName("XObject")); dict.put("Subtype", d.newName("Form"));
    dict.put("BBox", [0, 0, +g.w.toFixed(3), +g.h.toFixed(3)]); dict.put("Resources", formRes);
    const meta = d.newDictionary();
    meta.put("Type", d.newString(TYPES[op.spec.type].label)); meta.put("Data", d.newString(op.spec.data));
    meta.put("ModuleMM", op.spec.moduleMM); meta.put("BWRMM", op.spec.bwrMM || 0); meta.put("Ink", d.newString(op.ink.name));
    dict.put("PPBarcode", meta);
    const form = d.addStream(strToBytes(`q\n${colour}\n${g.ops}Q\n`), dict);
    const xo = subDict(d, ensureRes(d, pg), "XObject");
    const name = uniqueKey(xo, "PPBC");
    xo.put(name, form);
    const b = core.pageBoxes(d, op.i), origin = b.TrimBox || b.MediaBox;
    return writeContent(d, pg, appendForm(readContent(pg), name, origin[0] + op.xMM / core.PT_TO_MM, origin[1] + op.yMM / core.PT_TO_MM));
  }
  throw new Error("Unknown edit");
}

function fresh() {
  const d = new mupdf.PDFDocument(current);
  for (const op of log) applyOp(d, op);
  return d;
}

function doEdit(op) {
  if (op.kind === "barcode") buildBarcode(op.spec); // validate data before touching the document
  try { applyOp(doc, op); }
  catch (err) { doc.destroy(); doc = fresh(); throw err; } // roll back any partial change
  log.push(op);
}

const objList = (i) => pageObjects(doc, i).objs.map((o, k) => ({ k, type: o.type, bbox: o.bbox, desc: o.desc, locked: !!o.locked }));

function docInks() {
  const names = new Set();
  for (let i = 0; i < doc.countPages(); i++) Object.keys(core.scanPageInks(doc, i)).forEach((n) => names.add(n));
  return [...names];
}

// ------------------------------------------------------------------ API
const api = {
  open({ bytes }) {
    baseline = current = new Uint8Array(bytes);
    log = [];
    doc = new mupdf.PDFDocument(current);
    return { pages: doc.countPages(), report: core.documentReport(doc), incremental: doc.canBeSavedIncrementally(), inks: docInks() };
  },
  page({ i }) { return { boxes: core.pageBoxes(doc, i), rotation: core.pageRotation(doc, i), spots: core.scanPageInks(doc, i) }; },
  render({ i, dpi }) {
    const page = doc.loadPage(i);
    const s = dpi / 72;
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true, "View", "MediaBox");
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), src = pix.getPixels();
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) for (let x = 0, p = y * stride; x < w; x++, p += 3) { rgba[q++] = src[p]; rgba[q++] = src[p + 1]; rgba[q++] = src[p + 2]; rgba[q++] = 255; }
    pix.destroy();
    return { result: { w, h, rgba }, transfer: [rgba.buffer] };
  },
  objects({ i }) { return objList(i); },
  setBox({ i, name, rect }) { doEdit({ kind: "box", i, name, rect }); return { boxes: core.pageBoxes(doc, i), report: core.documentReport(doc), edits: log.length }; },
  edit({ i, action, obj, dx, dy, ink, tint }) { doEdit({ kind: "edit", i, action, obj, dx, dy, ink, tint }); return { objects: objList(i), edits: log.length, inks: docInks() }; },
  barcode({ i, spec, ink, tint, xMM, yMM }) { doEdit({ kind: "barcode", i, spec, ink, tint, xMM, yMM }); return { objects: objList(i), edits: log.length, inks: docInks() }; },
  undo() {
    if (!log.length) return { edits: 0, page: null };
    const op = log.pop();
    doc.destroy();
    doc = fresh();
    return { edits: log.length, page: op.i, report: core.documentReport(doc), inks: docInks() };
  },
  inks() { return docInks(); },
  barcodeTypes() { return Object.entries(TYPES).map(([id, t]) => ({ id, ...t })); },
  preflight({ opts }) { return runPreflight(mupdf, doc, opts); },
  snapshot() {
    if (!log.length) { const c = current.slice(); return { result: c, transfer: [c.buffer] }; }
    const d = fresh();
    const out = d.saveToBuffer("incremental").asUint8Array().slice();
    d.destroy();
    return { result: out, transfer: [out.buffer] };
  },
  save() {
    if (!log.length) {
      const copy = current.slice();
      return { result: { bytes: copy, mode: "unchanged", prefixOK: true, diffs: [] }, transfer: [copy.buffer] };
    }
    const mode = doc.canBeSavedIncrementally() ? "incremental" : "full";
    const buf = doc.saveToBuffer(mode === "incremental" ? "incremental" : "");
    const out = buf.asUint8Array().slice();
    buf.destroy();
    const prefixOK = mode === "incremental" && out.length >= current.length && same(out.subarray(0, current.length), current);
    const a = new mupdf.PDFDocument(baseline), b = new mupdf.PDFDocument(out);
    const diffs = core.compareDocs(a, b);
    a.destroy(); b.destroy();
    current = out;
    log = [];
    doc.destroy();
    doc = new mupdf.PDFDocument(current);
    const copy = out.slice();
    return { result: { bytes: copy, mode, prefixOK, diffs }, transfer: [copy.buffer] };
  },
};

self.onmessage = (e) => {
  const { id, cmd, args } = e.data;
  try {
    let r = api[cmd](args || {});
    let transfer = [];
    if (r && r.transfer) { transfer = r.transfer; r = r.result; }
    self.postMessage({ id, result: r }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
self.postMessage({ ready: true });
