// Preflight: read-only checks. Painted content is inspected through a MuPDF
// device (so nested artwork is covered); fonts and boxes from the PDF objects.
import { pageBoxes, pageRotation, xmpText, xmpValue, PT_TO_MM } from "./pdfcore.js";

const has = (o) => o && !o.isNull();
export const DEFAULTS = { minPPI: 250, minLineMM: 0.1, minTextPT: 5, minBleedMM: 3 };

export function runPreflight(mupdf, doc, opts = DEFAULTS) {
  const groups = new Map();
  const add = (sev, page, key, title, rect, detail) => {
    const id = `${page}|${key}`;
    if (!groups.has(id)) groups.set(id, { sev, page, title, detail: detail || "", rects: [], count: 0 });
    const g = groups.get(id);
    g.count++;
    if (rect && g.rects.length < 300) g.rects.push(rect);
  };

  // document level
  const info = doc.getTrailer().get("Info");
  const pdfx = (has(info) && has(info.get("GTS_PDFXVersion"))) || xmpValue(xmpText(doc), "GTS_PDFXVersion");
  if (!pdfx) add("warn", 0, "pdfx", "Not identified as PDF/X");
  const oi = doc.getTrailer().get("Root").get("OutputIntents");
  if (!has(oi) || !oi.length) add("warn", 0, "oi", "No output intent (print condition)");

  for (let i = 0; i < doc.countPages(); i++) {
    const p = i + 1;
    const boxes = pageBoxes(doc, i);
    const mb = boxes.MediaBox, trim = boxes.TrimBox;
    if (!trim) add("error", p, "trim", "No trim box");
    if (trim && !boxes.BleedBox) add("warn", p, "bleedbox", "No bleed box");
    if (trim && boxes.BleedBox) {
      const b = boxes.BleedBox;
      const m = Math.min(trim[0] - b[0], trim[1] - b[1], b[2] - trim[2], b[3] - trim[3]) * PT_TO_MM;
      if (m < opts.minBleedMM - 0.01) add("warn", p, "bleed", `Bleed only ${m.toFixed(2)} mm`, null, `Minimum ${opts.minBleedMM} mm`);
    }

    for (const f of pageFonts(doc, i)) if (!f.embedded) add("error", p, "font:" + f.name, `Font not embedded: ${f.name}`);
    if (pageUsesAll(doc, i)) add("info", p, "all", "Uses registration colour (All)", null, "Prints on every plate");

    // painted content
    const c = boxes.CropBox ? [Math.max(boxes.CropBox[0], mb[0]), Math.max(boxes.CropBox[1], mb[1]), Math.min(boxes.CropBox[2], mb[2]), Math.min(boxes.CropBox[3], mb[3])] : mb;
    const rot = pageRotation(doc, i);
    const toPdf = (r) => (rot ? null : [r[0] + c[0], c[3] - r[3], r[2] + c[0], c[3] - r[1]]);
    const scale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const unitBox = (m) => {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
      return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
    };
    const isRGB = (cs) => cs && cs.getType() === "RGB";
    const text = (t, ctm, cs) => {
      const r = toPdf(t.getBounds(null, ctm));
      if (isRGB(cs)) add("warn", p, "rgbtext", "RGB text", r);
      let small = Infinity;
      t.walk({ beginSpan(font, trm) { small = Math.min(small, Math.hypot(trm[2], trm[3]) * scale(ctm)); } });
      if (small < opts.minTextPT) add("warn", p, "smalltext", `Text smaller than ${opts.minTextPT} pt`, r, `Smallest ${small.toFixed(2)} pt`);
    };
    const dev = new mupdf.Device({
      fillPath(path, eo, ctm, cs) { if (isRGB(cs)) add("warn", p, "rgbfill", "RGB colour (fill)", toPdf(path.getBounds(null, ctm))); },
      strokePath(path, st, ctm, cs) {
        const r = toPdf(path.getBounds(st, ctm));
        if (isRGB(cs)) add("warn", p, "rgbstroke", "RGB colour (stroke)", r);
        const lw = st.getLineWidth() * scale(ctm);
        if (lw === 0) add("error", p, "zeroline", "Zero-width line", r, "Prints as the thinnest line the device can make");
        else if (lw * PT_TO_MM < opts.minLineMM - 1e-6) add("warn", p, "hairline", `Line thinner than ${opts.minLineMM} mm`, r);
      },
      fillText(t, ctm, cs) { text(t, ctm, cs); },
      strokeText(t, st, ctm, cs) { text(t, ctm, cs); },
      fillImage(img, ctm) {
        const r = toPdf(unitBox(ctm));
        const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
        if (w > 0 && h > 0) {
          const ppi = Math.min(img.getWidth() / (w / 72), img.getHeight() / (h / 72));
          if (ppi < opts.minPPI) add(ppi < opts.minPPI * 0.6 ? "error" : "warn", p, ppi < opts.minPPI * 0.6 ? "lowres2" : "lowres", `Image below ${opts.minPPI} ppi`, r, `Lowest ${Math.round(ppi)} ppi`);
        }
        if (isRGB(img.getColorSpace())) add("warn", p, "rgbimg", "RGB image", r);
      },
    });
    try { doc.loadPage(i).run(dev, mupdf.Matrix.identity); } finally { dev.close(); }
  }

  // keep the lowest value in the detail line for grouped items
  const order = { error: 0, warn: 1, info: 2 };
  return [...groups.values()].sort((a, b) => order[a.sev] - order[b.sev] || a.page - b.page);
}

function forEachResource(doc, i, fn) {
  const seen = new Set();
  const walk = (res) => {
    if (!has(res) || !res.isDictionary()) return;
    if (res.isIndirect()) { if (seen.has(res.asIndirect())) return; seen.add(res.asIndirect()); }
    fn(res);
    const xo = res.get("XObject");
    if (has(xo)) xo.forEach((x) => { if (has(x.get("Resources")) && x.get("Subtype").asName?.() === "Form") walk(x.get("Resources")); });
    const pats = res.get("Pattern");
    if (has(pats)) pats.forEach((pt) => { if (has(pt.get("Resources"))) walk(pt.get("Resources")); });
  };
  walk(doc.loadPage(i).getObject().getInheritable("Resources"));
}

export function pageFonts(doc, i) {
  const out = new Map();
  forEachResource(doc, i, (res) => {
    const fonts = res.get("Font");
    if (!has(fonts)) return;
    fonts.forEach((f) => {
      const sub = has(f.get("Subtype")) ? f.get("Subtype").asName() : "";
      const name = has(f.get("BaseFont")) ? f.get("BaseFont").asName() : sub;
      if (sub === "Type3") { out.set(name, { name, embedded: true }); return; }
      const d = sub === "Type0" ? f.get("DescendantFonts", 0, "FontDescriptor") : f.get("FontDescriptor");
      const emb = has(d) && (has(d.get("FontFile")) || has(d.get("FontFile2")) || has(d.get("FontFile3")));
      if (!out.has(name) || !emb) out.set(name, { name, embedded: emb });
    });
  });
  return [...out.values()];
}

function pageUsesAll(doc, i) {
  let found = false;
  forEachResource(doc, i, (res) => {
    const cs = res.get("ColorSpace");
    if (has(cs)) cs.forEach((v) => { if (v.isArray() && v.length > 1 && v.get(0).asName() === "Separation" && v.get(1).asName() === "All") found = true; });
  });
  return found;
}
