// Automatic trapping from true separations.
//
// For every pair of touching colours where misregistration could open a gap
// (each colour has ink the other lacks, by more than the step limit), the
// lighter colour (lower neutral density) is spread into the darker one by the
// trap width. The result per ink is a mask of pixels whose plate value must be
// raised; masks are traced to polygons and later written as overprinting
// vector trap objects.

// plates: Uint8Array[] (0..255 coverage), w, h
// inks: [{ nd, mode: "normal"|"opaque"|"ignore" }] aligned with plates
// core: [x0, y0, x1, y1] pixel region whose result is kept (rest is overlap)
// opt: { r, rBlack, step (0..255), blackIdx, excl (Uint8Array mask of pixels to skip, or null) }
// returns { masks: Map "ink|value" -> Uint8Array (core-sized), cw, ch }
export function computeTraps(plates, w, h, inks, core, opt) {
  const n = w * h, N = plates.length;
  const use = inks.map((k) => k.mode !== "ignore");
  const nd = inks.map((k) => (k.mode === "opaque" ? 10 : k.nd));
  // pixel -> colour id (identical colours share an id) for fast region tests.
  // Hash the ink values per pixel; colours are compared exactly on collision.
  const ids = new Int32Array(n);
  const colours = [], buckets = new Map();
  let lastHash = -1, lastId = -1;
  for (let p = 0; p < n; p++) {
    let hsh = 2166136261;
    for (let k = 0; k < N; k++) hsh = Math.imul(hsh ^ (use[k] ? plates[k][p] : 0), 16777619);
    if (hsh === lastHash) { ids[p] = lastId; continue; } // runs of the same colour are common
    let list = buckets.get(hsh), id = -1;
    if (list) {
      for (const cand of list) {
        const c = colours[cand].c;
        let same = true;
        for (let k = 0; k < N; k++) if (c[k] !== (use[k] ? plates[k][p] : 0)) { same = false; break; }
        if (same) { id = cand; break; }
      }
    } else { list = []; buckets.set(hsh, list); }
    if (id < 0) {
      id = colours.length;
      list.push(id);
      const c = new Uint8Array(N);
      let d = 0;
      for (let k = 0; k < N; k++) { c[k] = use[k] ? plates[k][p] : 0; d += (nd[k] * c[k]) / 255; }
      colours.push({ c, nd: d });
    }
    ids[p] = id; lastHash = hsh; lastId = id;
  }
  // which colour pairs need a trap, and in which direction (cached per pair)
  const pairCache = new Map();
  const pairInfo = (a, b) => {
    const key = a * 1048576 + b;
    let v = pairCache.get(key);
    if (v !== undefined) return v;
    const A = colours[a].c, B = colours[b].c;
    let aMore = false, bMore = false;
    for (let k = 0; k < N; k++) {
      if (A[k] - B[k] > opt.step) aMore = true;
      if (B[k] - A[k] > opt.step) bMore = true;
    }
    v = null;
    if (aMore && bMore) {
      // lighter spreads into darker: trap pixels lie in the darker region
      const dark = colours[a].nd >= colours[b].nd ? a : b, light = dark === a ? b : a;
      v = { dark, light };
    }
    pairCache.set(key, v);
    return v;
  };

  // seeds: darker pixels touching a lighter neighbour that needs a trap
  const owner = new Int32Array(n).fill(-1);   // light colour id spread into this pixel
  const sx = new Int16Array(n), sy = new Int16Array(n); // where the trap started (tiles stay below 32k px)
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const excl = opt.excl;
  const N4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const N8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const radiusFor = (darkId) => (opt.blackIdx >= 0 && colours[darkId].c[opt.blackIdx] >= 242 ? opt.rBlack : opt.r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, a = ids[p];
      if (excl && excl[p]) continue;
      for (const [dx, dy] of N4) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X, b = ids[q];
        if (a === b || (excl && excl[q])) continue;
        const info = pairInfo(Math.min(a, b), Math.max(a, b));
        if (!info || info.dark !== a) continue;
        if (owner[p] < 0) {
          owner[p] = b; sx[p] = X; sy[p] = Y;
          queue[qt++] = p;
        }
      }
    }
  }
  // grow each trap into the darker region up to the trap width (Euclidean)
  while (qh < qt) {
    const p = queue[qh++], x = p % w, y = (p - x) / w;
    const region = ids[p], ox = sx[p], oy = sy[p], r = radiusFor(region);
    for (const [dx, dy] of N8) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const q = Y * w + X;
      if (owner[q] >= 0 || ids[q] !== region || (excl && excl[q])) continue;
      const ddx = X - ox, ddy = Y - oy;
      if (ddx * ddx + ddy * ddy > (r + 0.5) * (r + 0.5)) continue; // nearest whole pixel
      owner[q] = owner[p]; sx[q] = ox; sy[q] = oy;
      queue[qt++] = q;
    }
  }
  // per-ink masks of the core: raise the plate to the lighter colour's value
  const [cx0, cy0, cx1, cy1] = core, cw = cx1 - cx0, ch = cy1 - cy0;
  const masks = new Map();
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const p = y * w + x, l = owner[p];
      if (l < 0) continue;
      const L = colours[l].c, D = colours[ids[p]].c;
      for (let k = 0; k < N; k++) {
        if (L[k] - D[k] <= opt.step / 2) continue;
        const v = Math.min(255, Math.round(L[k] / 5) * 5); // 2% steps keep the object count sane
        const key = k + "|" + v;
        let m = masks.get(key);
        if (!m) { m = new Uint8Array(cw * ch); m.box = [cw, ch, 0, 0]; masks.set(key, m); }
        const lx = x - cx0, ly = y - cy0;
        m[ly * cw + lx] = 1;
        const b = m.box;
        if (lx < b[0]) b[0] = lx; if (ly < b[1]) b[1] = ly; if (lx + 1 > b[2]) b[2] = lx + 1; if (ly + 1 > b[3]) b[3] = ly + 1;
      }
    }
  }
  return { masks, cw, ch };
}

