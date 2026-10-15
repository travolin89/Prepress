// Prepress for iPad: main thread (UI, gestures, compositing).
import { PROCESS_INKS, FALLBACK_RGB, PT_TO_MM } from "./pdfcore.js";
import { inkND } from "./trap.js";

const $ = (id) => document.getElementById(id);
const MAX_PIXELS = 12e6; // stay under iPadOS canvas limits
const BOX_STYLE = {
  MediaBox: ["#8c8c8c", ""], CropBox: ["#505050", "2 3"], BleedBox: ["#dc2828", "6 4"],
  TrimBox: ["#00a03c", ""], ArtBox: ["#285ade", "8 3 2 3"],
};
const SVGNS = "http://www.w3.org/2000/svg";

export const APP_VERSION = "5";
// Updates: check for a new version on every launch and reload into it
// (unless a file is open, so unsaved work is never lost).
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    if (typeof S !== "undefined" && S.open) {
      dialog("Update ready", "<p>A new version of the app has been downloaded. Save your work, then reload to use it.</p>", [["Later"], ["Reload now", () => location.reload(), "on"]]);
      return;
    }
    reloading = true;
    location.reload();
  });
}

// ------------------------------------------------------------------ workers
function rpcWorker(url) {
  const w = new Worker(url, { type: "module" });
  const waiting = new Map();
  let seq = 0, markReady;
  const ready = new Promise((r) => (markReady = r));
  w.onmessage = (e) => {
    if (e.data && e.data.ready) return markReady();
    const { id, result, error, progress } = e.data;
    if (!waiting.has(id)) return;
    if (progress) { waiting.get(id).onProgress?.(progress); return; }
    const { res, rej } = waiting.get(id);
    waiting.delete(id);
    error ? rej(new Error(error)) : res(result);
  };
  w.onerror = (e) => { for (const { rej } of waiting.values()) rej(new Error(e.message || "Worker failed to load")); waiting.clear(); };
  return (payload, transfer = [], onProgress) => ready.then(() => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej, onProgress });
    w.postMessage({ id, ...payload }, transfer);
  }));
}
const engine = rpcWorker("engine-worker.js");
const call = (cmd, args, transfer) => engine({ cmd, args }, transfer);
let gsCall = null; // Ghostscript worker, created on first use
const seps = (payload, transfer, onProgress) => { if (!gsCall) gsCall = rpcWorker("seps-worker.js"); return gsCall(payload, transfer, onProgress); };

