// Engine worker: MuPDF (WebAssembly) for opening, rendering, editing and
// saving. Saves are incremental: the original bytes are kept exactly and edits
// are appended, then the result is verified object-by-object.
import * as mupdf from "./mupdf.js";
import * as core from "./pdfcore.js";

let doc = null;
let baseline = null; // bytes exactly as first opened
let current = null;  // bytes of the latest saved state

const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

const api = {
  open({ bytes }) {
    baseline = current = new Uint8Array(bytes);
    doc = new mupdf.PDFDocument(current);
    return { pages: doc.countPages(), report: core.documentReport(doc), incremental: doc.canBeSavedIncrementally() };
  },

  page({ i }) {
    return { boxes: core.pageBoxes(doc, i), rotation: core.pageRotation(doc, i), spots: core.scanPageInks(doc, i) };
  },

  render({ i, dpi }) {
    const page = doc.loadPage(i);
    const s = dpi / 72;
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true, "View", "MediaBox");
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), src = pix.getPixels();
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) {
      for (let x = 0, p = y * stride; x < w; x++, p += 3) {
        rgba[q++] = src[p]; rgba[q++] = src[p + 1]; rgba[q++] = src[p + 2]; rgba[q++] = 255;
      }
    }
    pix.destroy();
    page.destroy?.();
    return { result: { w, h, rgba }, transfer: [rgba.buffer] };
  },

  setBox({ i, name, rect }) {
    core.setPageBox(doc, i, name, rect);
    return { boxes: core.pageBoxes(doc, i), report: core.documentReport(doc) };
  },

  save() {
    if (!doc.hasUnsavedChanges()) {
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
