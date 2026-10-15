// Engine worker: MuPDF (WebAssembly). All edits are kept in a log and can be
// replayed onto the original bytes; saving is incremental, so the original
// bytes stay untouched and edits are appended after them.
import * as mupdf from "./mupdf.js";
import * as core from "./pdfcore.js";
import { parseOps, findObjects, editContent, appendBlock, IDENT, utf16hex, fromUtf16, propsToPdf, mul, pathGeometry } from "./content.js";
import { buildBarcode, TYPES } from "./barcode.js";
import { runPreflight } from "./preflight.js";

let doc = null;
let baseline = null; // bytes exactly as first opened
let current = null;  // bytes of the latest saved state
let log = [];        // edits since the last save
const viewState = new Map(); // layer id -> visible (view only, never saved)
const relinked = new Set();  // image objects added by relinking (compressed when saved)
const fontData = new Map();  // imported font id -> bytes
export const BUILTIN_FONTS = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"];

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
function writeContent(d, pg, s) {
  const c = pg.get("Contents");
  if (has(c) && c.isStream() && has(c.get("PPContent"))) { c.writeStream(strToBytes(s)); return; }
  const dict = d.newDictionary();
  dict.put("PPContent", true);
  pg.put("Contents", d.addStream(strToBytes(s), dict));
}
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

function contextFor(pg) { return contextForRes(pg.getInheritable("Resources")); }
function contextForRes(res) {
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
      const oc = x.get("OC");
      return {
        kind,
        bbox: has(x.get("BBox")) ? nums(x.get("BBox")) : [0, 0, 1, 1],
        matrix: has(x.get("Matrix")) ? nums(x.get("Matrix")) : IDENT,
        barcode: has(bc) ? `${bc.get("Type").asString()} ${bc.get("Data").asString()}` : null,
        oc: has(oc) && oc.isIndirect() ? oc.asIndirect() : null,
        meta: has(bc) ? barcodeMeta(bc) : null,
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
  return parsePage(pg, readContent(pg));
}
function parsePage(pg, s) {
  const ops = parseOps(s);
  return { pg, s, ops, objs: findObjects(ops, contextFor(pg)) };
}
const str = (o) => (has(o) ? (o.isString() ? o.asString() : o.isName() ? o.asName() : String(o.asNumber())) : null);
const numOr = (o, v) => (has(o) ? o.asNumber() : v);
function barcodeMeta(bc) {
  const label = str(bc.get("Type"));
  const bcid = str(bc.get("Bcid")) || Object.keys(TYPES).find((k) => TYPES[k].label === label);
  const t = TYPES[bcid] || {};
  const mod = numOr(bc.get("ModuleMM"), t.x);
  return { bcid, label, data: str(bc.get("Data")), mag: numOr(bc.get("Mag"), Math.round((mod / (t.x || mod)) * 100)),
    hpct: numOr(bc.get("HPct"), 100), bwr: numOr(bc.get("BWRMM"), 0), hri: numOr(bc.get("Hri"), 1) === 1,
    ink: str(bc.get("Ink")) || "Black", tint: numOr(bc.get("Tint"), 100) };
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
    const pg = pageObj(d, op.i);
    const name = barcodeForm(d, pg, op);
    const b = core.pageBoxes(d, op.i), origin = b.TrimBox || b.MediaBox;
    const x = origin[0] + op.xMM / core.PT_TO_MM, y = origin[1] + op.yMM / core.PT_TO_MM;
    const { s, ops } = parsePage(pg, readContent(pg));
    return writeContent(d, pg, appendBlock(s, ops, `q 1 0 0 1 ${x.toFixed(4)} ${y.toFixed(4)} cm /${name} Do Q`));
  }
  if (op.kind === "barcodeEdit") {
    const pg = pageObj(d, op.i);
    const name = barcodeForm(d, pg, op);
    const { s, ops, objs } = pageObjects(d, op.i);
    return writeContent(d, pg, editContent(s, ops, objs, { action: "swapForm", obj: op.obj, name }));
  }
  if (op.kind === "objs") return editObjects(d, op);
  if (op.kind === "newLayer") return newLayer(d, op.name);
  if (op.kind === "renameLayer") { const g = ocgById(d, op.id); if (!g) throw new Error("Layer not found"); g.put("Name", d.newString(op.name)); return; }
  if (op.kind === "lockLayer") return lockLayer(d, op.id, op.locked);
  if (op.kind === "addText" || op.kind === "replaceText") return textOp(d, op);
  if (op.kind === "traps") return writeTraps(d, op);
  if (op.kind === "removeTraps") return removeTraps(d, op.i);
  if (op.kind === "relink") return relinkImage(d, op);
  if (op.kind === "removeImage") return removeImage(d, op.objnum);
  if (op.kind === "screens") return applyScreens(d, op.settings);
  throw new Error("Unknown edit");
}

// ------------------------------------------------------------------ barcodes
function barcodeForm(d, pg, op) {
  const g = buildBarcode(op.spec);
  const formRes = d.newDictionary();
  let colour;
  const t = +(op.tint / 100).toFixed(4);
  if (op.ink.name in PROCESS) { const v = [0, 0, 0, 0]; v[PROCESS[op.ink.name]] = t; colour = `${v.join(" ")} k`; }
  else { const csd = d.newDictionary(); csd.put("CS0", spotSpace(d, op.ink)); formRes.put("ColorSpace", csd); colour = `/CS0 cs ${t} scn`; }
  const dict = d.newDictionary();
  dict.put("Type", d.newName("XObject")); dict.put("Subtype", d.newName("Form"));
  dict.put("BBox", [0, 0, +g.w.toFixed(3), +g.h.toFixed(3)]); dict.put("Resources", formRes);
  const meta = d.newDictionary();
  meta.put("Type", d.newString(TYPES[op.spec.type].label)); meta.put("Bcid", d.newString(op.spec.type));
  meta.put("Data", d.newString(op.spec.data)); meta.put("ModuleMM", op.spec.moduleMM); meta.put("BWRMM", op.spec.bwrMM || 0);
  meta.put("Mag", op.mag ?? 100); meta.put("HPct", op.hpct ?? 100); meta.put("Hri", op.spec.hri ? 1 : 0);
  meta.put("Ink", d.newString(op.ink.name)); meta.put("Tint", op.tint);
  dict.put("PPBarcode", meta);
  const form = d.addStream(strToBytes(`q\n${colour}\n${g.ops}Q\n`), dict);
  const xo = subDict(d, ensureRes(d, pg), "XObject");
  const name = uniqueKey(xo, "PPBC");
  xo.put(name, form);
  return name;
}