// ------------------------------------------------------------------ state
const S = {
  name: "", pages: 0, page: 0, open: false,
  boxes: null, rotation: 0, spots: {}, docInks: [], dpi: 150, effDpi: 150, w: 0, h: 0,
  plates: null, enabled: new Set(), sepsOn: false, boxesOn: true,
  mode: "pan", objects: [], sels: [], edits: 0, ver: 0, gsVer: -1,
  z: 1, tx: 0, ty: 0, highlights: [], issues: [], bcTypes: [], layers: [], fonts: [],
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
const oops = (title, err) => dialog(title, esc(err.message || err), [["OK"]]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (id, dflt) => { const el = typeof id === "string" ? $(id) : id; const v = parseFloat(String(el.value).replace(",", ".")); return Number.isFinite(v) ? v : dflt; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function inkRGB(name) {
  if (PROCESS_INKS[name]) return PROCESS_INKS[name];
  if (S.spots[name]) return S.spots[name];
  const k = Object.keys(S.spots).find((n) => n.toLowerCase() === name.toLowerCase() && S.spots[n]);
  return k ? S.spots[k] : FALLBACK_RGB;
}
function setEdits(n) {
  S.edits = n;
  $("save").classList.toggle("dirty", n > 0);
  $("undo").disabled = !S.open || n === 0;
}
function enable(on) {
  for (const id of ["save", "prev", "next", "fit", "seps", "mPan", "mSel", "mMeas", "boxesBtn", "dpi", "covBtn", "pfRun", "bcAdd", "bcTap", "newLayerBtn", "unlockAll", "txTap", "txAdd", "trPage", "trAll", "trRemove", "scApply", "scPreview"]) $(id).disabled = !on;
  setEdits(S.edits);
}
const mm = (pt) => (pt * PT_TO_MM).toFixed(2);
const pxPerPt = () => S.w / (S.boxes.MediaBox[2] - S.boxes.MediaBox[0]);
const toPx = (b) => { const mb = S.boxes.MediaBox, s = pxPerPt(); return [(b[0] - mb[0]) * s, (mb[3] - b[3]) * s, (b[2] - b[0]) * s, (b[3] - b[1]) * s]; };
const trimOrigin = () => (S.boxes.TrimBox || S.boxes.MediaBox);
const union = (bbs) => bbs.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);

// ------------------------------------------------------------------ fonts (kept on this iPad)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("prepress", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("fonts");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function storedFonts() {
  const db = await idb();
  return new Promise((res) => {
    const out = [];
    const req = db.transaction("fonts").objectStore("fonts").openCursor();
    req.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    req.onerror = () => res(out);
  });
}
async function storeFont(name, data) {
  const db = await idb();
  return new Promise((res) => { const tx = db.transaction("fonts", "readwrite"); tx.objectStore("fonts").put({ name, data }, name); tx.oncomplete = res; tx.onerror = res; });
}
async function loadFonts() {
  try { for (const f of await storedFonts()) { const copy = f.data.slice(0); await call("registerFont", { data: copy }, [copy]); } } catch {}
  await refreshFontLists();
}
async function refreshFontLists() {
  const f = await call("fonts");
  S.fonts = [...f.builtin, ...f.imported];
  for (const sel of [$("txFont"), ...document.querySelectorAll(".fontSel")]) fillFontSelect(sel);
}
function fillFontSelect(sel, value) {
  const keep = value ?? sel.value;
  sel.innerHTML = S.fonts.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}${f.id.startsWith("u:") ? " (imported)" : ""}</option>`).join("");
  if (keep && S.fonts.some((f) => f.id === keep)) sel.value = keep;
}
$("fontFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  busy("Importing font…");
  try {
    const data = await file.arrayBuffer();
    const keep = data.slice(0);
    const r = await call("registerFont", { data }, [data]);
    await storeFont(r.name, keep);
    await refreshFontLists();
    $("txFont").value = r.id;
    busy("");
    dialog("Font imported", `<p><b>${esc(r.name)}</b> is ready and will stay on this iPad.</p>`, [["OK"]]);
  } catch (err) { busy(""); oops("Font not imported", err); }
});
loadFonts();

// ------------------------------------------------------------------ open
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  busy("Opening " + f.name + "…");
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const info = await call("open", { bytes: buf.buffer }, [buf.buffer]);
    Object.assign(S, { name: f.name, pages: info.pages, page: 0, plates: null, open: true, docInks: info.inks, sels: [], issues: [], highlights: [] });
    S.ver++;
    $("report").textContent = `App version ${APP_VERSION}\n\n` + info.report.join("\n") + (info.incremental ? "" : "\n\n⚠ File needs repair: saves will be full rewrites.");
    $("empty").style.display = "none";
    $("pfOut").innerHTML = ""; $("cov").innerHTML = "";
    setEdits(0);
    enable(true);
    if (!S.bcTypes.length) { S.bcTypes = await call("barcodeTypes"); fillBarcodeTypes(); }
    for (const sel of [$("bcInk"), $("txInk")]) fillInkSelect(sel);
    S.layers = await call("layers");
    buildLayers();
    await loadPage(0, true);
    buildTrapInks(); buildScreens(); buildLinks();
  } catch (err) { oops("Could not open file", err); }
  finally { busy(""); }
});

async function loadPage(i, fit) {
  S.page = i;
  S.sels = [];
  S.highlights = S.highlights.filter((h) => h.page === i);
  $("pageinfo").textContent = `${i + 1} / ${S.pages}`;
  const p = await call("page", { i });
  Object.assign(S, { boxes: p.boxes, rotation: p.rotation, spots: p.spots });
  S.objects = await call("objects", { i });
  await render(fit);
  buildBoxEditor();
  buildSelCard();
}

// ------------------------------------------------------------------ separations (Ghostscript)
async function getPlates(page, dpi) {
  let bytes = null;
  if (S.gsVer !== S.ver) { const snap = await call("snapshot"); bytes = new Uint8Array(snap); }
  const r = await seps({ bytes: bytes ? bytes.buffer : null, page, dpi }, bytes ? [bytes.buffer] : []);
  S.gsVer = S.ver;
  return r;
}

async function render(fit) {
  const mb = S.boxes.MediaBox;
  const wpt = mb[2] - mb[0], hpt = mb[3] - mb[1];
  S.effDpi = Math.min(S.dpi, Math.floor(72 * Math.sqrt(MAX_PIXELS / (wpt * hpt))));
  const oldW = S.w;
  busy(S.sepsOn ? "Separating plates…" : "Rendering…");
  try {
    if (S.sepsOn) {
      if (!gsCall) busy("Loading separation engine (first time only)…");
      const r = await getPlates(S.page, S.effDpi);
      const known = S.plates ? new Set(S.plates.names) : null;
      S.enabled = new Set(r.names.filter((n) => !known || !known.has(n) || S.enabled.has(n)));
      S.plates = { names: r.names, w: r.w, h: r.h, data: r.data, page: S.page, ver: S.ver };
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
    oops("Rendering problem", err);
    return;
  } finally { busy(""); }
  drawOverlay();
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
  for (let i = 0, j = 0, q = 0; i < n; i++, j += 3) { d[q++] = acc[j] * 255; d[q++] = acc[j + 1] * 255; d[q++] = acc[j + 2] * 255; d[q++] = 255; }
  const c = $("page");
  c.width = w; c.height = h;
  c.getContext("2d").putImageData(out, 0, 0);
}

// ------------------------------------------------------------------ overlay (boxes, selection, highlights)
let drag = null;    // moving the selection: { start, dx, dy } (image px)
let marquee = null; // selecting by area: { x0, y0, x1, y1 } (image px)
function rect(svg, r, stroke, dash, extra = {}) {
  const el = document.createElementNS(SVGNS, "rect");
  el.setAttribute("x", r[0]); el.setAttribute("y", r[1]); el.setAttribute("width", Math.max(r[2], 0.5)); el.setAttribute("height", Math.max(r[3], 0.5));
  el.setAttribute("fill", extra.fill || "none"); el.setAttribute("stroke", stroke); el.setAttribute("stroke-width", extra.width || "1.5");
  el.setAttribute("vector-effect", "non-scaling-stroke");
  if (dash) el.setAttribute("stroke-dasharray", dash);
  svg.appendChild(el);
}
function drawOverlay() {
  const svg = $("boxes");
  svg.setAttribute("width", S.w); svg.setAttribute("height", S.h);
  svg.setAttribute("viewBox", `0 0 ${S.w} ${S.h}`);
  svg.innerHTML = "";
  if (!S.boxes || S.rotation) return;
  if (S.boxesOn) for (const [name, b] of Object.entries(S.boxes)) rect(svg, toPx(b), BOX_STYLE[name][0], BOX_STYLE[name][1]);
  for (const h of S.highlights) if (h.page === S.page && h.rect) rect(svg, toPx(h.rect), "#ff9f0a", "", { fill: "rgba(255,159,10,.18)", width: "2" });
  const sel = S.sels.map((k) => S.objects[k]).filter(Boolean);
  if (sel.length) {
    for (const o of sel) rect(svg, toPx(o.bbox), "#3d8bfd", sel.length > 1 ? "3 3" : "", { width: "1.5" });
    const r = toPx(union(sel.map((o) => o.bbox)));
    if (sel.length > 1) rect(svg, r, "#3d8bfd", "", { width: "2" });
    if (drag) rect(svg, [r[0] + drag.dx, r[1] + drag.dy, r[2], r[3]], "#3d8bfd", "5 4", { fill: "rgba(61,139,253,.12)", width: "2" });
  }
  if (marquee) rect(svg, [Math.min(marquee.x0, marquee.x1), Math.min(marquee.y0, marquee.y1), Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0)], "#3d8bfd", "4 3", { fill: "rgba(61,139,253,.08)" });
}

// ------------------------------------------------------------------ inks tab + coverage
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

function areaStats(pl, region, mb) {
  const s = pl.w / (mb[2] - mb[0]);
  const x0 = Math.max(0, Math.floor((region[0] - mb[0]) * s)), x1 = Math.min(pl.w, Math.ceil((region[2] - mb[0]) * s));
  const y0 = Math.max(0, Math.floor((mb[3] - region[3]) * s)), y1 = Math.min(pl.h, Math.ceil((mb[3] - region[1]) * s));
  const sums = pl.names.map(() => 0);
  let maxT = 0, maxAt = null, n = 0, over = 0;
  const lim = num("pfTAC", 300) * 2.55;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * pl.w + x;
      let t = 0;
      for (let k = 0; k < pl.data.length; k++) { const v = pl.data[k][i]; sums[k] += v; t += v; }
      if (t > maxT) { maxT = t; maxAt = [x, y]; }
      if (t > lim) over++;
      n++;
    }
  }
  return { mean: sums.map((v) => (n ? v / n / 2.55 : 0)), maxTAC: maxT / 2.55, maxAt, overArea: over / (s * s), s };
}

$("covBtn").onclick = async () => {
  busy("Measuring ink coverage…");
  try {
    const pl = S.plates && S.plates.ver === S.ver && S.plates.page === S.page ? S.plates : await getPlates(S.page, Math.min(100, S.effDpi));
    const region = S.boxes.TrimBox || S.boxes.MediaBox;
    const st = areaStats(pl, region, S.boxes.MediaBox);
    const areaCm2 = ((region[2] - region[0]) * (region[3] - region[1]) * PT_TO_MM * PT_TO_MM) / 100;
    let html = `<table class="cov"><tr><th>Ink</th><th>Coverage</th><th>Solid cm²</th></tr>`;
    pl.names.forEach((n, k) => {
      const [r, g, b] = inkRGB(n);
      const pct = st.mean[k];
      html += `<tr><td>${esc(n)}<div class="bar"><i style="width:${Math.min(pct, 100)}%;background:rgb(${r},${g},${b})"></i></div></td><td>${pct.toFixed(1)}%</td><td>${((pct / 100) * areaCm2).toFixed(1)}</td></tr>`;
    });
    html += `</table><div class="hint">Area ${areaCm2.toFixed(1)} cm² · highest total ink ${st.maxTAC.toFixed(0)}%</div>`;
    $("cov").innerHTML = html;
  } catch (err) { oops("Coverage", err); }
  finally { busy(""); }
};

// ------------------------------------------------------------------ inks for selects
function inkOptions() {
  const process = ["Black", "Cyan", "Magenta", "Yellow"];
  return [...process, ...S.docInks.filter((n) => !process.includes(n)), "＋ New spot…"];
}
function fillInkSelect(sel, value) {
  const keep = value ?? sel.value;
  sel.innerHTML = inkOptions().map((n) => `<option>${esc(n)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function readInk(sel, nameEl, cmykEl) {
  if (!sel.value.startsWith("＋")) return { name: sel.value };
  const name = nameEl.value.trim();
  const cmyk = cmykEl.value.trim().split(/[\s,]+/).map(Number);
  if (!name || cmyk.length !== 4 || cmyk.some((v) => !(v >= 0 && v <= 100))) throw new Error("Give the new spot a name and four CMYK values from 0 to 100.");
  return { name, cmyk };
}
function inkBlock(prefix, value, tint) {
  return `<label>Ink<select id="${prefix}Ink"></select></label><label>Tint %<input id="${prefix}Tint" inputmode="decimal" value="${tint ?? 100}"></label>
    <div class="grid2 span2" id="${prefix}New" hidden style="grid-column:span 2"><label class="span2">New spot name<input id="${prefix}Name" value="New spot"></label><label class="span2">Screen colour (C M Y K %)<input id="${prefix}CMYK" value="0 0 0 50"></label></div>`;
}
function wireInk(prefix, value) {
  fillInkSelect($(prefix + "Ink"), value);
  $(prefix + "Ink").onchange = () => { $(prefix + "New").hidden = !$(prefix + "Ink").value.startsWith("＋"); };
}
const inkOf = (prefix) => readInk($(prefix + "Ink"), $(prefix + "Name"), $(prefix + "CMYK"));
const tintOf = (prefix) => clamp(num(prefix + "Tint", 100), 0, 100);

// ------------------------------------------------------------------ selection
const selectable = (o) => o && !o.clip && !o.trap && !o.locked && !o.layerLocked && !o.layerHidden;
function expandGroups(ks) {
  const out = new Set(ks);
  for (const k of ks) { const g = S.objects[k]?.group; if (g) S.objects.forEach((o) => { if (o.group === g && selectable(o)) out.add(o.k); }); }
  return [...out].sort((a, b) => a - b);
}
function setSelection(ks) {
  S.sels = ks;
  drawOverlay();
  buildSelCard();
  const sel = ks.map((k) => S.objects[k]);
  $("readout").innerHTML = sel.length === 1 ? `<span>${esc(sel[0].desc)}</span>` : sel.length ? `<span>${sel.length} objects selected</span>` : `<span class="k">Nothing selected</span>`;
}

// ------------------------------------------------------------------ edit tab
function buildSelCard() {
  const box = $("selCard");
  const lockedCount = S.objects.filter((o) => o.locked).length;
  $("unlockAll").textContent = lockedCount ? `Unlock all (${lockedCount})` : "Unlock all";
  $("unlockAll").disabled = !lockedCount;
  const sel = S.sels.map((k) => S.objects[k]).filter(Boolean);
  if (!sel.length) { box.innerHTML = S.open ? `<div class="hint">Nothing selected.</div>` : ""; return; }
  const t = trimOrigin(), u = union(sel.map((o) => o.bbox));
  const one = sel.length === 1 ? sel[0] : null;
  const groups = new Set(sel.map((o) => o.group).filter(Boolean));
  const layerNames = [...new Set(sel.map((o) => (o.layer ? o.layer.name : "no layer")))];
  const canInk = sel.some((o) => o.type === "path" || o.type === "text");
  const tags = [groups.size ? `<span class="tag">Grouped</span>` : "", `<span class="tag">${esc(layerNames.join(", "))}</span>`].join("");
  box.innerHTML = `<div class="card">
    <div class="t">${one ? esc(one.desc) : `${sel.length} objects`}</div>
    <div class="s">${tags} x ${mm(u[0] - t[0])} · y ${mm(u[1] - t[1])} mm from trim · ${mm(u[2] - u[0])} × ${mm(u[3] - u[1])} mm</div>
    <div class="row" style="align-items:flex-start;gap:12px">
      <div class="nudge"><span></span><button data-n="0,1">↑</button><span></span><button data-n="-1,0">←</button><button data-n="0,-1">↓</button><button data-n="1,0">→</button></div>
      <div class="grid2" style="flex:1"><label>Step mm<select id="nStep"><option>0.1</option><option>0.5</option><option selected>1</option><option>5</option></select></label>
        <label>Move X mm<input id="mvX" inputmode="decimal" value="0"></label><label>Move Y mm<input id="mvY" inputmode="decimal" value="0"></label>
        <label>&nbsp;<button id="mvGo">Move</button></label></div>
    </div>
    <div class="row">
      ${sel.length > 1 && !(groups.size === 1 && sel.every((o) => o.group)) ? `<button id="grpGo">Group</button>` : ""}
      ${groups.size ? `<button id="ungrpGo">Ungroup</button>` : ""}
      <button id="lockGo">Lock</button><button id="delGo" class="danger">Delete</button>
    </div>
    <div class="grid2" style="margin-top:10px"><label>Layer<select id="lyTo"></select></label><label>&nbsp;<button id="lyGo">Move to layer</button></label></div>
    ${canInk ? `<div class="grid2" style="margin-top:10px">${inkBlock("rc")}</div><div class="row"><button id="rcGo">Apply ink</button></div>` : ""}
    ${one && one.type === "text" ? `<div id="txEdit"></div>` : ""}
    ${one && one.barcode ? `<div id="bcEdit"></div>` : ""}
  </div>`;
  box.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => {
    const [ux, uy] = b.dataset.n.split(",").map(Number), st = parseFloat($("nStep").value);
    moveSel((ux * st) / PT_TO_MM, (uy * st) / PT_TO_MM);
  }));
  $("mvGo").onclick = () => moveSel(num("mvX", 0) / PT_TO_MM, num("mvY", 0) / PT_TO_MM);
  $("delGo").onclick = () => doEdit({ action: "delete" }, true);
  $("lockGo").onclick = () => doEdit({ action: "lock" }, true);
  if ($("grpGo")) $("grpGo").onclick = () => doEdit({ action: "group" });
  if ($("ungrpGo")) $("ungrpGo").onclick = () => doEdit({ action: "ungroup" });
  $("lyTo").innerHTML = `<option value="">(no layer)</option>` + S.layers.map((l) => `<option value="${l.id}" ${l.locked ? "disabled" : ""}>${esc(l.name)}${l.locked ? " (locked)" : ""}</option>`).join("");
  if (one && one.layer) $("lyTo").value = one.layer.id;
  $("lyGo").onclick = () => doEdit({ action: "layer", layerId: $("lyTo").value ? +$("lyTo").value : null });
  if (canInk) {
    wireInk("rc");
    $("rcGo").onclick = () => {
      let ink;
      try { ink = inkOf("rc"); } catch (e) { return oops("Ink", e); }
      doEdit({ action: "recolour", ink, tint: tintOf("rc") });
    };
  }
  if (one && one.type === "text") buildTextEditor(one);
  if (one && one.barcode) buildBarcodeEditor(one);
}