// Trace a binary mask into closed polygons (pixel-edge outlines, collinear
// points merged). Fill the result with the even-odd rule.
export function traceMask(m, w, h) {
  const [bx0, by0, bx1, by1] = m.box || [0, 0, w, h];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  const out = new Map(); // vertex key -> list of next vertices
  const K = (x, y) => y * (w + 2) + x;
  const add = (x0, y0, x1, y1) => { const k = K(x0, y0); let l = out.get(k); if (!l) { l = []; out.set(k, l); } l.push(x1, y1); };
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (!m[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const [start, list0] of out) {
    while (list0.length) {
      const sx = start % (w + 2), sy = (start - sx) / (w + 2);
      const pts = [sx, sy];
      let cy = list0.pop(), cx = list0.pop();
      let guard = 0;
      while ((cx !== sx || cy !== sy) && guard++ < 1e7) {
        pts.push(cx, cy);
        const l = out.get(K(cx, cy));
        if (!l || !l.length) break;
        cy = l.pop(); cx = l.pop();
      }
      // drop collinear points
      const n = pts.length / 2, simple = [];
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, c = (i + 1) % n;
        const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * i], by = pts[2 * i + 1], cx2 = pts[2 * c], cy2 = pts[2 * c + 1];
        if ((bx - ax) * (cy2 - by) - (by - ay) * (cx2 - bx) !== 0) simple.push(bx, by);
      }
      if (simple.length >= 6) loops.push(simple);
    }
  }
  return loops;
}

// Neutral density of a solid ink from its screen colour (process inks use the
// usual published values).
export const PROCESS_ND = { Cyan: 0.61, Magenta: 0.76, Yellow: 0.16, Black: 1.7 };
export function inkND(name, rgb) {
  if (PROCESS_ND[name] !== undefined) return PROCESS_ND[name];
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const Y = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return Math.min(2, -Math.log10(Math.max(Y, 0.01)));
}
