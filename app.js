// Prepress for iPad: main thread (UI, gestures, compositing).
import { PROCESS_INKS, FALLBACK_RGB, PT_TO_MM } from "./pdfcore.js";

const $ = (id) => document.getElementById(id);
const MAX_PIXELS = 12e6; // stay under iPadOS canvas limits
const BOX_STYLE = {
  MediaBox: ["#8c8c8c", ""], CropBox: ["#505050", "2 3"], BleedBox: ["#dc2828", "6 4"],
  TrimBox: ["#00a03c", ""], ArtBox: ["#285ade", "8 3 2 3"],
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ------------------------------------------------------------------ workers
function rpcWorker(url) {
  const w = new Worker(url, { type: "module" });
  const waiting = new Map();
  let seq = 0, markReady;
  const ready = new Promise((r) => (markReady = r));
  w.onmessage = (e) => {
    if (e.data && e.data.ready) return markReady();
    const { id, result, error } = e.data;
    if (!waiting.has(id)) return;
    const { res, rej } = waiting.get(id);
    waiting.delete(id);
    error ? rej(new Error(error)) : res(result);
  };
  w.onerror = (e) => { for (const { rej } of waiting.values()) rej(new Error(e.message || "Worker failed to load")); waiting.clear(); };
  return (payload, transfer = []) => ready.then(() => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    w.postMessage({ id, ...payload }, transfer);
  }));
}
const engine = rpcWorker("engine-worker.js");
const call = (cmd, args, transfer) => engine({ cmd, args }, transfer);
let sepsCall = null; // created on first use (Ghostscript is large)

// ------------------------------------------------------------------ state
const S = {
  name: "", bytes: null, version: 0, gsVersion: -1, pages: 0, page: 0,
  boxes: null, rotation: 0, spots: {}, dpi: 150, effDpi: 150, w: 0, h: 0,
  plates: null, enabled: new Set(), sepsOn: false, densOn: false, boxesOn: true,
  z: 1, tx: 0, ty: 0, dirty: false, baseRGBA: null,
};

// ------------------------------------------------------------------ helpers
function busy(msg) { $("busymsg").textContent = msg; $("busy").style.display = msg ? "grid" : "none"; }
function dialog(title, html, actions) {
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = html;
  const acts = $("dlgActs");
  acts.innerHTML = "";
  for (const [label, fn, cls] of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = async () => { if (fn) { const keep = await fn(); if (keep) return; } $("dlg").close(); };
    acts.appendChild(b);
  }
  $("dlg").showModal();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function inkRGB(name) {
  if (PROCESS_INKS[name]) return PROCESS_INKS[name];
  if (S.spots[name]) return S.spots[name];
  const k = Object.keys(S.spots).find((n) => n.toLowerCase() === name.toLowerCase() && S.spots[n]);
  return k ? S.spots[k] : FALLBACK_RGB;
}
function setDirty(d) { S.dirty = d; $("save").classList.toggle("dirty", d); }
function enable(on) { for (const id of ["save", "prev", "next", "fit", "seps", "dens", "boxesBtn", "dpi"]) $(id).disabled = !on; }

// ------------------------------------------------------------------ open
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  busy("Opening " + f.name + "…");
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const info = await call("open", { bytes: buf.slice().buffer });
    Object.assign(S, { name: f.name, bytes: buf, version: S.version + 1, pages: info.pages, page: 0, plates: null });
    $("report").textContent = info.report.join("\n") + (info.incremental ? "" : "\n\n⚠ File needs repair: saves will be full rewrites.");
    $("empty").style.display = "none";
    enable(true);
    setDirty(false);
    await loadPage(0, true);
  } catch (err) {
    dialog("Could not open file", esc(err.message), [["OK"]]);
  } finally { busy(""); }
});