// ------------------------------------------------------------------ multi-object edits
function editObjects(d, op) {
  const pg = pageObj(d, op.i);
  let cur = parsePage(pg, readContent(pg));
  let res = null;
  if (op.action === "layer" && op.layerId) res = resForOcg(d, pg, op.layerId);
  let colour = null;
  if (op.action === "recolour") colour = colourOps(d, pg, op.ink, op.tint);
  let props = null;
  if (op.action === "group") props = { G: Math.max(0, ...cur.objs.map((o) => (o.wrap && o.wrap.props.G) || 0)) + 1 };
  if (op.action === "ungroup") props = { G: null };
  if (op.action === "lock") props = { L: 1 };
  if (op.action === "unlock") props = { L: null };
  const ks = op.action === "unlockAll" ? cur.objs.map((o, k) => (o.wrap && o.wrap.props.L ? k : -1)).filter((k) => k >= 0) : [...op.objs];
  if (op.action === "unlockAll") props = { L: null };
  for (const k of ks.sort((a, b) => b - a)) {
    const o = cur.objs[k];
    if (!o) throw new Error("Object not found");
    let e;
    if (props) e = { action: "props", props };
    else if (op.action === "layer") e = { action: "layer", res };
    else if (op.action === "recolour") e = { action: "recolour", colour, skip: o.type !== "path" && o.type !== "text" };
    else e = { action: op.action, dx: op.dx, dy: op.dy };
    if (e.skip) continue;
    cur = parsePage(pg, editContent(cur.s, cur.ops, cur.objs, { ...e, obj: k }));
  }
  writeContent(d, pg, cur.s);
}

// ------------------------------------------------------------------ layers
function ocProps(d) { const o = d.getTrailer().get("Root").get("OCProperties"); return has(o) ? o : null; }
function ocgById(d, id) {
  const o = ocProps(d);
  if (!o) return null;
  const a = o.get("OCGs");
  for (let k = 0; k < a.length; k++) if (a.get(k).isIndirect() && a.get(k).asIndirect() === id) return a.get(k);
  return null;
}
const refSet = (a) => { const s = new Set(); if (has(a) && a.isArray()) for (let k = 0; k < a.length; k++) if (a.get(k).isIndirect()) s.add(a.get(k).asIndirect()); return s; };
function listLayers(d) {
  const o = ocProps(d);
  if (!o) return [];
  const a = o.get("OCGs"), D = o.get("D");
  const off = refSet(D.get("OFF")), on = refSet(D.get("ON")), locked = refSet(D.get("Locked"));
  const baseOff = has(D.get("BaseState")) && D.get("BaseState").asName() === "OFF";
  const out = [];
  for (let k = 0; k < a.length; k++) {
    const g = a.get(k);
    if (!g.isIndirect()) continue;
    const id = g.asIndirect();
    out.push({ id, name: str(g.get("Name")) || `Layer ${k + 1}`, defaultOn: baseOff ? on.has(id) : !off.has(id), locked: locked.has(id) });
  }
  return out;
}
function mupdfIndexMap(d, layers) {
  const names = [];
  for (let k = 0; k < d.countLayers(); k++) names.push(d.getLayerName(k));
  const used = new Set(), map = new Map();
  for (const l of layers) {
    const k = names.findIndex((n, idx) => n === l.name && !used.has(idx));
    if (k >= 0) { used.add(k); map.set(l.id, k); }
  }
  return map;
}
function applyView() {
  const map = mupdfIndexMap(doc, listLayers(doc));
  for (const [id, vis] of viewState) if (map.has(id)) doc.setLayerVisible(map.get(id), vis);
}
// back to each layer's default state, then the user's view choices on top
function restoreView() {
  const layers = listLayers(doc), map = mupdfIndexMap(doc, layers);
  for (const l of layers) if (map.has(l.id)) doc.setLayerVisible(map.get(l.id), l.defaultOn);
  applyView();
}
function layerInfo() {
  const layers = listLayers(doc), map = mupdfIndexMap(doc, layers);
  return layers.map((l) => ({ ...l, visible: map.has(l.id) ? doc.isLayerVisible(map.get(l.id)) : l.defaultOn }));
}
function newLayer(d, name) {
  const root = d.getTrailer().get("Root");
  if (!ocProps(d)) {
    const o = d.newDictionary(), D = d.newDictionary();
    o.put("OCGs", d.newArray());
    D.put("Order", d.newArray()); D.put("ON", d.newArray()); D.put("OFF", d.newArray());
    o.put("D", D);
    root.put("OCProperties", o);
  }
  const o = ocProps(d), D = o.get("D");
  const g = d.newDictionary();
  g.put("Type", d.newName("OCG")); g.put("Name", d.newString(name));
  const ref = d.addObject(g);
  o.get("OCGs").push(ref);
  if (has(D.get("Order"))) D.get("Order").push(ref);
  if (has(D.get("ON"))) D.get("ON").push(ref);
}
function lockLayer(d, id, locked) {
  const D = ocProps(d).get("D"), g = ocgById(d, id);
  const cur = D.get("Locked");
  const arr = d.newArray();
  if (has(cur)) for (let k = 0; k < cur.length; k++) if (!(cur.get(k).isIndirect() && cur.get(k).asIndirect() === id)) arr.push(cur.get(k));
  if (locked) arr.push(g);
  D.put("Locked", arr);
}
function ocgsForRes(pg, res) {
  const p = pg.getInheritable("Resources");
  const v = has(p) ? p.get("Properties", res) : null;
  if (!has(v)) return [];
  if (has(v.get("OCGs"))) { const o = v.get("OCGs"); return o.isArray() ? [...refSet(o)] : o.isIndirect() ? [o.asIndirect()] : []; }
  return v.isIndirect() ? [v.asIndirect()] : [];
}
function resForOcg(d, pg, id) {
  const props = subDict(d, ensureRes(d, pg), "Properties");
  let key = null;
  props.forEach((v, k) => { if (!key && v.isIndirect() && v.asIndirect() === id) key = k; });
  if (key) return key;
  const g = ocgById(d, id);
  if (!g) throw new Error("Layer not found");
  key = uniqueKey(props, "PPL");
  props.put(key, g);
  return key;
}

