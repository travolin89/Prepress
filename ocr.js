// Helpers for turning outlined (vector) text back into live text.
// The outlines are rendered black on white, read with OCR (trying the four
// right-angle rotations), and each recognised line is mapped back to a
// baseline position, angle, size and width on the page.

// rotate a greyscale image by q quarter turns clockwise
export function rotateGrey(g, w, h, q) {
  q = ((q % 4) + 4) % 4;
  if (q === 0) return { g, w, h };
  const W = q % 2 ? h : w, H = q % 2 ? w : h, o = new Uint8ClampedArray(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = q === 1 ? h - 1 - y : q === 2 ? w - 1 - x : y;
    const Y = q === 1 ? x : q === 2 ? h - 1 - y : w - 1 - x;
    o[Y * W + X] = g[y * w + x];
  }
  return { g: o, w: W, h: H };
}

// a point in the rotated image back to the original image
function unrotate(X, Y, w, h, q) {
  if (q === 1) return [Y, h - X];
  if (q === 2) return [w - X, h - Y];
  if (q === 3) return [w - Y, X];
  return [X, Y];
}

// Tesseract lines -> page lines. im: { w, h, rect, scale } of the unrotated image.
export function linesToPage(lines, im, q) {
  const out = [];
  for (const L of lines) {
    const text = (L.text || "").replace(/\s+$/, "").replace(/\s+/g, " ");
    if (!text.trim()) continue;
    const b = L.bbox, bl = L.baseline && L.baseline.has_baseline !== false ? L.baseline : null;
    const yAt = (x) => (bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0) : b.y1);
    const s = [b.x0, yAt(b.x0)], e = [b.x1, yAt(b.x1)];
    const asc = Math.max(1, s[1] - b.y0); // height above the baseline, in pixels
    const ratio = /[A-Z0-9bdfhklt]/.test(text) ? 0.75 : 0.53; // ascender height vs x-height, as a share of the font size
    const toPage = ([X, Y]) => { const [x, y] = unrotate(X, Y, im.w, im.h, q); return [im.rect[0] + x / im.scale, im.rect[3] - y / im.scale]; };
    const P0 = toPage(s), P1 = toPage(e);
    const len = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1;
    const dx = (P1[0] - P0[0]) / len, dy = (P1[1] - P0[1]) / len;
    out.push({
      text, conf: Math.round(L.confidence ?? 0),
      size: +(asc / ratio / im.scale).toFixed(2),
      width: +len.toFixed(3),
      M: [dx, dy, -dy, dx, P0[0], P0[1]].map((v) => +v.toFixed(4)),
    });
  }
  return out;
}

// flatten Tesseract's block structure into lines
export function tesseractLines(data) {
  const lines = [];
  for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) for (const l of p.lines || []) lines.push(l);
  return lines;
}

// the fill ink of an outlined path, from its description ("fill PANTONE 2738 C 100%", "fill CMYK 0/0/0/100")
export function inkFromDesc(desc) {
  const m = /fill (.+?)(?: · |$)/.exec(desc || "");
  if (!m) return { name: "Black", tint: 100 };
  const f = m[1];
  const c = /^CMYK (\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(f);
  if (c) {
    const v = c.slice(1).map(Number), nz = v.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
    if (nz.length === 1) return { name: ["Cyan", "Magenta", "Yellow", "Black"][nz[0]], tint: v[nz[0]] };
    return { name: "Black", tint: 100 };
  }
  const g = /^Gray ([\d.]+)$/.exec(f);
  if (g) return { name: "Black", tint: Math.round((1 - +g[1]) * 100) };
  const sp = /^(.+) (\d+)%$/.exec(f);
  if (sp) return { name: sp[1], tint: +sp[2] };
  return { name: "Black", tint: 100 };
}