function moveSel(dx, dy) { if (dx || dy) doEdit({ action: "move", dx, dy }); }

async function afterEdit(r, keepSel) {
  S.objects = r.objects; if (r.inks) S.docInks = r.inks;
  S.ver++;
  setEdits(r.edits);
  if (keepSel === "last") S.sels = [S.objects.length - 1];
  else if (!keepSel) S.sels = [];
  else S.sels = S.sels.filter((k) => selectable(S.objects[k]));
  S.spots = (await call("page", { i: S.page })).spots;
  await render(false);
  buildSelCard();
  for (const sel of [$("bcInk"), $("txInk")]) fillInkSelect(sel);
}

async function doEdit(args, clearSel) {
  busy("Applying…");
  try {
    const r = await call("edit", { i: S.page, objs: S.sels, ...args });
    await afterEdit(r, !clearSel);
  } catch (err) { busy(""); oops("Edit not applied", err); }
}
$("unlockAll").onclick = () => doEdit({ action: "unlockAll", objs: [] }, true);

$("undo").onclick = async () => {
  busy("Undoing…");
  try {
    const r = await call("undo");
    S.ver++;
    setEdits(r.edits);
    if (r.report) $("report").textContent = r.report.join("\n");
    if (r.inks) S.docInks = r.inks;
    S.layers = await call("layers");
    buildLayers();
    busy("");
    await loadPage(r.page ?? S.page, false);
    buildLinks();
  } catch (err) { oops("Undo", err); }
  finally { busy(""); }
};