// ------------------------------------------------------------------ text
// full font name from a TrueType/OpenType 'name' table (ID 4, else family + style)
function fontFileName(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12); // 'ttcf': first font in a collection
  const n = dv.getUint16(base + 4);
  for (let t = 0; t < n; t++) {
    const rec = base + 12 + t * 16;
    if (String.fromCharCode(b[rec], b[rec + 1], b[rec + 2], b[rec + 3]) !== "name") continue;
    const off = dv.getUint32(rec + 8), count = dv.getUint16(off + 2), strings = off + dv.getUint16(off + 4);
    const found = {};
    for (let r = 0; r < count; r++) {
      const p = off + 6 + r * 12, plat = dv.getUint16(p), nid = dv.getUint16(p + 6), len = dv.getUint16(p + 8), so = strings + dv.getUint16(p + 10);
      let v = "";
      if (plat === 3 || plat === 0) for (let k = 0; k + 1 < len; k += 2) v += String.fromCharCode(dv.getUint16(so + k));
      else if (plat === 1) for (let k = 0; k < len; k++) v += String.fromCharCode(b[so + k]);
      if (v && (found[nid] === undefined || plat === 3)) found[nid] = v;
    }
    const nm = found[4] || [found[1], found[2]].filter(Boolean).join(" ");
    if (nm) return nm.trim();
  }
  return "Imported font";
}

function makeFont(id) {
  if (id.startsWith("b:")) return new mupdf.Font(id.slice(2));
  const data = fontData.get(id);
  if (!data) throw new Error("Font not loaded: " + id.slice(2) + ". Import it again from Files.");
  return new mupdf.Font(id.slice(2), data);
}
function pdfFont(d, pg, id) {
  const fonts = subDict(d, ensureRes(d, pg), "Font");
  let key = null;
  fonts.forEach((v, k) => { if (!key && has(v.get("PPFontId")) && v.get("PPFontId").asString() === id) key = k; });
  if (key) return key;
  let ref = null; // reuse the same embedded font from another page if present
  for (let i = 0; i < d.countPages() && !ref; i++) {
    const f = pageObj(d, i).getInheritable("Resources");
    if (has(f) && has(f.get("Font"))) f.get("Font").forEach((v) => { if (!ref && v.isIndirect() && has(v.get("PPFontId")) && v.get("PPFontId").asString() === id) ref = v; });
  }
  if (!ref) { ref = d.addFont(makeFont(id)); ref.put("PPFontId", d.newString(id)); }
  key = uniqueKey(fonts, "PPF");
  fonts.put(key, ref);
  return key;
}
const fmt = (m) => m.map((v) => +v.toFixed(4)).join(" ");
// points along a path (page space) for text on a path or around a circle
function pathPoints(P) {
  if (P.mode === "circle") {
    const pts = [], n = 720, dir = P.bottom ? 1 : -1, a0 = ((P.angle ?? (P.bottom ? 270 : 90)) + 180) * Math.PI / 180;
    for (let k = 0; k <= n; k++) { const a = a0 + dir * 2 * Math.PI * k / n; pts.push([P.cx + P.r * Math.cos(a), P.cy + P.r * Math.sin(a)]); }
    return pts;
  }
  const pts = [];
  for (let k = 0; k + 1 < P.pts.length; k += 2) pts.push([P.pts[k], P.pts[k + 1]]);
  return pts;
}
function layoutOnPath(font, spec, line) {
  const P = spec.path;
  let pts = pathPoints(P);
  if (P.flip) pts = pts.reverse();
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) throw new Error("The path has no length");
  const at = (s) => { // point and unit tangent at arc length s (extends straight past the ends)
    let k = 1;
    if (s <= 0) k = 1; else if (s >= total) k = pts.length - 1; else while (k < pts.length - 1 && cum[k] < s) k++;
    const a = pts[k - 1], b = pts[k], len = cum[k] - cum[k - 1] || 1;
    const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, u = s - cum[k - 1];
    return [a[0] + tx * u, a[1] + ty * u, tx, ty];
  };
  const glyphs = [];
  let width = 0;
  for (const ch of line) {
    const gid = font.encodeCharacter(ch.codePointAt(0));
    const adv = font.advanceGlyph(gid) * spec.size + (P.tracking || 0);
    glyphs.push({ ch, gid, adv });
    width += adv;
  }
  const align = P.mode === "circle" ? "c" : spec.align;
  let s = align === "c" ? (total - width) / 2 + (P.offset || 0) : align === "r" ? total - width - (P.offset || 0) : P.offset || 0;
  return glyphs.map((g) => {
    const [x, y, tx, ty] = at(s + g.adv / 2);
    const nx = -ty, ny = tx, b = P.baseline || 0;
    const m = [tx, ty, -ty, tx, x - tx * g.adv / 2 + nx * b, y - ty * g.adv / 2 + ny * b];
    s += g.adv;
    return { ...g, m };
  });
}
function textBlock(d, pg, spec, M) {
  const font = makeFont(spec.font);
  const key = pdfFont(d, pg, spec.font);
  const colour = colourOps(d, pg, spec.ink, spec.tint);
  const missing = new Set();
  let out = `BT\n/${key} ${+spec.size.toFixed(3)} Tf\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n${colour}\n`;
  if (spec.path) {
    // text on a path: one glyph at a time, each placed and rotated along the path
    for (const g of layoutOnPath(font, spec, spec.text.replace(/\r?\n/g, " "))) {
      if (!g.gid && g.ch.trim()) missing.add(g.ch);
      out += `${fmt(g.m)} Tm\n<${g.gid.toString(16).padStart(4, "0")}> Tj\n`;
    }
    if (missing.size) throw new Error(`The font ${font.getName()} has no glyphs for: ${[...missing].join(" ")}`);
    return out + "ET";
  }
  spec.text.split(/\r?\n/).forEach((line, n) => {
    let w = 0, hex = "";
    for (const ch of line) {
      const gid = font.encodeCharacter(ch.codePointAt(0));
      if (!gid && ch.trim()) missing.add(ch);
      w += font.advanceGlyph(gid) * spec.size;
      hex += gid.toString(16).padStart(4, "0");
    }
    const ox = spec.align === "c" ? -w / 2 : spec.align === "r" ? -w : 0;
    out += `${fmt(mul([1, 0, 0, 1, ox, -n * spec.lead], M))} Tm\n<${hex}> Tj\n`;
  });
  if (missing.size) throw new Error(`The font ${font.getName()} has no glyphs for: ${[...missing].join(" ")}`);
  return out + "ET";
}
function textProps(spec, M) {
  const p = { T: utf16hex(spec.text), F: spec.font, S: spec.size, Ld: spec.lead, A: spec.align, K: spec.ink.name, KC: spec.ink.cmyk ? spec.ink.cmyk.join(" ") : null, Tn: spec.tint, M: fmt(M) };
  if (spec.path) p.Path = JSON.stringify(spec.path); // path settings, kept for editing
  return p;
}
// "along the selected path": capture that path's geometry into the edit itself
function resolvePath(i, spec) {
  if (!spec.path || spec.path.fromObj === undefined) return spec;
  const { ops, objs } = pageObjects(doc, i);
  const o = objs[spec.path.fromObj];
  if (!o || o.type !== "path") throw new Error("Select a path (a line, curve or shape) to put the text on.");
  const subs = pathGeometry(ops, o).sort((a, b) => b.length - a.length);
  if (!subs.length) throw new Error("That path has no usable outline.");
  const { fromObj, ...rest } = spec.path;
  return { ...spec, path: { ...rest, mode: "path", pts: subs[0].flat().map((v) => +v.toFixed(3)) } };
}
function textOp(d, op) {
  const pg = pageObj(d, op.i);
  const cur = pageObjects(d, op.i);
  if (op.kind === "addText") {
    const b = core.pageBoxes(d, op.i), origin = b.TrimBox || b.MediaBox;
    const M = [1, 0, 0, 1, origin[0] + op.xMM / core.PT_TO_MM, origin[1] + op.yMM / core.PT_TO_MM];
    const block = `/PPObj ${propsToPdf(textProps(op.spec, M))} BDC\nq\n${textBlock(d, pg, op.spec, M)}\nQ\nEMC`;
    return writeContent(d, pg, appendBlock(cur.s, cur.ops, block));
  }
  const o = cur.objs[op.obj];
  if (!o || o.type !== "text") throw new Error("Select a text object");
  let M;
  if (o.wrap && o.wrap.props.M) M = String(o.wrap.props.M).split(" ").map(Number);
  else { const t = o.tm, sc = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1; M = [t[0] / sc, t[1] / sc, t[2] / sc, t[3] / sc, t[4], t[5]]; }
  const block = `q\n${textBlock(d, pg, op.spec, M)}\nQ`;
  writeContent(d, pg, editContent(cur.s, cur.ops, cur.objs, { action: "replaceText", obj: op.obj, block, props: textProps(op.spec, M) }));
}

