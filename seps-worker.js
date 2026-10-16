// Separations worker: Ghostscript (WebAssembly) renders one plate per ink,
// handling overprint like a RIP. Also runs tiled trapping and dot-level
// (halftone) renders. Loaded only when first needed.
import createGS from "./gs.mjs";
import { plateFromTiff } from "./tiff.js";
import { computeTraps, traceMask } from "./trap.js";

const PROCESS = ["Cyan", "Magenta", "Yellow", "Black"];
let gsReady = null;
let errLog = [];
let loaded = null; // which PDF is in /in.pdf

function getGS() {
  if (!gsReady) {
    gsReady = createGS({
      noInitialRun: true,
      print() {},
      printErr(s) { errLog.push(s); },
      locateFile: (p) => new URL(p, import.meta.url).href,
    });
  }
  return gsReady;
}

async function render(bytes, tag, page, dpi, device = "tiffsep", packed = false) {
  const gs = await getGS();
  if (bytes) { gs.FS.writeFile("/in.pdf", new Uint8Array(bytes)); loaded = tag; }
  try { gs.FS.mkdir("/out"); } catch {}
  for (const f of gs.FS.readdir("/out")) if (f !== "." && f !== "..") gs.FS.unlink("/out/" + f);
  errLog = [];
  const rc = gs.callMain([
    "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", `-sDEVICE=${device}`, "-sCompression=none",
    `-r${dpi}`, `-dFirstPage=${page + 1}`, `-dLastPage=${page + 1}`,
    "-sOutputFile=/out/p.tif", "/in.pdf",
  ]);
  if (rc !== 0) throw new Error(errLog.join("\n") || `Ghostscript failed (${rc})`);
  const plates = {};
  let w = 0, h = 0;
  for (const f of gs.FS.readdir("/out")) {
    const m = f.match(/^p\((.+)\)\.tif$/);
    if (!m) continue;
    const pl = plateFromTiff(gs.FS.readFile("/out/" + f), { packed });
    plates[m[1]] = packed ? pl : pl.data;
    w = pl.w; h = pl.h;
    gs.FS.unlink("/out/" + f);
  }
  const names = [...PROCESS.filter((n) => n in plates), ...Object.keys(plates).filter((n) => !PROCESS.includes(n)).sort()];
  return { names, w, h, data: names.map((n) => plates[n]) };
}

const jobs = {
  // plain separations of one page
  async plates({ bytes, page, dpi }) {
    const r = await render(bytes, "doc", page, dpi);
    return { result: r, transfer: r.data.map((d) => d.buffer) };
  },

  // tiles: [{ page, rect:[pt], core:[px] }], inks: { name: {nd, mode} }, opt: { r, rBlack, step, excl:[[pt rect]...] }
  async trap({ bytes, tiles, dpi, inks, opt }, progress) {
    const groups = {}; // "ink|value" -> loops (page points)
    const k = 72 / dpi;
    for (let t = 0; t < tiles.length; t++) {
      progress(`Trapping: tile ${t + 1} of ${tiles.length}`);
      const tile = tiles[t];
      const r = await render(t === 0 ? bytes : null, "tiles", tile.page, dpi);
      const [rx0, , , ry1] = tile.rect;
      let excl = null;
      if (opt.excl && opt.excl.length) {
        excl = new Uint8Array(r.w * r.h);
        for (const e of opt.excl) {
          const x0 = Math.max(0, Math.floor((e[0] - rx0) / k)), x1 = Math.min(r.w, Math.ceil((e[2] - rx0) / k));
          const y0 = Math.max(0, Math.floor((ry1 - e[3]) / k)), y1 = Math.min(r.h, Math.ceil((ry1 - e[1]) / k));
          for (let y = y0; y < y1; y++) excl.fill(1, y * r.w + x0, y * r.w + Math.max(x0, x1));
        }
      }
      const meta = r.names.map((n) => inks[n] || { nd: 1, mode: "normal" });
      const core = tile.core.map((v, i) => Math.min(v, i % 2 ? r.h : r.w));
      const res = computeTraps(r.data, r.w, r.h, meta, core, { r: opt.r, rBlack: opt.rBlack, step: opt.step, blackIdx: r.names.indexOf("Black"), excl });
      for (const [key, mask] of res.masks) {
        const [ki, v] = key.split("|");
        const gk = r.names[+ki] + "|" + v;
        const loops = traceMask(mask, res.cw, res.ch).map((L) => {
          const out = new Array(L.length);
          for (let i = 0; i < L.length; i += 2) {
            out[i] = +(rx0 + (core[0] + L[i]) * k).toFixed(3);
            out[i + 1] = +(ry1 - (core[1] + L[i + 1]) * k).toFixed(3);
          }
          return out;
        });
        (groups[gk] || (groups[gk] = [])).push(...loops);
      }
    }
    return { result: groups, transfer: [] };
  },

  // dot-level (halftoned) plates, kept at 1 bit per pixel; renders: [{ bytes, inks: [names wanted] }]
  async dots({ renders, dpi }, progress) {
    const out = { names: [], w: 0, h: 0, stride: 0, bits: [], inkIsOne: [] };
    for (let j = 0; j < renders.length; j++) {
      progress(`Rendering dots ${j + 1} of ${renders.length}`);
      const job = renders[j];
      const r = await render(job.bytes, null, 0, dpi, "tiffsep1", true);
      out.w = r.w; out.h = r.h;
      r.names.forEach((n, i) => {
        if (!job.inks.includes(n) || out.names.includes(n)) return;
        const pl = r.data[i];
        out.names.push(n); out.bits.push(pl.bits); out.inkIsOne.push(pl.inkIsOne); out.stride = pl.stride;
      });
    }
    return { result: out, transfer: out.bits.map((b) => b.buffer) };
  },
};

self.onmessage = async (e) => {
  const { id, cmd, ...args } = e.data;
  try {
    const r = await jobs[cmd || "plates"](args, (msg) => self.postMessage({ id, progress: msg }));
    self.postMessage({ id, result: r.result }, r.transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
self.postMessage({ ready: true });