async function loadPage(i, fit) {
  S.page = i;
  $("pageinfo").textContent = `${i + 1} / ${S.pages}`;
  const p = await call("page", { i });
  Object.assign(S, { boxes: p.boxes, rotation: p.rotation, spots: p.spots });
  await render(fit);
  buildBoxEditor();
}

async function render(fit) {
  const mb = S.boxes.MediaBox;
  const wpt = mb[2] - mb[0], hpt = mb[3] - mb[1];
  S.effDpi = Math.min(S.dpi, Math.floor(72 * Math.sqrt(MAX_PIXELS / (wpt * hpt))));
  const oldW = S.w;
  busy(S.sepsOn ? "Separating plates…" : "Rendering…");
  try {
    if (S.sepsOn) {
      if (!sepsCall) { busy("Loading separation engine (first time only)…"); sepsCall = rpcWorker("seps-worker.js"); }
      const send = S.gsVersion !== S.version ? S.bytes.slice() : null;
      const r = await sepsCall({ bytes: send ? send.buffer : null, page: S.page, dpi: S.effDpi }, send ? [send.buffer] : []);
      S.gsVersion = S.version;
      const known = S.plates ? new Set(S.plates.names) : null; // keep on/off state for inks seen before
      S.enabled = new Set(r.names.filter((n) => !known || !known.has(n) || S.enabled.has(n)));
      S.plates = { names: r.names, w: r.w, h: r.h, data: r.data };
      S.w = r.w; S.h = r.h;
      drawComposite();
    } else {
      S.plates = null;
      const r = await call("render", { i: S.page, dpi: S.effDpi });
      S.w = r.w; S.h = r.h;
      const c = $("page");
      c.width = r.w; c.height = r.h;
      c.getContext("2d").putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
    }
  } catch (err) {
    if (S.sepsOn) { S.sepsOn = false; $("seps").classList.remove("on"); }
    dialog("Rendering problem", esc(err.message), [["OK"]]);
    return;
  } finally { busy(""); }
  drawBoxes();
  buildInks();
  if (fit || !oldW) fitView();
  else { const f = oldW / S.w; S.z *= f; applyView(); }
  $("dpi").title = S.effDpi < S.dpi ? `Limited to ${S.effDpi} dpi for this page size` : "Preview resolution";
}

function drawComposite() {
  const { w, h, names, data } = S.plates;
  const out = new ImageData(w, h), d = out.data, n = w * h;
  const acc = new Float32Array(n * 3).fill(1);
  names.forEach((name, k) => {
    if (!S.enabled.has(name)) return;
    const [r, g, b] = inkRGB(name);
    const kr = 1 - r / 255, kg = 1 - g / 255, kb = 1 - b / 255, cov = data[k];
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const c = cov[i];
      if (!c) continue;
      const t = c / 255;
      acc[j] *= 1 - t * kr; acc[j + 1] *= 1 - t * kg; acc[j + 2] *= 1 - t * kb;
    }
  });
  for (let i = 0, j = 0, q = 0; i < n; i++, j += 3) {
    d[q++] = acc[j] * 255; d[q++] = acc[j + 1] * 255; d[q++] = acc[j + 2] * 255; d[q++] = 255;
  }
  const c = $("page");
  c.width = w; c.height = h;
  c.getContext("2d").putImageData(out, 0, 0);
}

function drawBoxes() {
  const svg = $("boxes");
  svg.setAttribute("width", S.w); svg.setAttribute("height", S.h);
  svg.setAttribute("viewBox", `0 0 ${S.w} ${S.h}`);
  svg.innerHTML = "";
  if (!S.boxesOn || S.rotation) return;
  const mb = S.boxes.MediaBox, s = S.w / (mb[2] - mb[0]);
  for (const [name, b] of Object.entries(S.boxes)) {
    const [col, dash] = BOX_STYLE[name];
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", (b[0] - mb[0]) * s); r.setAttribute("y", (mb[3] - b[3]) * s);
    r.setAttribute("width", (b[2] - b[0]) * s); r.setAttribute("height", (b[3] - b[1]) * s);
    r.setAttribute("fill", "none"); r.setAttribute("stroke", col); r.setAttribute("stroke-width", "1.5");
    r.setAttribute("vector-effect", "non-scaling-stroke");
    if (dash) r.setAttribute("stroke-dasharray", dash);
    svg.appendChild(r);
  }
}