// ------------------------------------------------------------------ text: edit selected
async function buildTextEditor(o) {
  const el = $("txEdit");
  const t = o.text;
  let text = t.ours ? t.text : "";
  if (!t.ours) { try { text = await call("textOf", { i: S.page, k: o.k }); } catch {} }
  el.innerHTML = `<h2>Text</h2>
    ${t.ours ? "" : `<div class="hint">This text uses the file's own font (${esc(t.fontRes || "?")}), which is usually a subset. Updating replaces it with the font you choose, in the same position.</div>`}
    <div class="grid2">
      <label class="span2">Text<textarea id="teText" rows="3" autocapitalize="off" spellcheck="false">${esc(text)}</textarea></label>
      <label class="span2">Font<select id="teFont" class="fontSel"></select></label>
      <label>Size pt<input id="teSize" inputmode="decimal" value="${t.size ?? 10}"></label>
      <label>Line spacing pt<input id="teLead" inputmode="decimal" value="${t.lead ?? +((t.size ?? 10) * 1.2).toFixed(2)}"></label>
      <label class="span2">Align<select id="teAlign"><option value="l">Left</option><option value="c">Centre</option><option value="r">Right</option></select></label>
      ${inkBlock("te", null, t.tint)}
    </div>
    <div class="row"><button id="teGo" class="on">Update text</button></div>`;
  fillFontSelect($("teFont"), t.ours ? t.font : "b:Helvetica");
  $("teAlign").value = t.align || "l";
  wireInk("te", t.ours ? t.ink : "Black");
  if (t.ours && t.cmyk && !inkOptions().includes(t.ink)) { $("teInk").value = "＋ New spot…"; $("teNew").hidden = false; $("teName").value = t.ink; $("teCMYK").value = t.cmyk; }
  $("teGo").onclick = async () => {
    let ink;
    try { ink = inkOf("te"); } catch (e) { return oops("Ink", e); }
    const spec = { text: $("teText").value, font: $("teFont").value, size: num("teSize", 10), lead: num("teLead", 12), align: $("teAlign").value, ink, tint: tintOf("te") };
    if (!spec.text.trim()) return oops("Text", new Error("Type some text, or delete the object instead."));
    busy("Updating text…");
    try { await afterEdit(await call("replaceText", { i: S.page, obj: o.k, spec }), true); }
    catch (err) { busy(""); oops("Text not updated", err); }
  };
}

// ------------------------------------------------------------------ text: add new
$("txInk").addEventListener("change", () => { $("txNewInk").hidden = !$("txInk").value.startsWith("＋"); });
$("txAdd").onclick = async () => {
  let ink;
  try { ink = readInk($("txInk"), $("txInkName"), $("txInkCMYK")); } catch (e) { return oops("Ink", e); }
  const spec = { text: $("txText").value, font: $("txFont").value, size: num("txSize", 10), lead: num("txLead", 12), align: $("txAlign").value, ink, tint: clamp(num("txTint", 100), 0, 100) };
  if (!spec.text.trim()) return oops("Text", new Error("Type some text first."));
  busy("Adding text…");
  try { await afterEdit(await call("addText", { i: S.page, spec, xMM: num("txX", 0), yMM: num("txY", 0) }), "last"); showTab("edit"); setMode("select"); }
  catch (err) { busy(""); oops("Text not added", err); }
};

// ------------------------------------------------------------------ layers tab
function buildLayers() {
  const box = $("layerList");
  if (!S.open) return;
  if (!S.layers.length) { box.innerHTML = `<div class="hint">This file has no layers yet.</div>`; return; }
  box.innerHTML = S.layers.map((l) => `<div class="layer" data-id="${l.id}">
      <button class="vis ${l.visible ? "" : "off"}" title="Show/hide (view only)">${l.visible ? "👁" : "—"}</button>
      <span class="nm">${esc(l.name)}</span>
      <button class="ren" title="Rename">Rename</button>
      <button class="lk" title="Lock/unlock">${l.locked ? "🔒" : "🔓"}</button></div>`).join("");
  box.querySelectorAll(".layer").forEach((row) => {
    const id = +row.dataset.id, l = S.layers.find((x) => x.id === id);
    row.querySelector(".vis").onclick = async () => {
      busy("Updating view…");
      try {
        S.layers = await call("layerView", { id, visible: !l.visible });
        S.ver++; // separations follow the view
        S.objects = await call("objects", { i: S.page });
        S.sels = S.sels.filter((k) => selectable(S.objects[k]));
        buildLayers();
        await render(false);
        buildSelCard();
      } catch (err) { oops("Layers", err); } finally { busy(""); }
    };
    row.querySelector(".lk").onclick = () => layerEdit({ kind: "lockLayer", id, locked: !l.locked });
    row.querySelector(".ren").onclick = () => {
      dialog("Rename layer", `<input id="renName" value="${esc(l.name)}" style="width:100%;min-height:40px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:0 8px">`,
        [["Cancel"], ["Rename", () => { const n = $("renName").value.trim(); if (n && n !== l.name) layerEdit({ kind: "renameLayer", id, name: n }); }, "on"]]);
    };
  });
}
async function layerEdit(op) {
  busy("Updating layers…");
  try {
    const r = await call("layerEdit", op);
    S.layers = r.layers;
    $("report").textContent = r.report.join("\n");
    S.ver++;
    setEdits(r.edits);
    S.objects = await call("objects", { i: S.page });
    S.sels = S.sels.filter((k) => selectable(S.objects[k]));
    buildLayers();
    drawOverlay();
    buildSelCard();
  } catch (err) { oops("Layers", err); } finally { busy(""); }
}
$("newLayerBtn").onclick = () => {
  const name = $("newLayerName").value.trim();
  if (!name) return oops("New layer", new Error("Type a name for the layer."));
  if (S.layers.some((l) => l.name === name)) return oops("New layer", new Error("A layer with that name already exists."));
  $("newLayerName").value = "";
  layerEdit({ kind: "newLayer", name });
};

// ------------------------------------------------------------------ trapping
const PROCESS = ["Cyan", "Magenta", "Yellow", "Black"];
// whole words only ("Lack" is German for varnish, but "Black" must trap normally)
const TRAP_IGNORE = /\b(varnish|lack|lacquer|vernis|white|weiss|weiß|blanc|primer|cutting|cut|cutcontour|die|dieline|diecut|stanz|stanzkontur)\b/i;
const TRAP_OPAQUE = /\b(silver|gold|metallic|metal|opaque|foil|deckweiss|deckweiß)\b/i;
S.trapModes = {};
const trapMode = (n) => S.trapModes[n] || (TRAP_IGNORE.test(n) ? "ignore" : TRAP_OPAQUE.test(n) ? "opaque" : "normal");
function buildTrapInks() {
  const names = [...PROCESS, ...S.docInks.filter((n) => !PROCESS.includes(n))];
  $("trInks").innerHTML = names.map((n) => {
    const [r, g, b] = inkRGB(n);
    return `<div class="sc"><span class="nm"><i style="background:rgb(${r},${g},${b})"></i>${esc(n)}</span><span class="d" style="color:var(--dim);font-size:12px">ND ${inkND(n, inkRGB(n)).toFixed(2)}</span>
      <select data-ink="${esc(n)}" style="grid-column:span 2"><option value="normal">Normal</option><option value="opaque">Opaque</option><option value="ignore">Ignore</option></select></div>`;
  }).join("");
  $("trInks").querySelectorAll("select").forEach((sel) => { sel.value = trapMode(sel.dataset.ink); sel.onchange = () => { S.trapModes[sel.dataset.ink] = sel.value; }; });
}
async function trapPage(i, label) {
  const info = await call("page", { i });
  const mb = info.boxes.MediaBox;
  const wMM = Math.max(0.01, num("trW", 0.1)), bMM = Math.max(wMM, num("trB", 0.2)), step = clamp(num("trStep", 10), 1, 100);
  // resolution: the trap width is an exact whole number of pixels (at least 3)
  let dpi = Math.min(2400, Math.max(600, Math.ceil(3 / (wMM / 25.4))));
  const area = ((mb[2] - mb[0]) / 72) * ((mb[3] - mb[1]) / 72);
  if (area * dpi * dpi > 600e6) dpi = Math.floor(Math.sqrt(600e6 / area));
  const k = 72 / dpi, W = Math.ceil((mb[2] - mb[0]) / k), H = Math.ceil((mb[3] - mb[1]) / k);
  const r = (wMM / 25.4) * dpi, rB = (bMM / 25.4) * dpi, M = Math.ceil(rB) + 3, T = 2048;
  // overview at 72 dpi (PostScript fill rules draw even hairlines) to skip tiles without colour edges
  busy(`${label}: looking for colour edges…`);
  const ov = await getPlates(i, 72);
  const uniform = (x0, y0, x1, y1) => {
    const a = Math.max(0, Math.floor(x0 * k) - 2), b = Math.max(0, Math.floor(y0 * k) - 2);
    const c = Math.min(ov.w, Math.ceil(x1 * k) + 2), d = Math.min(ov.h, Math.ceil(y1 * k) + 2);
    for (const pl of ov.data) { const v = pl[b * ov.w + a]; for (let y = b; y < d; y++) for (let x = a; x < c; x++) if (pl[y * ov.w + x] !== v) return false; }
    return true;
  };
  const tiles = [];
  for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) {
    const c = [tx, ty, Math.min(W, tx + T), Math.min(H, ty + T)];
    if (uniform(...c)) continue;
    const p = [Math.max(0, c[0] - M), Math.max(0, c[1] - M), Math.min(W, c[2] + M), Math.min(H, c[3] + M)];
    tiles.push({ rect: [mb[0] + p[0] * k, mb[3] - p[3] * k, mb[0] + p[2] * k, mb[3] - p[1] * k], core: [c[0] - p[0], c[1] - p[1], c[2] - p[0], c[3] - p[1]] });
  }
  const spots = info.spots;
  const rgb = (n) => PROCESS_INKS[n] || spots[n] || FALLBACK_RGB;
  const inks = Object.fromEntries(ov.names.map((n) => [n, { nd: inkND(n, rgb(n)), mode: trapMode(n) }]));
  let groups = {};
  if (tiles.length) {
    const objs = i === S.page ? S.objects : await call("objects", { i });
    const excl = $("trImg").checked ? [] : objs.filter((o) => o.type === "image").map((o) => o.bbox);
    busy(`${label}: preparing ${tiles.length} tile${tiles.length > 1 ? "s" : ""} at ${dpi} dpi…`);
    const td = await call("trapTiles", { i, rects: tiles.map((t) => t.rect) });
    const bytes = new Uint8Array(td.bytes);
    groups = await seps({ cmd: "trap", bytes: bytes.buffer, dpi, inks, opt: { r, rBlack: rB, step: step * 2.55, excl },
      tiles: tiles.map((t, j) => ({ page: td.first + j, rect: t.rect, core: t.core })) }, [bytes.buffer], (m) => busy(`${label}: ${m.toLowerCase()}`));
    S.gsVer = -1; // the separation engine now holds the tile document
  }
  const res = await call("traps", { i, groups });
  return { res, dpi, count: Object.keys(groups).length, inks: [...new Set(Object.keys(groups).map((g) => g.slice(0, g.lastIndexOf("|"))))] };
}
async function runTrap(pages) {
  const lines = [];
  try {
    for (const i of pages) {
      const r = await trapPage(i, pages.length > 1 ? `Page ${i + 1} of ${S.pages}` : "Trapping");
      setEdits(r.res.edits);
      S.layers = r.res.layers;
      if (i === S.page) S.objects = r.res.objects;
      lines.push(`Page ${i + 1}: ${r.count ? `${r.count} trap object${r.count > 1 ? "s" : ""} (${r.inks.join(", ")})` : "no traps needed"} · ${r.dpi} dpi`);
    }
    S.ver++;
    buildLayers();
    busy("");
    await render(false);
    buildSelCard();
    $("trOut").innerHTML = `<div class="card"><div class="t good">Trapping done</div><div class="s">${lines.map(esc).join("<br>")}</div><div class="hint">Turn on Separations to inspect them, or hide the Traps layer to compare.</div></div>`;
  } catch (err) { busy(""); oops("Trapping", err); }
}
$("trPage").onclick = () => runTrap([S.page]);
$("trAll").onclick = () => runTrap([...Array(S.pages).keys()]);
$("trRemove").onclick = async () => {
  busy("Removing traps…");
  try {
    const r = await call("removeTraps", { i: S.page });
    S.objects = r.objects; S.ver++; setEdits(r.edits);
    busy("");
    await render(false);
    $("trOut").innerHTML = `<div class="hint">Traps removed from page ${S.page + 1}.</div>`;
  } catch (err) { busy(""); oops("Traps", err); }
};

// ------------------------------------------------------------------ links (images and scans)
let relinkTarget = null;
async function buildLinks() {
  const box = $("linkList");
  if (!S.open) return;
  let r;
  try { r = await call("images"); } catch (err) { box.innerHTML = `<div class="hint">${esc(err.message)}</div>`; return; }
  S.links = r;
  if (!r.images.length && !r.inline.length) { box.innerHTML = `<div class="hint">No images in this file.</div>`; return; }
  const minPPI = num("pfPPI", 250);
  box.innerHTML = r.images.map((im, n) => `<div class="link" data-n="${n}">
      <div class="top"><canvas width="1" height="1"></canvas><div style="flex:1;min-width:0">
        <div class="t">Image /${esc(im.name)}</div>
        <div class="meta">${im.w} × ${im.h} px · ${esc(im.cs)} · ${im.pending ? "new, compressed when saved" : `${esc(im.filter)} · ${im.kb} KB`}${im.alpha ? " · transparency" : ""}</div>
        ${im.placements.map((p) => `<div class="pl ${p.ppi < minPPI ? "low" : ""}">Page ${p.page + 1} · ${p.mmW} × ${p.mmH} mm · ${p.ppi} ppi${p.nested ? " · inside artwork" : ""}</div>`).join("")}
      </div></div>
      <div class="row"><button class="show">Show</button><button class="rel">Relink…</button><button class="rem danger">Remove</button></div></div>`).join("") +
    r.inline.map((im, n) => `<div class="link" data-inline="${n}"><div class="t">Inline image</div><div class="meta">Page ${im.page + 1} · stored inside the page content</div>
      <div class="row"><button class="show">Show</button><button class="rem danger">Remove</button></div></div>`).join("");
  box.querySelectorAll(".link").forEach((el) => {
    const im = el.dataset.n !== undefined ? r.images[+el.dataset.n] : null;
    const inl = el.dataset.inline !== undefined ? r.inline[+el.dataset.inline] : null;
    const first = im ? im.placements[0] : inl;
    el.querySelector(".show").onclick = async () => {
      if (first.page !== S.page) await loadPage(first.page, false);
      if (first.k !== null && first.k !== undefined && selectable(S.objects[first.k])) { setMode("select"); setSelection([first.k]); }
      S.highlights = [{ page: first.page, rect: first.bbox }];
      drawOverlay();
      zoomTo(first.bbox);
    };
    el.querySelector(".rem").onclick = () => dialog("Remove image", `<p>Remove this image from ${im ? `all ${im.placements.length} placement${im.placements.length > 1 ? "s" : ""}` : "the page"}? You can undo this.</p>`,
      [["Cancel"], ["Remove", async () => {
        busy("Removing…");
        try {
          const res = im ? await call("removeImage", { objnum: im.objnum }) : await call("edit", { i: inl.page, objs: [inl.k], action: "delete" });
          await afterLinks(res);
        } catch (err) { busy(""); oops("Remove", err); }
      }, "danger"]]);
    if (im) el.querySelector(".rel").onclick = () => { relinkTarget = im; $("lkFile").click(); };
  });
  // thumbnails, one at a time
  for (const el of box.querySelectorAll(".link")) {
    const im = el.dataset.n !== undefined ? r.images[+el.dataset.n] : r.inline[+el.dataset.inline];
    const p = im.placements ? im.placements[0] : im;
    try {
      const t = await call("thumb", { i: p.page, bbox: p.bbox, size: 128 });
      const c = el.querySelector("canvas");
      if (!c) continue;
      c.width = t.w; c.height = t.h;
      c.getContext("2d").putImageData(new ImageData(t.rgba, t.w, t.h), 0, 0);
    } catch {}
  }
}
async function afterLinks(res) {
  S.ver++;
  setEdits(res.edits);
  if (res.inks) S.docInks = res.inks;
  busy("");
  await loadPage(S.page, false);
  buildLinks();
}
$("lkFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !relinkTarget) return;
  busy("Relinking " + f.name + "…");
  try {
    const data = await f.arrayBuffer();
    const res = await call("relink", { objnum: relinkTarget.objnum, data, mode: $("lkMode").value }, [data]);
    await afterLinks(res);
  } catch (err) { busy(""); oops("Relink", new Error(`${f.name} could not be used: ${err.message}. Use JPEG, TIFF, PNG or PSD.`)); }
});

// ------------------------------------------------------------------ screening
const SCREEN_DEFAULTS = { Default: [150, 45], Cyan: [150, 15], Magenta: [150, 75], Yellow: [150, 0], Black: [150, 45] };
async function buildScreens() {
  if (!S.open) return;
  const r = await call("screens");
  S.shapes = r.shapes;
  const names = ["Default", ...PROCESS, ...S.docInks.filter((n) => !PROCESS.includes(n))];
  $("scTable").innerHTML = `<div class="sc boxhead"><span>Ink</span><span>lpi</span><span>Angle °</span><span>Dot</span></div>` + names.map((n) => {
    const cur = r.settings[n] || { lpi: (SCREEN_DEFAULTS[n] || [150, 45])[0], angle: (SCREEN_DEFAULTS[n] || [150, 45])[1], shape: "Round" };
    const [cr, cg, cb] = n === "Default" ? [120, 120, 120] : inkRGB(n);
    return `<div class="sc" data-ink="${esc(n)}"><span class="nm"><i style="background:rgb(${cr},${cg},${cb})"></i>${n === "Default" ? "Others" : esc(n)}</span>
      <input class="lpi" inputmode="decimal" value="${cur.lpi}"><input class="ang" inputmode="decimal" value="${cur.angle}">
      <select class="shp">${S.shapes.map((sh) => `<option ${sh === cur.shape ? "selected" : ""}>${sh}</option>`).join("")}</select></div>`;
  }).join("");
}
function screenSettings() {
  const out = {};
  for (const row of $("scTable").querySelectorAll(".sc[data-ink]")) {
    const lpi = num(row.querySelector(".lpi"), 0), ang = num(row.querySelector(".ang"), 0);
    if (!(lpi >= 10 && lpi <= 600)) throw new Error(`${row.dataset.ink}: ruling must be between 10 and 600 lpi.`);
    out[row.dataset.ink] = { lpi, angle: ((ang % 360) + 360) % 360, shape: row.querySelector(".shp").value };
  }
  return out;
}
$("scApply").onclick = async () => {
  let settings;
  try { settings = screenSettings(); } catch (e) { return oops("Screens", e); }
  busy("Applying screens…");
  try {
    const r = await call("applyScreens", { settings });
    S.ver++; setEdits(r.edits); $("report").textContent = `App version ${APP_VERSION}\n\n` + r.report.join("\n");
    busy("");
    dialog("Screens applied", "<p>Ruling, angle and dot shape are now stored in the file for every ink. Use <b>Dot preview</b> to check them.</p>", [["OK"]]);
  } catch (err) { busy(""); oops("Screens", err); }
};
$("scPreview").onclick = async () => {
  let settings;
  try { settings = screenSettings(); } catch (e) { return oops("Screens", e); }
  const st = stage.getBoundingClientRect(), c = toPt(toImg({ x: st.width / 2, y: st.height / 2 }));
  const half = 3 / PT_TO_MM;
  const rect = [c.x - half, c.y - half, c.x + half, c.y + half];
  const spots = [...new Set([...Object.keys(S.spots), ...S.docInks])].filter((n) => !PROCESS.includes(n));
  busy("Rendering dots…");
  try {
    const docs = await call("dotDocs", { i: S.page, rect, settings, spots });
    const renders = docs.map((d) => ({ bytes: d.bytes.buffer || d.bytes, inks: d.inks }));
    const r = await seps({ cmd: "dots", renders, dpi: 2400 }, renders.map((x) => x.bytes));
    S.gsVer = -1;
    const cv = $("scCanvas");
    cv.width = r.w; cv.height = r.h; cv.style.display = "block";
    const img = new ImageData(r.w, r.h), d = img.data, n = r.w * r.h;
    const acc = new Float32Array(n * 3).fill(1);
    r.names.forEach((name, k) => {
      const [cr, cg, cb] = inkRGB(name), pl = r.data[k];
      for (let i = 0, j = 0; i < n; i++, j += 3) if (pl[i]) { acc[j] *= cr / 255; acc[j + 1] *= cg / 255; acc[j + 2] *= cb / 255; }
    });
    for (let i = 0, j = 0, q = 0; i < n; i++, j += 3) { d[q++] = acc[j] * 255; d[q++] = acc[j + 1] * 255; d[q++] = acc[j + 2] * 255; d[q++] = 255; }
    cv.getContext("2d").putImageData(img, 0, 0);
    S.highlights = [{ page: S.page, rect }];
    drawOverlay();
    $("scInfo").textContent = "Preview of the orange-outlined 6 × 6 mm area at the centre of the view, 2400 dpi. Solids show as solid; pan to a tint or vignette to see dots. Your RIP or platesetter may use its own screening; check with your repro house.";
  } catch (err) { oops("Dot preview", err); }
  finally { busy(""); }
};

// ------------------------------------------------------------------ page boxes
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
    const v = num("bleedMM", -1);
    if (!t || !(v >= 0)) return dialog("Bleed", "The page needs a trim box and a bleed of 0 mm or more.", [["OK"]]);
    const d = v / PT_TO_MM;
    await setBox("BleedBox", [t[0] - d, t[1] - d, t[2] + d, t[3] + d]);
    buildBoxEditor();
  };
}
async function applyBoxEdits() {
  const mb = S.boxes.MediaBox;
  for (const name of ["CropBox", "BleedBox", "TrimBox", "ArtBox"]) {
    const raw = [...document.querySelectorAll(`input[data-box="${name}"]`)].map((i) => i.value.trim().replace(",", "."));
    if (raw.every((v) => v === "")) continue;
    const v = raw.map(parseFloat);
    if (v.some((x) => !Number.isFinite(x))) return dialog("Page boxes", `${name}: fill in all four values.`, [["OK"]]);
    const r = [mb[0] + v[0] / PT_TO_MM, mb[1] + v[1] / PT_TO_MM, mb[0] + v[2] / PT_TO_MM, mb[1] + v[3] / PT_TO_MM];
    const cur = S.boxes[name];
    if (cur && r.every((x, k) => Math.abs(x - cur[k]) < 0.001)) continue;
    await setBox(name, r);
  }
  buildBoxEditor();
}
async function setBox(name, r) {
  try {
    const res = await call("setBox", { i: S.page, name, rect: r });
    S.boxes = res.boxes;
    $("report").textContent = res.report.join("\n");
    S.ver++;
    setEdits(res.edits);
    drawOverlay();
  } catch (err) { oops("Page boxes", err); }
}

// ------------------------------------------------------------------ preflight
$("pfRun").onclick = async () => {
  const opts = { minPPI: num("pfPPI", 250), minLineMM: num("pfLine", 0.1), minTextPT: num("pfText", 5), minBleedMM: num("pfBleed", 3) };
  busy("Checking content…");
  try {
    const issues = await call("preflight", { opts });
    const lim = num("pfTAC", 300);
    for (let i = 0; i < S.pages; i++) {
      busy(`Checking ink limits, page ${i + 1} of ${S.pages}…`);
      const pl = await getPlates(i, 50);
      const pb = i === S.page ? S.boxes : (await call("page", { i })).boxes;
      const st = areaStats(pl, pb.MediaBox, pb.MediaBox);
      if (st.maxTAC > lim + 0.5) {
        const mb = pb.MediaBox, s = st.s, [x, y] = st.maxAt;
        const r = [mb[0] + x / s - 4, mb[3] - y / s - 4, mb[0] + x / s + 4, mb[3] - y / s + 4];
        issues.push({ sev: "warn", page: i + 1, title: `Total ink above ${lim}%`, detail: `Highest ${st.maxTAC.toFixed(0)}% · ${(st.overArea * PT_TO_MM * PT_TO_MM).toFixed(1)} mm² over`, rects: [r], count: 1 });
      }
    }
    if (S.layers.some((l) => !l.visible)) issues.push({ sev: "info", page: 0, title: "Some layers are hidden in the view", detail: "Content checks include them; the ink limit check follows the view", rects: [], count: 1 });
    S.issues = issues;
    showIssues();
  } catch (err) { oops("Preflight", err); }
  finally { busy(""); }
};
function showIssues() {
  const out = $("pfOut");
  const counts = { error: 0, warn: 0, info: 0 };
  S.issues.forEach((g) => counts[g.sev]++);
  if (!S.issues.length) { out.innerHTML = `<div class="card"><div class="t good">No problems found</div></div>`; return; }
  out.innerHTML = `<div class="hint">${counts.error} errors · ${counts.warn} warnings · ${counts.info} notes. Tap one to show it.</div>` +
    S.issues.map((g, k) => `<div class="issue" data-k="${k}"><span class="ic ${g.sev}"></span><div><div>${esc(g.title)}${g.count > 1 ? ` <span class="d">×${g.count}</span>` : ""}</div>
      <div class="d">${g.page ? `Page ${g.page}` : "Document"}${g.detail ? " · " + esc(g.detail) : ""}</div></div></div>`).join("");
  out.querySelectorAll(".issue").forEach((el) => (el.onclick = async () => {
    out.querySelectorAll(".issue").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    const g = S.issues[+el.dataset.k];
    S.highlights = g.rects.map((r) => ({ page: g.page - 1, rect: r }));
    if (g.page && g.page - 1 !== S.page) await loadPage(g.page - 1, true);
    drawOverlay();
    if (g.rects[0] && !S.rotation) zoomTo(g.rects[0]);
  }));
}
function zoomTo(r) {
  const p = toPx(r), st = stage.getBoundingClientRect();
  const pad = Math.min(st.width, st.height) * 0.22, z = Math.min(Math.max(Math.min((st.width - pad * 2) / Math.max(p[2], 20), (st.height - pad * 2) / Math.max(p[3], 20)), 0.05), 8);
  S.z = Math.min(z, Math.max(S.z, 0.05) * 4);
  S.tx = st.width / 2 - (p[0] + p[2] / 2) * S.z;
  S.ty = st.height / 2 - (p[1] + p[3] / 2) * S.z;
  applyView();
}

// ------------------------------------------------------------------ barcodes (sized by magnification)
const bcType = (id) => S.bcTypes.find((x) => x.id === id);
function fillBarcodeTypes() {
  $("bcType").innerHTML = S.bcTypes.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  $("bcType").onchange = applyTypeDefaults;
  applyTypeDefaults();
}
function applyTypeDefaults() {
  const t = bcType($("bcType").value);
  $("bcData").value = t.sample;
  $("bcMag").value = 100;
  $("bcHP").value = 100;
  $("bcHwrap").hidden = !t.linear;
  $("bcHRIwrap").hidden = !t.linear;
  updateBcInfo();
}
function sizeFor(t, mag, hpct) {
  return { moduleMM: +((t.x * mag) / 100).toFixed(4), heightMM: t.linear ? +((((t.h * mag) / 100) * hpct) / 100).toFixed(3) : 0 };
}
function magProblem(t, mag) {
  const [lo, hi] = t.mag || [25, 400];
  return mag < lo || mag > hi ? `${t.label} must be between ${lo}% and ${hi}% magnification.` : null;
}
function bcInfoText(t, mag, hpct) {
  const z = sizeFor(t, mag, hpct);
  return `Module ${z.moduleMM.toFixed(3)} mm${t.linear ? ` · bar height ${z.heightMM.toFixed(2)} mm` : ""}. 100% = ${t.x} mm module${t.linear ? `, ${t.h} mm bars` : ""}.${t.mag ? ` Allowed ${t.mag[0]}–${t.mag[1]}%.` : ""}${t.linear && hpct < 100 ? " Bars truncated." : ""}`;
}
function updateBcInfo() {
  const t = bcType($("bcType").value);
  if (t) $("bcInfo").textContent = bcInfoText(t, num("bcMag", 100), num("bcHP", 100));
}
$("bcMag").addEventListener("input", updateBcInfo);
$("bcHP").addEventListener("input", updateBcInfo);
$("bcInk").addEventListener("change", () => { $("bcNewInk").hidden = !$("bcInk").value.startsWith("＋"); });
$("bcAdd").onclick = async () => {
  let ink;
  try { ink = readInk($("bcInk"), $("bcInkName"), $("bcInkCMYK")); } catch (e) { return oops("Ink", e); }
  const t = bcType($("bcType").value), mag = num("bcMag", 100), hpct = clamp(num("bcHP", 100), 10, 100);
  const bad = magProblem(t, mag);
  if (bad) return oops("Magnification", new Error(bad));
  const spec = { type: t.id, data: $("bcData").value.trim(), ...sizeFor(t, mag, hpct), bwrMM: num("bcBWR", 0), hri: $("bcHRI").checked };
  busy("Building barcode…");
  try { await afterEdit(await call("barcode", { i: S.page, spec, ink, tint: clamp(num("bcTint", 100), 0, 100), xMM: num("bcPosX", 0), yMM: num("bcPosY", 0), mag, hpct }), "last"); showTab("edit"); setMode("select"); }
  catch (err) { busy(""); oops("Barcode not added", err); }
};

function buildBarcodeEditor(o) {
  const m = o.barcode, t = bcType(m.bcid);
  const el = $("bcEdit");
  if (!t) { el.innerHTML = `<div class="hint">Unknown barcode type.</div>`; return; }
  el.innerHTML = `<h2>${esc(t.label)}</h2><div class="grid2">
      <label class="span2">Data<input id="beData" value="${esc(m.data)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label>Magnification %<input id="beMag" inputmode="decimal" value="${m.mag}"></label>
      ${t.linear ? `<label>Bar height %<input id="beHP" inputmode="decimal" value="${m.hpct}"></label>` : "<span></span>"}
      <label>BWR mm<input id="beBWR" inputmode="decimal" value="${+m.bwr.toFixed(4)}"></label>
      ${t.linear ? `<label class="chk"><input id="beHRI" type="checkbox" ${m.hri ? "checked" : ""}> Digits</label>` : "<span></span>"}
      ${inkBlock("be", null, m.tint)}
    </div><div class="hint" id="beInfo"></div><div class="row"><button id="beGo" class="on">Update barcode</button></div>`;
  wireInk("be", m.ink);
  const info = () => { $("beInfo").textContent = bcInfoText(t, num("beMag", 100), t.linear ? num("beHP", 100) : 100) + " The lower-left corner stays where it is."; };
  info();
  $("beMag").oninput = info;
  if ($("beHP")) $("beHP").oninput = info;
  $("beGo").onclick = async () => {
    let ink;
    try { ink = inkOf("be"); } catch (e) { return oops("Ink", e); }
    const mag = num("beMag", 100), hpct = t.linear ? clamp(num("beHP", 100), 10, 100) : 100;
    const bad = magProblem(t, mag);
    if (bad) return oops("Magnification", new Error(bad));
    const spec = { type: t.id, data: $("beData").value.trim(), ...sizeFor(t, mag, hpct), bwrMM: num("beBWR", 0), hri: t.linear ? $("beHRI").checked : false };
    busy("Updating barcode…");
    try { await afterEdit(await call("barcodeEdit", { i: S.page, obj: o.k, spec, ink, tint: tintOf("be"), mag, hpct }), true); }
    catch (err) { busy(""); oops("Barcode not updated", err); }
  };
}

// ------------------------------------------------------------------ place by tap (barcode or text)
let placeFor = null;
function armPlace(target, btn) {
  placeFor = placeFor === target ? null : target;
  $("bcTap").classList.toggle("on", placeFor === "bc");
  $("txTap").classList.toggle("on", placeFor === "tx");
  $("readout").innerHTML = placeFor ? `<span>Tap the page where the ${target === "bc" ? "barcode's lower-left corner" : "text should start"} should go</span>` : "";
}
$("bcTap").onclick = () => armPlace("bc");
$("txTap").onclick = () => armPlace("tx");

// ------------------------------------------------------------------ toolbar
$("prev").onclick = () => S.page > 0 && loadPage(S.page - 1, true);
$("next").onclick = () => S.page < S.pages - 1 && loadPage(S.page + 1, true);
$("fit").onclick = fitView;
$("seps").onclick = () => { S.sepsOn = !S.sepsOn; $("seps").classList.toggle("on", S.sepsOn); render(false); };
$("boxesBtn").onclick = () => { S.boxesOn = !S.boxesOn; $("boxesBtn").classList.toggle("on", S.boxesOn); drawOverlay(); };
$("dpi").onchange = () => { S.dpi = +$("dpi").value; render(false); };
$("panel").onclick = () => { const h = $("aside").classList.toggle("hidden"); $("panel").classList.toggle("on", !h); };
$("layersBtn").onclick = () => showTab("layers", true);
$("ver").textContent = "v" + APP_VERSION;
if (window.innerWidth <= 900) { $("aside").classList.add("hidden"); $("panel").classList.remove("on"); }
function setMode(m) {
  S.mode = m;
  for (const [id, v] of [["mPan", "pan"], ["mSel", "select"], ["mMeas", "measure"]]) $(id).classList.toggle("on", m === v);
  if (m !== "measure") $("cross").style.display = "none";
  if (m === "select") showTab("edit");
}
$("mPan").onclick = () => setMode("pan");
$("mSel").onclick = () => setMode("select");
$("mMeas").onclick = () => setMode("measure");
const TABS = ["inks", "layers", "edit", "text", "links", "trap", "screens", "pre", "bc", "info"];
function showTab(name, force) {
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of TABS) $("tab-" + t).hidden = t !== name;
  if ($("aside").classList.contains("hidden") && (force || (S.open && name !== "inks"))) { $("aside").classList.remove("hidden"); $("panel").classList.add("on"); }
}
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ save
$("save").onclick = async () => {
  busy("Saving and verifying…");
  let r;
  try { r = await call("save"); } catch (err) { busy(""); return oops("Save failed", err); }
  busy("");
  const bytes = new Uint8Array(r.bytes);
  setEdits(0);
  S.ver++;
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
  dialog("Ready to save", msg + `<p class="hint">File: ${esc(fname)}</p>`, [["Cancel"], ["Save to Files / Share", async () => { await share(bytes, fname); }, "on"]]);
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
const toImg = (p) => ({ x: (p.x - S.tx) / S.z, y: (p.y - S.ty) / S.z });
const toPt = (ip) => { const mb = S.boxes.MediaBox, s = pxPerPt(); return { x: mb[0] + ip.x / s, y: mb[3] - ip.y / s }; };
const pts = new Map();
let pinch = null, lastTap = 0, moved = 0, lastPick = null;

// Outline-only shapes (dielines, keylines) are picked near their lines only,
// so an outline around the page doesn't swallow taps on the artwork inside.
const outlineOnly = (o) => o.type === "path" && / stroke /.test(o.desc) && !/ fill /.test(o.desc);
function hitObject(o, q, tol) {
  const [x0, y0, x1, y1] = o.bbox;
  if (q.x < x0 - tol || q.x > x1 + tol || q.y < y0 - tol || q.y > y1 + tol) return false;
  if (!outlineOnly(o)) return true;
  const edge = tol * 4;
  return q.x - x0 < edge || x1 - q.x < edge || q.y - y0 < edge || y1 - q.y < edge;
}
function pick(p) {
  const q = toPt(toImg(p)), tol = 3 / pxPerPt() / S.z + 1;
  const hits = S.objects.filter((o) => selectable(o) && hitObject(o, q, tol)).map((o) => o.k).reverse();
  if (!hits.length) return -1;
  const again = lastPick && Math.hypot(lastPick.x - p.x, lastPick.y - p.y) < 10 && hits.some((k) => S.sels.includes(k));
  lastPick = p;
  if (!again) return hits[0];
  const cur = hits.findIndex((k) => S.sels.includes(k));
  return hits[(cur + 1) % hits.length];
}
function insideSel(p) {
  const q = toPt(toImg(p)), tol = 6 / pxPerPt() / S.z;
  return S.sels.some((k) => { const b = S.objects[k]?.bbox; return b && q.x >= b[0] - tol && q.x <= b[2] + tol && q.y >= b[1] - tol && q.y <= b[3] + tol; });
}

stage.addEventListener("pointerdown", (e) => {
  if (!S.w) return;
  stage.setPointerCapture(e.pointerId);
  const p = local(e);
  pts.set(e.pointerId, p);
  moved = 0;
  if (pts.size === 2) {
    drag = null; marquee = null; drawOverlay();
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  } else if (S.mode === "measure") readAt(p);
  else if (S.mode === "select" && !placeFor) {
    if (S.sels.length && insideSel(p)) drag = { start: p, dx: 0, dy: 0 };
    else { const ip = toImg(p); marquee = { x0: ip.x, y0: ip.y, x1: ip.x, y1: ip.y, armed: false }; }
  }
});
stage.addEventListener("pointermove", (e) => {
  if (!S.w) return;
  const p = local(e);
  if (!pts.has(e.pointerId)) { if (e.pointerType !== "touch" && S.mode !== "select") readAt(p, true); return; }
  const prev = pts.get(e.pointerId);
  pts.set(e.pointerId, p);
  moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
  if (pts.size >= 2 && pinch) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.tx += mx - pinch.mx; S.ty += my - pinch.my;
    zoomAt(d / pinch.d, mx, my);
    pinch = { d, mx, my };
  } else if (pts.size === 1) {
    if (S.mode === "measure") readAt(p);
    else if (drag) {
      drag.dx = (p.x - drag.start.x) / S.z; drag.dy = (p.y - drag.start.y) / S.z;
      drawOverlay();
      $("readout").innerHTML = `<span>Move ${mm(drag.dx / pxPerPt())} mm, ${mm(-drag.dy / pxPerPt())} mm</span>`;
    } else if (marquee) {
      const ip = toImg(p);
      marquee.x1 = ip.x; marquee.y1 = ip.y;
      if (moved > 6) marquee.armed = true;
      if (marquee.armed) drawOverlay();
    } else { S.tx += p.x - prev.x; S.ty += p.y - prev.y; applyView(); }
  }
});
function finishMarquee() {
  const m = marquee;
  marquee = null;
  const a = toPt({ x: Math.min(m.x0, m.x1), y: Math.max(m.y0, m.y1) }), b = toPt({ x: Math.max(m.x0, m.x1), y: Math.min(m.y0, m.y1) });
  const inside = S.objects.filter((o) => selectable(o) && o.bbox[0] >= a.x && o.bbox[1] >= a.y && o.bbox[2] <= b.x && o.bbox[3] <= b.y).map((o) => o.k);
  const base = $("addSel").checked ? S.sels : [];
  setSelection(expandGroups([...new Set([...base, ...inside])]));
}
const end = (e) => {
  const p = local(e);
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (e.type !== "pointerup") { drag = null; marquee = null; drawOverlay(); return; }
  if (drag) {
    const d = drag;
    drag = null;
    if (moved > 3) { moveSel(d.dx / pxPerPt(), -d.dy / pxPerPt()); return; }
    drawOverlay();
  }
  if (marquee && marquee.armed) { finishMarquee(); return; }
  marquee = null;
  if (moved < 8 && pts.size === 0) {
    if (placeFor) {
      const q = toPt(toImg(p)), t = trimOrigin(), target = placeFor;
      const [xi, yi] = target === "bc" ? ["bcPosX", "bcPosY"] : ["txX", "txY"];
      $(xi).value = mm(q.x - t[0]); $(yi).value = mm(q.y - t[1]);
      armPlace(null);
      $("readout").innerHTML = `<span>Position set to ${$(xi).value}, ${$(yi).value} mm. Tap ${target === "bc" ? "Add barcode" : "Add text"}.</span>`;
      showTab(target === "bc" ? "bc" : "text");
      return;
    }
    if (S.mode === "select") {
      const k = pick(p);
      if ($("addSel").checked) {
        if (k < 0) return;
        const grp = expandGroups([k]);
        const has = grp.every((x) => S.sels.includes(x));
        setSelection(has ? S.sels.filter((x) => !grp.includes(x)) : expandGroups([...S.sels, ...grp]));
      } else setSelection(k < 0 ? [] : expandGroups([k]));
      return;
    }
    if (e.pointerType === "touch" && S.mode === "pan") {
      const now = Date.now();
      if (now - lastTap < 300) fitView();
      lastTap = now;
    }
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
let gz = 1;
stage.addEventListener("gesturestart", (e) => { e.preventDefault(); gz = 1; });
stage.addEventListener("gesturechange", (e) => { e.preventDefault(); const p = local(e); zoomAt(e.scale / gz, p.x, p.y); gz = e.scale; });
document.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("resize", () => S.w && fitView());

// ------------------------------------------------------------------ densitometer
function readAt(p, hover) {
  const ip = toImg(p), ix = Math.floor(ip.x), iy = Math.floor(ip.y);
  const cross = $("cross");
  if (ix < 0 || iy < 0 || ix >= S.w || iy >= S.h) { cross.style.display = "none"; return; }
  cross.style.display = S.mode === "measure" || hover ? "block" : "none";
  cross.style.left = p.x + "px"; cross.style.top = p.y + "px";
  const q = toPt({ x: ix + 0.5, y: iy + 0.5 }), t = trimOrigin();
  let html = `<span><span class="k">x</span> ${mm(q.x - t[0])} mm</span><span><span class="k">y</span> ${mm(q.y - t[1])} mm</span><span class="k">from trim</span>`;
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