// Subset only the fonts this app added (never the artwork's own fonts):
// collect every character our text uses, subset in a throwaway document,
// and copy the slim font program back into our font object.
function subsetOurFonts(d) {
  const ids = new Set(log.filter((op) => op.spec && op.spec.font).map((op) => op.spec.font));
  for (const id of ids) {
    let font;
    try { font = makeFont(id); } catch { continue; } // full font not available: keep as is
    const gids = new Set([0]);
    const refs = new Map();
    for (let i = 0; i < d.countPages(); i++) {
      const { pg, objs } = pageObjects(d, i);
      for (const o of objs) if (o.wrap && o.wrap.props.F === id && o.wrap.props.T) for (const ch of fromUtf16(o.wrap.props.T)) gids.add(font.encodeCharacter(ch.codePointAt(0)));
      const fd = pg.getInheritable("Resources").get("Font");
      if (has(fd)) fd.forEach((v) => { if (v.isIndirect() && has(v.get("PPFontId")) && v.get("PPFontId").asString() === id) refs.set(v.asIndirect(), v); });
    }
    if (!refs.size) continue;
    const tmp = new mupdf.PDFDocument();
    const tref = tmp.addFont(makeFont(id));
    const res = tmp.newDictionary(), fdict = tmp.newDictionary();
    fdict.put("F1", tref); res.put("Font", fdict);
    tmp.insertPage(-1, tmp.addPage([0, 0, 100, 100], 0, res, `BT /F1 10 Tf <${[...gids].map((g) => g.toString(16).padStart(4, "0")).join("")}> Tj ET`));
    tmp.subsetFonts();
    const tdesc = tref.get("DescendantFonts", 0, "FontDescriptor");
    const tagged = tref.get("BaseFont").asName();
    for (const ref of refs.values()) {
      const desc = ref.get("DescendantFonts", 0, "FontDescriptor");
      const key = ["FontFile2", "FontFile3", "FontFile"].find((k) => has(desc.get(k)));
      if (!key || !has(tdesc.get(key))) continue;
      desc.get(key).writeStream(tdesc.get(key).readStream().asUint8Array().slice());
      ref.put("BaseFont", d.newName(tagged));
      ref.get("DescendantFonts", 0).put("BaseFont", d.newName(tagged));
      desc.put("FontName", d.newName(tagged));
    }
    tmp.destroy();
  }
}