// ------------------------------------------------------------------ inspector
function buildInks() {
  const box = $("inks");
  box.innerHTML = "";
  const names = S.plates ? S.plates.names : [...Object.keys(PROCESS_INKS), ...Object.keys(S.spots)];
  if (!S.plates) box.insertAdjacentHTML("beforeend", `<div class="hint">Turn on Separations to switch plates on and off and read ink values.</div>`);
  for (const n of names) {
    const [r, g, b] = inkRGB(n);
    const row = document.createElement("label");
    row.className = "ink";
    row.innerHTML = `<span class="sw" style="background:rgb(${r},${g},${b})"></span><span class="nm">${esc(n)}</span>`;
    if (S.plates) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = S.enabled.has(n);
      cb.onchange = () => { cb.checked ? S.enabled.add(n) : S.enabled.delete(n); drawComposite(); };
      row.appendChild(cb);
    }
    box.appendChild(row);
  }
  if (S.plates) {
    const acts = document.createElement("div");
    acts.className = "row";
    const all = document.createElement("button"); all.textContent = "All on";
    all.onclick = () => { S.enabled = new Set(S.plates.names); buildInks(); drawComposite(); };
    const none = document.createElement("button"); none.textContent = "All off";
    none.onclick = () => { S.enabled.clear(); buildInks(); drawComposite(); };
    acts.append(all, none);
    box.appendChild(acts);
  }
}

function buildBoxEditor() {
  const el = $("boxedit");
  const mb = S.boxes.MediaBox;
  const f = (v) => (v * PT_TO_MM).toFixed(2);
  let html = `<div class="boxrow boxhead"><span></span><span>Left</span><span>Bottom</span><span>Right</span><span>Top</span></div>`;
  for (const name of ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"]) {
    const b = S.boxes[name];
    const ro = name === "MediaBox" ? "readonly" : "";
    const vals = b ? [b[0] - mb[0], b[1] - mb[1], b[2] - mb[0], b[3] - mb[1]].map(f) : ["", "", "", ""];
    html += `<div class="boxrow"><span class="lbl"><i style="background:${BOX_STYLE[name][0]}"></i>${name.replace("Box", "")}</span>` +
      vals.map((v, k) => `<input inputmode="decimal" data-box="${name}" data-k="${k}" value="${v}" ${ro} placeholder="–">`).join("") + `</div>`;
  }
  html += `<div class="row"><button id="applyBoxes">Apply boxes</button></div>
    <div class="row"><span>Bleed</span><input id="bleedMM" inputmode="decimal" value="3"><span>mm around trim</span><button id="applyBleed">Set</button></div>`;
  el.innerHTML = html;
  $("applyBoxes").onclick = applyBoxEdits;
  $("applyBleed").onclick = async () => {
    const t = S.boxes.TrimBox;
    const mmv = parseFloat($("bleedMM").value.replace(",", "."));
    if (!t || !(mmv >= 0)) return dialog("Bleed", "The page needs a trim box and a bleed of 0 mm or more.", [["OK"]]);
    const d = mmv / PT_TO_MM;
    await setBox("BleedBox", [t[0] - d, t[1] - d, t[2] + d, t[3] + d]);
  };
}

