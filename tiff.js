// Reads the uncompressed 8-bit greyscale TIFF plates Ghostscript writes
// (tiffsep with -sCompression=none) and returns ink coverage 0..255.
export function plateFromTiff(buf, opts = {}) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = type === 3 ? 2 : 4;
    const base = count * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let k = 0; k < count; k++) vals.push(size === 2 ? u16(base + k * 2) : u32(base + k * 4));
    tags[tag] = vals;
  }
  const w = tags[256][0], h = tags[257][0];
  if ((tags[259]?.[0] ?? 1) !== 1) throw new Error("Compressed TIFF plate not supported");
  const bps = tags[258]?.[0] ?? 1;
  if (bps !== 8 && bps !== 1) throw new Error("Unsupported plate bit depth " + bps);
  const blackIsZero = (tags[262]?.[0] ?? 1) === 1; // film look: dark = ink
  const stride = bps === 8 ? w : Math.ceil(w / 8);
  const raw = new Uint8Array(stride * h);
  let p = 0;
  tags[273].forEach((off, s) => {
    const len = Math.min(tags[279][s], raw.length - p);
    raw.set(new Uint8Array(buf.buffer, buf.byteOffset + off, len), p);
    p += len;
  });
  let out = raw;
  if (bps === 1 && opts.packed) return { w, h, stride, bits: raw, inkIsOne: !blackIsZero }; // 1 bit per pixel, kept compact
  if (bps === 1) { // halftone dots: expand to 0/255
    out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (raw[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  }
  if (blackIsZero) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return { w, h, data: out };
}