// ------------------------------------------------------------------ trapping
function removeTraps(d, i) {
  const pg = pageObj(d, i);
  let cur = parsePage(pg, readContent(pg));
  const ks = cur.objs.map((o, k) => (o.wrap && o.wrap.props.Trap ? k : -1)).filter((k) => k >= 0);
  if (!ks.length) return;
  for (const k of ks.sort((a, b) => b - a)) cur = parsePage(pg, editContent(cur.s, cur.ops, cur.objs, { action: "delete", obj: k }));
  writeContent(d, pg, cur.s.replace(/\/OC \/PPL\d+ BDC\s*EMC\s*/g, ""));
}
function writeTraps(d, op) {
  removeTraps(d, op.i);
  const keys = Object.keys(op.groups);
  if (!keys.length) return;
  let layer = listLayers(d).find((l) => l.name === op.layerName);
  if (!layer) { newLayer(d, op.layerName); layer = listLayers(d).find((l) => l.name === op.layerName); }
  const pg = pageObj(d, op.i);
  const res = resForOcg(d, pg, layer.id);
  const gsd = subDict(d, ensureRes(d, pg), "ExtGState");
  if (!has(gsd.get("PPTrapGS"))) {
    const g = d.newDictionary();
    g.put("Type", d.newName("ExtGState")); g.put("OP", true); g.put("op", true); g.put("OPM", 1);
    gsd.put("PPTrapGS", g);
  }
  let block = `/OC /${res} BDC\n`;
  for (const key of keys.sort()) {
    const bar = key.lastIndexOf("|"), ink = key.slice(0, bar), v = +key.slice(bar + 1);
    const t = +(v / 255).toFixed(4);
    let colour;
    if (ink in PROCESS) { const c = [0, 0, 0, 0]; c[PROCESS[ink]] = t; colour = `${c.join(" ")} k`; }
    else colour = colourOps(d, pg, { name: ink }, t * 100).split(" /")[0];
    const paths = op.groups[key].map((L) => {
      let s = `${L[0]} ${L[1]} m`;
      for (let j = 2; j < L.length; j += 2) s += ` ${L[j]} ${L[j + 1]} l`;
      return s + " h";
    }).join("\n");
    block += `/PPObj ${propsToPdf({ Trap: 1, Ink: ink, V: v })} BDC\nq /PPTrapGS gs ${colour}\n${paths}\nf*\nQ\nEMC\n`;
  }
  block += "EMC";
  const cur = parsePage(pg, readContent(pg));
  writeContent(d, pg, appendBlock(cur.s, cur.ops, block));
}
// A throwaway copy of the document with extra pages that show only part of
// page i (same content, smaller media box), for tiled high-resolution renders.
function tileDoc(i, rects, opts = {}) {
  const d = fresh();
  if (opts.view) hideLayersIn(d);
  if (opts.withoutTraps) removeTraps(d, i);
  if (opts.screens) applyScreens(d, opts.screens);
  const src = pageObj(d, i);
  const first = d.countPages();
  const contents = deepCopy(d, src.get("Contents")), res = deepCopy(d, src.getInheritable("Resources"));
  const group = src.get("Group");
  const made = [];
  for (const r of rects) {
    const pd = d.newDictionary();
    pd.put("Type", d.newName("Page")); pd.put("MediaBox", r.map((v) => +v.toFixed(4)));
    pd.put("Contents", contents); pd.put("Resources", res);
    if (has(group)) pd.put("Group", deepCopy(d, group));
    made.push(pd);
  }
  if (opts.atStart) made.reverse().forEach((pd) => d.insertPage(0, d.addObject(pd)));
  else made.forEach((pd) => d.insertPage(-1, d.addObject(pd)));
  return { d, first: opts.atStart ? 0 : first };
}

// ------------------------------------------------------------------ images (links)
function forEachResDict(d, fn) {
  const seen = new Set();
  const walk = (res) => {
    if (!has(res) || !res.isDictionary()) return;
    if (res.isIndirect()) { if (seen.has(res.asIndirect())) return; seen.add(res.asIndirect()); }
    fn(res);
    const xo = res.get("XObject");
    if (has(xo)) xo.forEach((x) => { if (has(x.get("Resources"))) walk(x.get("Resources")); });
    const pats = res.get("Pattern");
    if (has(pats)) pats.forEach((p) => { if (has(p.get("Resources"))) walk(p.get("Resources")); });
  };
  for (let i = 0; i < d.countPages(); i++) walk(pageObj(d, i).getInheritable("Resources"));
}
const unitBox = (m) => {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};
// every image placement on a page, including inside placed artwork
function placements(d, i) {
  const out = [];
  const { pg, objs } = pageObjects(d, i);
  const res = pg.getInheritable("Resources");
  const visit = (objs, res, outer, depth, pageLevel) => {
    objs.forEach((o, k) => {
      const ctm = mul(o.ctm, outer);
      if (o.type === "image") {
        if (!o.xname) { if (pageLevel) out.push({ inline: true, k, ctm, nested: false }); return; }
        const x = res.get("XObject", o.xname);
        if (has(x) && x.isIndirect()) out.push({ objnum: x.asIndirect(), name: o.xname, ctm, k: pageLevel ? k : null, nested: !pageLevel });
      } else if (o.type === "form" && depth < 8) {
        const f = res.get("XObject", o.xname);
        if (!has(f) || !f.isStream()) return;
        const fm = has(f.get("Matrix")) ? nums(f.get("Matrix")) : IDENT;
        const sub = findObjects(parseOps(bytesToStr(f.readStream().asUint8Array())), contextForRes(f.get("Resources")));
        visit(sub, f.get("Resources"), mul(fm, ctm), depth + 1, false);
      }
    });
  };
  visit(objs, res, IDENT, 0, true);
  return out;
}
const FILTER_NAMES = { DCTDecode: "JPEG", JPXDecode: "JPEG 2000", FlateDecode: "ZIP", LZWDecode: "LZW", CCITTFaxDecode: "Fax", JBIG2Decode: "JBIG2", RunLengthDecode: "RLE" };
function csLabel(cs) {
  if (!has(cs)) return "Mask";
  if (cs.isName()) return { DeviceCMYK: "CMYK", DeviceRGB: "RGB", DeviceGray: "Grey" }[cs.asName()] || cs.asName();
  const fam = cs.get(0).asName();
  if (fam === "ICCBased") return `ICC ${{ 1: "Grey", 3: "RGB", 4: "CMYK" }[cs.get(1).get("N").asNumber()] || ""}`;
  if (fam === "Separation") return `Spot: ${cs.get(1).asName()}`;
  if (fam === "DeviceN") { const n = []; for (let k = 0; k < cs.get(1).length; k++) n.push(cs.get(1).get(k).asName()); return `DeviceN: ${n.join(", ")}`; }
  if (fam === "Indexed") return `Indexed ${csLabel(cs.get(1))}`;
  return fam;
}
function imageList() {
  const byObj = new Map(), inline = [];
  for (let i = 0; i < doc.countPages(); i++) {
    for (const p of placements(doc, i)) {
      const box = unitBox(p.ctm), wpt = Math.hypot(p.ctm[0], p.ctm[1]), hpt = Math.hypot(p.ctm[2], p.ctm[3]);
      if (p.inline) { inline.push({ page: i, k: p.k, bbox: box }); continue; }
      let e = byObj.get(p.objnum);
      if (!e) {
        const x = doc.newIndirect(p.objnum);
        const f = x.get("Filter");
        const filt = !has(f) ? "Uncompressed" : f.isArray() ? [...Array(f.length).keys()].map((j) => FILTER_NAMES[f.get(j).asName()] || f.get(j).asName()).join("+") : FILTER_NAMES[f.asName()] || f.asName();
        e = {
          objnum: p.objnum, name: p.name, w: numOr(x.get("Width"), 0), h: numOr(x.get("Height"), 0), bpc: numOr(x.get("BitsPerComponent"), 1),
          cs: has(x.get("ImageMask")) && x.get("ImageMask").asBoolean() ? "Mask" : csLabel(x.get("ColorSpace")), filter: filt,
          alpha: has(x.get("SMask")), kb: Math.round(x.readRawStream().asUint8Array().length / 1024), placements: [], pending: relinked.has(p.objnum),
        };
        byObj.set(p.objnum, e);
      }
      const ppi = Math.min(e.w / (wpt / 72 || 1), e.h / (hpt / 72 || 1));
      e.placements.push({ page: i, k: p.k, nested: p.nested, bbox: box, ppi: Math.round(ppi), mmW: +(wpt * core.PT_TO_MM).toFixed(2), mmH: +(hpt * core.PT_TO_MM).toFixed(2) });
    }
  }
  return { images: [...byObj.values()], inline };
}
function relinkImage(d, op) {
  const img = new mupdf.Image(new Uint8Array(op.data));
  const ref = d.addImage(img);
  relinked.add(ref.asIndirect());
  forEachResDict(d, (res) => {
    const xo = res.get("XObject");
    if (has(xo)) xo.forEach((v, k) => { if (v.isIndirect() && v.asIndirect() === op.objnum) xo.put(k, ref); });
  });
  if (op.mode !== "fit") return;
  const ia = img.getWidth() / img.getHeight();
  for (let i = 0; i < d.countPages(); i++) {
    const pg = pageObj(d, i);
    let cur = parsePage(pg, readContent(pg));
    const res = pg.getInheritable("Resources");
    const ks = cur.objs.map((o, k) => (o.type === "image" && o.xname && has(res.get("XObject", o.xname)) && res.get("XObject", o.xname).asIndirect() === ref.asIndirect() ? k : -1)).filter((k) => k >= 0);
    if (!ks.length) continue;
    for (const k of ks.sort((a, b) => b - a)) {
      const o = cur.objs[k], fa = Math.hypot(o.ctm[0], o.ctm[1]) / (Math.hypot(o.ctm[2], o.ctm[3]) || 1);
      const [sx, sy] = ia > fa ? [1, fa / ia] : [ia / fa, 1];
      const m = `${+sx.toFixed(5)} 0 0 ${+sy.toFixed(5)} ${+((1 - sx) / 2).toFixed(5)} ${+((1 - sy) / 2).toFixed(5)}`;
      const s2 = cur.s.slice(0, cur.ops[o.a].s) + `q ${m} cm /${o.xname} Do Q` + cur.s.slice(cur.ops[o.a].e);
      cur = parsePage(pg, s2);
    }
    writeContent(d, pg, cur.s);
  }
}
function removeImage(d, objnum) {
  let empty = null;
  for (let i = 0; i < d.countPages(); i++) {
    const pg = pageObj(d, i);
    let cur = parsePage(pg, readContent(pg));
    const res = pg.getInheritable("Resources");
    const ks = cur.objs.map((o, k) => (o.type === "image" && o.xname && has(res.get("XObject", o.xname)) && res.get("XObject", o.xname).asIndirect() === objnum ? k : -1)).filter((k) => k >= 0);
    for (const k of ks.sort((a, b) => b - a)) cur = parsePage(pg, editContent(cur.s, cur.ops, cur.objs, { action: "delete", obj: k }));
    if (ks.length) writeContent(d, pg, cur.s);
  }
  // placements inside placed artwork: point them at an empty form instead
  forEachResDict(d, (res) => {
    const xo = res.get("XObject");
    if (!has(xo)) return;
    xo.forEach((v, k) => {
      if (!(v.isIndirect() && v.asIndirect() === objnum)) return;
      if (!empty) {
        const dict = d.newDictionary();
        dict.put("Type", d.newName("XObject")); dict.put("Subtype", d.newName("Form")); dict.put("BBox", [0, 0, 0, 0]);
        empty = d.addStream(new Uint8Array(0), dict);
      }
      xo.put(k, empty);
    });
  });
}