async function applyBoxEdits() {
  const mb = S.boxes.MediaBox;
  for (const name of ["CropBox", "BleedBox", "TrimBox", "ArtBox"]) {
    const inputs = [...document.querySelectorAll(`input[data-box="${name}"]`)];
    const raw = inputs.map((i) => i.value.trim().replace(",", "."));
    if (raw.every((v) => v === "")) continue;
    const v = raw.map(parseFloat);
    if (v.some((x) => !Number.isFinite(x))) return dialog("Page boxes", `${name}: fill in all four values.`, [["OK"]]);
    const rect = [mb[0] + v[0] / PT_TO_MM, mb[1] + v[1] / PT_TO_MM, mb[0] + v[2] / PT_TO_MM, mb[1] + v[3] / PT_TO_MM];
    const cur = S.boxes[name];
    if (cur && rect.every((x, k) => Math.abs(x - cur[k]) < 0.001)) continue;
    await setBox(name, rect, true);
  }
  buildBoxEditor();
}

async function setBox(name, rect, quiet) {
  try {
    const r = await call("setBox", { i: S.page, name, rect });
    S.boxes = r.boxes;
    $("report").textContent = r.report.join("\n");
    setDirty(true);
    drawBoxes();
    if (!quiet) buildBoxEditor();
  } catch (err) { dialog("Page boxes", esc(err.message), [["OK"]]); }
}

// ------------------------------------------------------------------ save
$("save").onclick = async () => {
  busy("Saving and verifying…");
  let r;
  try { r = await call("save"); } catch (err) { busy(""); return dialog("Save failed", esc(err.message), [["OK"]]); }
  busy("");
  const bytes = new Uint8Array(r.bytes);
  if (r.mode !== "unchanged") { S.bytes = bytes; S.version++; }
  setDirty(false);
  const base = S.name.replace(/\.pdf$/i, "");
  const fname = r.mode === "unchanged" ? S.name : `${base}_edit.pdf`;
  let msg;
  if (r.mode === "unchanged") msg = `<p class="good">No edits, so this is a byte-identical copy of the original.</p>`;
  else {
    msg = r.prefixOK
      ? `<p class="good">Original file bytes kept exactly; your edits are appended after them.</p>`
      : `<p class="warn">This file needed repair, so it was fully rewritten. Check the list below carefully.</p>`;
    msg += `<p>Changes compared with the file you opened (${r.diffs.length}):</p><ul class="diffs">${r.diffs.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
  }
  dialog("Ready to save", msg + `<p class="hint">File: ${esc(fname)}</p>`, [
    ["Cancel"],
    ["Save to Files / Share", async () => { await share(bytes, fname); }, "on"],
  ]);
};

async function share(bytes, fname) {
  const file = new File([bytes], fname, { type: "application/pdf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

// ------------------------------------------------------------------ toolbar
$("prev").onclick = () => S.page > 0 && loadPage(S.page - 1, true);
$("next").onclick = () => S.page < S.pages - 1 && loadPage(S.page + 1, true);
$("fit").onclick = fitView;
$("seps").onclick = () => { S.sepsOn = !S.sepsOn; $("seps").classList.toggle("on", S.sepsOn); render(false); };
$("dens").onclick = () => { S.densOn = !S.densOn; $("dens").classList.toggle("on", S.densOn); if (!S.densOn) $("cross").style.display = "none"; };
$("boxesBtn").onclick = () => { S.boxesOn = !S.boxesOn; $("boxesBtn").classList.toggle("on", S.boxesOn); drawBoxes(); };
$("dpi").onchange = () => { S.dpi = +$("dpi").value; render(false); };
$("panel").onclick = () => { const h = $("aside").classList.toggle("hidden"); $("panel").classList.toggle("on", !h); };
if (window.innerWidth <= 900) { $("aside").classList.add("hidden"); $("panel").classList.remove("on"); }

// ------------------------------------------------------------------ view + gestures
const stage = $("stage");
function applyView() { $("sheet").style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.z})`; }
function fitView() {
  if (!S.w) return;
  const r = stage.getBoundingClientRect();
  S.z = Math.min((r.width - 24) / S.w, (r.height - 24) / S.h);
  S.tx = (r.width - S.w * S.z) / 2;
  S.ty = (r.height - S.h * S.z) / 2;
  applyView();
}
function zoomAt(f, cx, cy) {
  const nz = Math.min(Math.max(S.z * f, 0.02), 40);
  S.tx = cx - (cx - S.tx) * (nz / S.z);
  S.ty = cy - (cy - S.ty) * (nz / S.z);
  S.z = nz;
  applyView();
}
const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const pts = new Map();
let pinch = null, lastTap = 0, moved = 0;

stage.addEventListener("pointerdown", (e) => {
  if (!S.w) return;
  stage.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, local(e));
  moved = 0;
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  } else if (S.densOn) readAt(local(e));
});
stage.addEventListener("pointermove", (e) => {
  if (!S.w) return;
  const p = local(e);
  if (!pts.has(e.pointerId)) { if (e.pointerType !== "touch") readAt(p, true); return; } // Pencil hover / trackpad
  const prev = pts.get(e.pointerId);
  pts.set(e.pointerId, p);
  if (pts.size >= 2 && pinch) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.tx += mx - pinch.mx; S.ty += my - pinch.my;
    zoomAt(d / pinch.d, mx, my);
    pinch = { d, mx, my };
  } else if (pts.size === 1) {
    if (S.densOn) readAt(p);
    else { S.tx += p.x - prev.x; S.ty += p.y - prev.y; applyView(); }
  }
  moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
});
const end = (e) => {
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (e.type === "pointerup" && e.pointerType === "touch" && moved < 8 && !S.densOn) {
    const now = Date.now();
    if (now - lastTap < 300) fitView();
    lastTap = now;
  }
};
stage.addEventListener("pointerup", end);
stage.addEventListener("pointercancel", end);
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = local(e);
  if (e.ctrlKey) zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
  else { S.tx -= e.deltaX; S.ty -= e.deltaY; applyView(); }
}, { passive: false });
let gz = 1; // Safari trackpad pinch
stage.addEventListener("gesturestart", (e) => { e.preventDefault(); gz = 1; });
stage.addEventListener("gesturechange", (e) => { e.preventDefault(); const p = local(e); zoomAt(e.scale / gz, p.x, p.y); gz = e.scale; });
document.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("resize", () => S.w && fitView());

