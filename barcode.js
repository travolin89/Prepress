// Barcode builder: vector bars/modules plus human-readable digits drawn as
// outlines (no fonts needed, so PDF/X stays valid). Supports bar width
// reduction (BWR) for flexo.
import bwipjs from "./bwip-js.mjs";

export const TYPES = {
  ean13: { label: "EAN-13", mag: [80, 200], linear: true, qz: [11, 7], x: 0.33, h: 22.85, sample: "590123412345" },
  upca: { label: "UPC-A", mag: [80, 200], linear: true, qz: [9, 9], x: 0.33, h: 22.85, sample: "03600029145" },
  ean8: { label: "EAN-8", mag: [80, 200], linear: true, qz: [7, 7], x: 0.33, h: 18.23, sample: "9638507" },
  "gs1-128": { label: "GS1-128", linear: true, qz: [10, 10], x: 0.495, h: 31.75, sample: "(01)09501101530003(17)261231(10)AB12" },
  code128: { label: "Code 128", linear: true, qz: [10, 10], x: 0.33, h: 15, sample: "ABC-12345" },
  itf14: { label: "ITF-14", linear: true, qz: [10, 10], x: 0.635, h: 32, sample: "15400141288763" },
  gs1datamatrix: { label: "GS1 DataMatrix", linear: false, qz: [1, 1], x: 0.5, sample: "(01)09501101530003(17)261231(10)AB12" },
  datamatrix: { label: "DataMatrix", linear: false, qz: [1, 1], x: 0.5, sample: "PREPRESS-0001" },
  gs1qrcode: { label: "GS1 QR Code", linear: false, qz: [4, 4], x: 0.5, sample: "(01)09501101530003" },
  qrcode: { label: "QR Code", linear: false, qz: [4, 4], x: 0.5, sample: "https://example.com" },
};

const MM = 72 / 25.4;
const f = (v) => +v.toFixed(3);

// spec: { type, data, moduleMM, heightMM, bwrMM, hri }
// returns { w, h, ops } in points, origin bottom-left (quiet zones included)
export function buildBarcode(spec) {
  const t = TYPES[spec.type];
  if (!t) throw new Error("Unknown barcode type");
  const X = spec.moduleMM * MM, bwr = Math.max(0, (spec.bwrMM || 0) * MM);
  if (bwr >= X * 0.8) throw new Error("Bar width reduction is too large for this module size");
  return t.linear ? linear(spec, t, X, bwr) : matrix(spec, t, X, bwr);
}

function linear(spec, t, X, bwr) {
  const svg = bwipjs.toSVG({
    bcid: spec.type, text: spec.data, scale: 2, includetext: !!spec.hri,
    height: spec.heightMM / X, // bwip height is in mm at 1pt modules; scaled so bars come out at heightMM
  });
  const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const k = X / 2; // svg units -> pt (scale 2 => 2 units per module)
  const bars = [], fills = [];
  for (const m of svg.matchAll(/<path stroke="[^"]*" stroke-width="([\d.]+)" d="([^"]+)"/g)) {
    const w = +m[1];
    for (const seg of m[2].matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g)) {
      const x = +seg[1], y0 = Math.min(+seg[2], +seg[4]), y1 = Math.max(+seg[2], +seg[4]);
      bars.push([x - w / 2, y0, x + w / 2, y1]);
    }
  }
  for (const m of svg.matchAll(/<path d="([^"]+)"/g)) fills.push(m[1]);
  if (!bars.length) throw new Error("No bars produced");
  const barMin = Math.min(...bars.map((b) => b[0])), barMax = Math.max(...bars.map((b) => b[2]));
  const qzL = t.qz[0] * 2, qzR = t.qz[1] * 2;
  const minX = Math.min(0, barMin - qzL), maxX = Math.max(vw, barMax + qzR);
  const px = (x) => (x - minX) * k, py = (y) => (vh - y) * k;
  let ops = "";
  for (const [x0, y0, x1, y1] of bars) {
    ops += `${f(px(x0) + bwr / 2)} ${f(py(y1))} ${f((x1 - x0) * k - bwr)} ${f((y1 - y0) * k)} re\n`;
  }
  ops += "f\n";
  for (const d of fills) ops += svgPathToPdf(d, px, py) + "f\n";
  return { w: (maxX - minX) * k, h: vh * k, ops };
}