// ------------------------------------------------------------------ screening
export const DOT_SHAPES = ["Round", "Ellipse", "EllipseC", "Square", "Diamond", "Line", "Cross"];
function ht1(d, s) {
  const h = d.newDictionary();
  h.put("Type", d.newName("Halftone")); h.put("HalftoneType", 1);
  h.put("Frequency", +s.lpi); h.put("Angle", +s.angle); h.put("SpotFunction", d.newName(s.shape || "Round"));
  return h;
}
// settings: { Default: {lpi, angle, shape}, <ink>: {...} }
function applyScreens(d, settings, onlyInk) {
  const root = d.getTrailer().get("Root");
  let ht;
  if (onlyInk) ht = ht1(d, settings[onlyInk]); // preview of one spot ink
  else {
    ht = d.newDictionary();
    ht.put("Type", d.newName("Halftone")); ht.put("HalftoneType", 5);
    ht.put("Default", ht1(d, settings.Default));
    for (const [ink, s] of Object.entries(settings)) if (ink !== "Default") ht.put(ink, ht1(d, s));
    const rec = d.newDictionary();
    for (const [ink, s] of Object.entries(settings)) rec.put(ink, [+s.lpi, +s.angle, d.newName(s.shape || "Round")]);
    root.put("PPScreening", rec);
  }
  const gs = d.newDictionary();
  gs.put("Type", d.newName("ExtGState")); gs.put("HT", ht);
  const gsRef = d.addObject(gs);
  for (let i = 0; i < d.countPages(); i++) {
    const pg = pageObj(d, i);
    subDict(d, ensureRes(d, pg), "ExtGState").put("PPHT", gsRef);
    const s = readContent(pg), ops = parseOps(s);
    if (!(ops[0] && ops[0].op === "gs" && ops[0].args[0] && ops[0].args[0].name === "PPHT")) writeContent(d, pg, "/PPHT gs\n" + s);
  }
}
function readScreens() {
  const rec = doc.getTrailer().get("Root").get("PPScreening");
  const out = {};
  if (has(rec)) rec.forEach((v, k) => { out[k] = { lpi: v.get(0).asNumber(), angle: v.get(1).asNumber(), shape: v.get(2).asName() }; });
  else {
    // fall back to halftones already in the file (first page)
    const gsd = pageObj(doc, 0).getInheritable("Resources").get("ExtGState");
    const one = (h) => ({ lpi: numOr(h.get("Frequency"), 150), angle: numOr(h.get("Angle"), 45), shape: has(h.get("SpotFunction")) && h.get("SpotFunction").isName() ? h.get("SpotFunction").asName() : "Round" });
    if (has(gsd)) gsd.forEach((g) => {
      const h = g.isDictionary() ? g.get("HT") : null;
      if (!h || !has(h) || !h.isDictionary()) return;
      const t = numOr(h.get("HalftoneType"), 0);
      if (t === 1) out.Default = one(h);
      else if (t === 5) h.forEach((v, k) => { if (v.isDictionary() && numOr(v.get("HalftoneType"), 0) === 1) out[k] = one(v); });
    });
  }
  return out;
}