// ------------------------------------------------------------------ densitometer
function readAt(p, hover) {
  const ix = Math.floor((p.x - S.tx) / S.z), iy = Math.floor((p.y - S.ty) / S.z);
  const cross = $("cross");
  if (ix < 0 || iy < 0 || ix >= S.w || iy >= S.h) { cross.style.display = "none"; return; }
  cross.style.display = S.densOn || hover ? "block" : "none";
  cross.style.left = p.x + "px"; cross.style.top = p.y + "px";
  const mb = S.boxes.MediaBox, t = S.boxes.TrimBox || mb, s = S.w / (mb[2] - mb[0]);
  const xpt = mb[0] + (ix + 0.5) / s, ypt = mb[3] - (iy + 0.5) / s;
  let html = `<span><span class="k">x</span> ${((xpt - t[0]) * PT_TO_MM).toFixed(2)} mm</span><span><span class="k">y</span> ${((ypt - t[1]) * PT_TO_MM).toFixed(2)} mm</span><span class="k">from trim</span>`;
  if (S.plates) {
    let tac = 0;
    const parts = [];
    S.plates.names.forEach((n, k) => {
      const v = S.plates.data[k][iy * S.w + ix] / 2.55;
      tac += v;
      if (v >= 0.5) { const [r, g, b] = inkRGB(n); parts.push(`<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:rgb(${r},${g},${b})"></i> ${esc(n)} ${v.toFixed(0)}%</span>`); }
    });
    html += parts.length ? parts.join("") : `<span class="k">no ink</span>`;
    html += `<span><span class="k">TAC</span> ${tac.toFixed(0)}%</span>`;
  } else html += `<span class="k">Turn on Separations for ink values</span>`;
  $("readout").innerHTML = html;
}