function svgPathToPdf(d, px, py) {
  let out = "", cx = 0, cy = 0;
  for (const m of d.matchAll(/([MLQCZ])([^MLQCZ]*)/gi)) {
    const c = m[1].toUpperCase(), n = (m[2].match(/-?[\d.]+(?:e-?\d+)?/gi) || []).map(Number);
    if (c === "M") { cx = n[0]; cy = n[1]; out += `${f(px(cx))} ${f(py(cy))} m\n`; }
    else if (c === "L") { for (let i = 0; i < n.length; i += 2) { cx = n[i]; cy = n[i + 1]; out += `${f(px(cx))} ${f(py(cy))} l\n`; } }
    else if (c === "Q") {
      for (let i = 0; i < n.length; i += 4) {
        const [qx, qy, x, y] = n.slice(i, i + 4);
        const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
        const c2x = x + (2 / 3) * (qx - x), c2y = y + (2 / 3) * (qy - y);
        out += `${f(px(c1x))} ${f(py(c1y))} ${f(px(c2x))} ${f(py(c2y))} ${f(px(x))} ${f(py(y))} c\n`;
        cx = x; cy = y;
      }
    } else if (c === "C") {
      for (let i = 0; i < n.length; i += 6) {
        const [a, b, c2, d2, x, y] = n.slice(i, i + 6);
        out += `${f(px(a))} ${f(py(b))} ${f(px(c2))} ${f(py(d2))} ${f(px(x))} ${f(py(y))} c\n`;
        cx = x; cy = y;
      }
    } else if (c === "Z") out += "h\n";
  }
  return out;
}

function matrix(spec, t, X, bwr) {
  const r = bwipjs.raw(spec.type, spec.data, "")[0];
  const cols = r.pixx, rows = r.pixy, px = r.pixs, qz = t.qz[0];
  const dark = (c, y) => c >= 0 && y >= 0 && c < cols && y < rows && px[y * cols + c] === 1;
  const W = (cols + 2 * qz) * X, H = (rows + 2 * qz) * X;
  let ops = "";
  const b = bwr / 2;
  for (let y = 0; y < rows; y++) {
    if (!b) {
      for (let c = 0; c < cols; c++) {
        if (!dark(c, y)) continue;
        let e = c;
        while (dark(e + 1, y)) e++;
        ops += `${f((qz + c) * X)} ${f(H - (qz + y + 1) * X)} ${f((e - c + 1) * X)} ${f(X)} re\n`;
        c = e;
      }
      continue;
    }
    for (let c = 0; c < cols; c++) {
      if (!dark(c, y)) continue;
      const x0 = (qz + c) * X, x1 = x0 + X, yT = H - (qz + y) * X, yB = yT - X;
      const L = !dark(c - 1, y), R = !dark(c + 1, y), T = !dark(c, y - 1), B = !dark(c, y + 1);
      const l = x0 + (L ? b : 0), rr = x1 - (R ? b : 0), tt = yT - (T ? b : 0), bb = yB + (B ? b : 0);
      // concave corners: both sides dark but the diagonal is light -> notch
      const nTL = !L && !T && !dark(c - 1, y - 1), nTR = !R && !T && !dark(c + 1, y - 1);
      const nBR = !R && !B && !dark(c + 1, y + 1), nBL = !L && !B && !dark(c - 1, y + 1);
      const p = [];
      if (nTL) p.push([l, tt - b], [l + b, tt - b], [l + b, tt]); else p.push([l, tt]);
      if (nTR) p.push([rr - b, tt], [rr - b, tt - b], [rr, tt - b]); else p.push([rr, tt]);
      if (nBR) p.push([rr, bb + b], [rr - b, bb + b], [rr - b, bb]); else p.push([rr, bb]);
      if (nBL) p.push([l + b, bb], [l + b, bb + b], [l, bb + b]); else p.push([l, bb]);
      ops += p.map(([x, yy], i) => `${f(x)} ${f(yy)} ${i ? "l" : "m"}`).join("\n") + "\nh\n";
    }
  }
  return { w: W, h: H, ops: ops + "f\n" };
}