// separations follow the layer view: hidden layers are switched off in a throwaway copy only
function hideLayersIn(d) {
  const hidden = layerInfo().filter((l) => !l.visible).map((l) => l.id);
  if (!hidden.length || !ocProps(d)) return;
  const D = ocProps(d).get("D");
  const on = d.newArray(), off = d.newArray();
  for (const l of listLayers(d)) (hidden.includes(l.id) ? off : on).push(ocgById(d, l.id));
  D.put("ON", on); D.put("OFF", off); D.delete("BaseState");
}

function fresh() {
  const d = new mupdf.PDFDocument(current);
  for (const op of log) applyOp(d, op);
  return d;
}

// Re-open the working document from its own bytes so MuPDF picks up new or
// renamed layers. Saving still appends to (and keeps) the original bytes.
function rebase() {
  const d = fresh();
  const bytes = d.saveToBuffer("incremental").asUint8Array().slice();
  d.destroy();
  doc.destroy();
  doc = new mupdf.PDFDocument(bytes);
  applyView();
}

function doEdit(op) {
  if (op.kind === "barcode") buildBarcode(op.spec); // validate data before touching the document
  try { applyOp(doc, op); }
  catch (err) { doc.destroy(); doc = fresh(); throw err; } // roll back any partial change
  log.push(op);
  if (op.kind === "newLayer" || op.kind === "renameLayer") rebase();
}

function objList(i) {
  const { pg, objs } = pageObjects(doc, i);
  const layers = new Map(layerInfo().map((l) => [l.id, l]));
  return objs.map((o, k) => {
    const ids = [...o.layers.flatMap((r) => ocgsForRes(pg, r)), ...(o.xoc ? [o.xoc] : [])];
    const ls = ids.map((id) => layers.get(id)).filter(Boolean);
    const p = o.wrap ? o.wrap.props : {};
    let path = null;
    try { path = p.Path ? JSON.parse(p.Path) : null; } catch {}
    const text = o.type === "text" ? (p.T ? { ours: true, text: fromUtf16(p.T), font: p.F, size: p.S, lead: p.Ld, align: p.A, ink: p.K, cmyk: p.KC, tint: p.Tn, path }
      : { ours: false, size: +o.size.toFixed(2), fontRes: o.fontRes }) : null;
    const desc = text && text.ours ? `Text · ${String(text.font).slice(2)} ${text.size} pt · ${text.ink} ${text.tint}%` : o.desc;
    return {
      k, type: o.type, bbox: o.bbox, desc, clip: !!o.clip, group: p.G || 0, locked: p.L === 1,
      layer: ls.length ? { id: ls[ls.length - 1].id, name: ls[ls.length - 1].name } : null,
      layerLocked: ls.some((l) => l.locked), layerHidden: ls.some((l) => !l.visible), text, barcode: o.barcode || null, trap: !!p.Trap,
    };
  });
}

