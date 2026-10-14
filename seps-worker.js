// Separations worker: Ghostscript (WebAssembly) renders one plate per ink,
// handling overprint like a RIP. Loaded only when separations are first used.
import createGS from "./gs.mjs";
import { plateFromTiff } from "./tiff.js";

const PROCESS = ["Cyan", "Magenta", "Yellow", "Black"];
let gsReady = null;
let errLog = [];

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

self.onmessage = async (e) => {
  const { id, bytes, page, dpi } = e.data;
  try {
    const gs = await getGS();
    if (bytes) gs.FS.writeFile("/in.pdf", new Uint8Array(bytes));
    try { gs.FS.mkdir("/out"); } catch {}
    for (const f of gs.FS.readdir("/out")) if (f !== "." && f !== "..") gs.FS.unlink("/out/" + f);
    errLog = [];
    const rc = gs.callMain([
      "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=tiffsep", "-sCompression=none",
      `-r${dpi}`, `-dFirstPage=${page + 1}`, `-dLastPage=${page + 1}`,
      "-sOutputFile=/out/p.tif", "/in.pdf",
    ]);
    if (rc !== 0) throw new Error(errLog.join("\n") || `Ghostscript failed (${rc})`);
    const plates = {};
    let w = 0, h = 0;
    for (const f of gs.FS.readdir("/out")) {
      const m = f.match(/^p\((.+)\)\.tif$/);
      if (!m) continue;
      const p = plateFromTiff(gs.FS.readFile("/out/" + f));
      plates[m[1]] = p.data;
      w = p.w; h = p.h;
      gs.FS.unlink("/out/" + f);
    }
    const names = [...PROCESS.filter((n) => n in plates), ...Object.keys(plates).filter((n) => !PROCESS.includes(n)).sort()];
    const data = names.map((n) => plates[n]);
    self.postMessage({ id, result: { names, w, h, data } }, data.map((d) => d.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
self.postMessage({ ready: true });