function textOf(i, k) {
  const o = pageObjects(doc, i).objs[k];
  const b = core.pageBoxes(doc, i), mb = b.MediaBox;
  const c = b.CropBox ? [Math.max(b.CropBox[0], mb[0]), Math.max(b.CropBox[1], mb[1]), Math.min(b.CropBox[2], mb[2]), Math.min(b.CropBox[3], mb[3])] : mb;
  const st = doc.loadPage(i).toStructuredText("preserve-whitespace");
  const j = JSON.parse(st.asJSON());
  const lines = [];
  for (const bl of j.blocks || []) for (const l of bl.lines || []) {
    const cx = l.bbox.x + l.bbox.w / 2 + c[0], cy = c[3] - (l.bbox.y + l.bbox.h / 2);
    if (cx >= o.bbox[0] - 1 && cx <= o.bbox[2] + 1 && cy >= o.bbox[1] - 1 && cy <= o.bbox[3] + 1) lines.push(l.text);
  }
  return lines.join("\n");
}

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
    viewState.clear();
    relinked.clear();
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
  edit(op) { doEdit({ kind: "objs", ...op }); return { objects: objList(op.i), edits: log.length, inks: docInks() }; },
  barcode(op) { doEdit({ kind: "barcode", ...op }); return { objects: objList(op.i), edits: log.length, inks: docInks() }; },
  barcodeEdit(op) { doEdit({ kind: "barcodeEdit", ...op }); return { objects: objList(op.i), edits: log.length, inks: docInks() }; },
  addText(op) { doEdit({ kind: "addText", ...op, spec: resolvePath(op.i, op.spec) }); return { objects: objList(op.i), edits: log.length, inks: docInks() }; },
  replaceText(op) { doEdit({ kind: "replaceText", ...op, spec: resolvePath(op.i, op.spec) }); return { objects: objList(op.i), edits: log.length, inks: docInks() }; },
  // sharp view: draw only the visible part of the page at screen resolution
  renderRegion({ i, rect, scale }) {
    const page = doc.loadPage(i), b = core.pageBoxes(doc, i), mb = b.MediaBox;
    const c = b.CropBox ? [Math.max(b.CropBox[0], mb[0]), Math.max(b.CropBox[1], mb[1]), Math.min(b.CropBox[2], mb[2]), Math.min(b.CropBox[3], mb[3])] : mb;
    const bbox = [Math.floor((rect[0] - c[0]) * scale), Math.floor((c[3] - rect[3]) * scale), Math.ceil((rect[2] - c[0]) * scale), Math.ceil((c[3] - rect[1]) * scale)];
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.run(dev, mupdf.Matrix.scale(scale, scale));
    dev.close();
    const w = pix.getWidth(), h = pix.getHeight(), st = pix.getStride(), src = pix.getPixels();
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) for (let x = 0, p = y * st; x < w; x++, p += 3) { rgba[q++] = src[p]; rgba[q++] = src[p + 1]; rgba[q++] = src[p + 2]; rgba[q++] = 255; }
    pix.destroy();
    return { result: { w, h, rgba, x0: bbox[0] / scale + c[0], y1: c[3] - bbox[1] / scale }, transfer: [rgba.buffer] };
  },
  // a one-page document showing just `rect` of page i, for sharp separations
  regionDoc({ i, rect }) {
    const { d } = tileDoc(i, [rect], { atStart: true, view: true });
    const out = d.saveToBuffer("").asUint8Array().slice();
    d.destroy();
    return { result: out, transfer: [out.buffer] };
  },
  textOf({ i, k }) { return textOf(i, k); },
  // trapping
  trapTiles({ i, rects }) {
    const { d, first } = tileDoc(i, rects, { withoutTraps: true });
    const out = d.saveToBuffer("").asUint8Array().slice();
    d.destroy();
    return { result: { bytes: out, first }, transfer: [out.buffer] };
  },
  traps({ i, groups }) { doEdit({ kind: "traps", i, groups, layerName: "Traps" }); return { objects: objList(i), edits: log.length, layers: layerInfo() }; },
  removeTraps({ i }) { doEdit({ kind: "removeTraps", i }); return { objects: objList(i), edits: log.length }; },
  // links
  images() { return imageList(); },
  thumb({ i, bbox, size }) {
    const page = doc.loadPage(i), mb = core.pageBoxes(doc, i).MediaBox;
    const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
    const s = Math.min((size || 96) / Math.max(bw, bh, 1), Math.sqrt(4e6 / ((mb[2] - mb[0]) * (mb[3] - mb[1]))));
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true, "View", "MediaBox");
    const W = pix.getWidth(), H = pix.getHeight(), st = pix.getStride(), src = pix.getPixels();
    const x0 = Math.max(0, Math.floor((bbox[0] - mb[0]) * s)), y0 = Math.max(0, Math.floor((mb[3] - bbox[3]) * s));
    const w = Math.max(1, Math.min(W - x0, Math.ceil(bw * s))), h = Math.max(1, Math.min(H - y0, Math.ceil(bh * s)));
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y0 + y) * st + (x0 + x) * 3; rgba[q++] = src[p]; rgba[q++] = src[p + 1]; rgba[q++] = src[p + 2]; rgba[q++] = 255; }
    pix.destroy();
    return { result: { w, h, rgba }, transfer: [rgba.buffer] };
  },
  relink({ objnum, data, mode }) {
    new mupdf.Image(new Uint8Array(data)); // validate before logging
    doEdit({ kind: "relink", objnum, data, mode });
    return { edits: log.length, inks: docInks() };
  },
  removeImage({ objnum }) { doEdit({ kind: "removeImage", objnum }); return { edits: log.length }; },
  // screening
  screens() { return { settings: readScreens(), shapes: DOT_SHAPES }; },
  applyScreens({ settings }) { doEdit({ kind: "screens", settings }); return { edits: log.length, report: core.documentReport(doc) }; },
  dotDocs({ i, rect, settings, spots }) {
    // one render with the per-ink (Type 5) screens for process inks, plus one
    // per spot ink with that ink's screen as the only screen (see README)
    const docs = [];
    const make = (onlyInk) => {
      const { d } = tileDoc(i, [rect], { atStart: true });
      applyScreens(d, settings, onlyInk);
      const out = d.saveToBuffer("").asUint8Array().slice();
      d.destroy();
      return out;
    };
    docs.push({ bytes: make(null), inks: ["Cyan", "Magenta", "Yellow", "Black"] });
    for (const s of spots) docs.push({ bytes: make(settings[s] ? s : "Default"), inks: [s] });
    return { result: docs, transfer: docs.map((x) => x.bytes.buffer) };
  },
  layers() { return layerInfo(); },
  layerView({ id, visible }) { viewState.set(id, visible); applyView(); return layerInfo(); },
  layerEdit(op) { doEdit(op); return { layers: layerInfo(), edits: log.length, report: core.documentReport(doc) }; },
  fonts() { return { builtin: BUILTIN_FONTS.map((n) => ({ id: "b:" + n, name: n })), imported: [...fontData.keys()].map((id) => ({ id, name: id.slice(2) })) }; },
  registerFont({ data }) {
    const bytes = new Uint8Array(data);
    const name = fontFileName(bytes);
    new mupdf.Font(name, bytes); // validates the file
    const id = "u:" + name;
    fontData.set(id, bytes);
    return { id, name };
  },
  undo() {
    if (!log.length) return { edits: 0, page: null };
    const op = log.pop();
    rebase();
    return { edits: log.length, page: op.i ?? null, report: core.documentReport(doc), inks: docInks() };
  },
  inks() { return docInks(); },
  barcodeTypes() { return Object.entries(TYPES).map(([id, t]) => ({ id, ...t })); },
  preflight({ opts }) {
    // check everything that prints, whatever is hidden in the view
    for (let k = 0; k < doc.countLayers(); k++) doc.setLayerVisible(k, true);
    try { return runPreflight(mupdf, doc, opts); }
    finally { restoreView(); }
  },
  snapshot() {
    const hidden = layerInfo().filter((l) => !l.visible).map((l) => l.id);
    if (!log.length && !hidden.length) { const c = current.slice(); return { result: c, transfer: [c.buffer] }; }
    const d = fresh();
    hideLayersIn(d);
    const out = d.saveToBuffer("incremental").asUint8Array().slice();
    d.destroy();
    return { result: out, transfer: [out.buffer] };
  },
  save() {
    if (!log.length) {
      const copy = current.slice();
      return { result: { bytes: copy, mode: "unchanged", prefixOK: true, diffs: [] }, transfer: [copy.buffer] };
    }
    // save from a clean replay (original bytes + edit log), never from the
    // working copy, so the file is always: original bytes + one increment
    const d = fresh();
    subsetOurFonts(d);
    const mode = d.canBeSavedIncrementally() ? "incremental" : "full";
    // compress only applies to objects written now (new images, fonts, content)
    const buf = d.saveToBuffer(mode === "incremental" ? "incremental,compress" : "compress");
    const out = buf.asUint8Array().slice();
    buf.destroy();
    d.destroy();
    const prefixOK = mode === "incremental" && out.length >= current.length && same(out.subarray(0, current.length), current);
    const a = new mupdf.PDFDocument(baseline), b = new mupdf.PDFDocument(out);
    const diffs = core.compareDocs(a, b);
    a.destroy(); b.destroy();
    current = out;
    log = [];
    doc.destroy();
    doc = new mupdf.PDFDocument(current);
    applyView();
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
