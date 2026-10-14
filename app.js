// Prepress for iPad: main thread (UI, gestures, compositing).
import { PROCESS_INKS, FALLBACK_RGB, PT_TO_MM } from "./pdfcore.js";

const $ = (id) => document.getElementById(id);
const MAX_PIXELS = 12e6; // stay under iPadOS canvas limits
const BOX_STYLE = {
  MediaBox: ["#8c8c8c", ""], CropBox: ["#505050", "2 3"], BleedBox: ["#dc2828", "6 4"],
  TrimBox: ["#00a03c", ""], ArtBox: ["#285ade", "8 3 2 3"],
};
const SVGNS = "http://www.w3.org/2000/svg";

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
let gsCall = null; // Ghostscript worker, created on first use
const seps = (payload, transfer) => { if (!gsCall) gsCall = rpcWorker("seps-worker.js"); return gsCall(payload, transfer); };

// ------------------------------------------------------------------ state
const S = {
  name: "", pages: 0, page: 0, open: false,
  boxes: null, rotation: 0, spots: {}, docInks: [], dpi: 150, effDpi: 150, w: 0, h: 0,
  plates: null, platesVer: -1, enabled: new Set(), sepsOn: false, boxesOn: true,
  mode: "pan", objects: [], sel: -1, edits: 0, ver: 0, gsVer: -1,
  z: 1, tx: 0, ty: 0, highlights: [], issues: [], bcTypes: [],
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (id, dflt) => { const v = parseFloat(String($(id).value).replace(",", ".")); return Number.isFinite(v) ? v : dflt; };
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
  for (const id of ["save", "prev", "next", "fit", "seps", "mPan", "mSel", "mMeas", "boxesBtn", "dpi", "covBtn", "pfRun", "bcAdd", "bcTap"]) $(id).disabled = !on;
  setEdits(S.edits);
}
const mm = (pt) => (pt * PT_TO_MM).toFixed(2);
const pxPerPt = () => S.w / (S.boxes.MediaBox[2] - S.boxes.MediaBox[0]);
const toPx = (b) => { const mb = S.boxes.MediaBox, s = pxPerPt(); return [(b[0] - mb[0]) * s, (mb[3] - b[3]) * s, (b[2] - b[0]) * s, (b[3] - b[1]) * s]; };
const trimOrigin = () => (S.boxes.TrimBox || S.boxes.MediaBox);

// ------------------------------------------------------------------ open
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  busy("Opening " + f.name + "…");
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const info = await call("open", { bytes: buf.buffer }, [buf.buffer]);
    Object.assign(S, { name: f.name, pages: info.pages, page: 0, plates: null, open: true, docInks: info.inks, sel: -1, issues: [], highlights: [] });
    S.ver++;
    $("report").textContent = info.report.join("\n") + (info.incremental ? "" : "\n\n⚠ File needs repair: saves will be full rewrites.");
    $("empty").style.display = "none";
    $("pfOut").innerHTML = ""; $("cov").innerHTML = "";
    setEdits(0);
    enable(true);
    if (!S.bcTypes.length) { S.bcTypes = await call("barcodeTypes"); fillBarcodeTypes(); }
    fillInkSelect($("bcInk"));
    await loadPage(0, true);
  } catch (err) { oops("Could not open file", err); }
  finally { busy(""); }
});

async function loadPage(i, fit) {
  S.page = i;
  S.sel = -1;
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
      S.plates = { names: r.names, w: r.w, h: r.h, data: r.data, page: S.page, ver: S.ver, dpi: S.effDpi };
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
let drag = null; // { x0, y0, dx, dy } in px while dragging a selection
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
  const o = S.objects[S.sel];
  if (o) {
    const r = toPx(o.bbox);
    rect(svg, r, "#3d8bfd", "", { width: "2" });
    if (drag) rect(svg, [r[0] + drag.dx, r[1] + drag.dy, r[2], r[3]], "#3d8bfd", "5 4", { fill: "rgba(61,139,253,.12)", width: "2" });
  }
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

function areaStats(pl, region) {
  // region in pt (PDF coords) -> per-ink mean coverage, max total ink and where
  const mb = S.boxes.MediaBox, s = pl.w / (mb[2] - mb[0]);
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
    const st = areaStats(pl, region);
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

// ------------------------------------------------------------------ edit tab
function inkOptions(withNew) {
  const process = ["Black", "Cyan", "Magenta", "Yellow"];
  return [...process, ...S.docInks.filter((n) => !process.includes(n)), ...(withNew ? ["＋ New spot…"] : [])];
}
function fillInkSelect(sel, withNew = true) {
  const keep = sel.value;
  sel.innerHTML = inkOptions(withNew).map((n) => `<option>${esc(n)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function readInk(sel, nameId, cmykId) {
  if (!sel.value.startsWith("＋")) return { name: sel.value };
  const name = $(nameId).value.trim();
  const cmyk = $(cmykId).value.trim().split(/[\s,]+/).map(Number);
  if (!name || cmyk.length !== 4 || cmyk.some((v) => !(v >= 0 && v <= 100))) throw new Error("Give the new spot a name and four CMYK values from 0 to 100.");
  return { name, cmyk };
}

function buildSelCard() {
  const box = $("selCard");
  const o = S.objects[S.sel];
  if (!o) { box.innerHTML = S.open ? `<div class="hint">Nothing selected.</div>` : ""; return; }
  const t = trimOrigin();
  const canInk = o.type === "path" || o.type === "text";
  box.innerHTML = `<div class="card">
    <div class="t">${esc(o.desc)}</div>
    <div class="s">x ${mm(o.bbox[0] - t[0])} · y ${mm(o.bbox[1] - t[1])} mm from trim · ${mm(o.bbox[2] - o.bbox[0])} × ${mm(o.bbox[3] - o.bbox[1])} mm</div>
    ${o.locked ? `<div class="hint warn">This path also clips other artwork, so it can't be edited on its own.</div>` : `
    <div class="row" style="align-items:flex-start;gap:12px">
      <div class="nudge"><span></span><button data-n="0,1">↑</button><span></span><button data-n="-1,0">←</button><button data-n="0,-1">↓</button><button data-n="1,0">→</button></div>
      <div class="grid2" style="flex:1"><label>Step mm<select id="nStep"><option>0.1</option><option>0.5</option><option selected>1</option><option>5</option></select></label>
        <label>Move X mm<input id="mvX" inputmode="decimal" value="0"></label><label>Move Y mm<input id="mvY" inputmode="decimal" value="0"></label>
        <label>&nbsp;<button id="mvGo">Move</button></label></div>
    </div>
    ${canInk ? `<div class="grid2" style="margin-top:10px"><label>Ink<select id="rcInk"></select></label><label>Tint %<input id="rcTint" inputmode="decimal" value="100"></label></div>
    <div class="grid2" id="rcNew" hidden><label class="span2">New spot name<input id="rcName" value="New spot"></label><label class="span2">Screen colour (C M Y K %)<input id="rcCMYK" value="0 0 0 50"></label></div>
    <div class="row"><button id="rcGo">Apply ink</button><button id="delGo" class="danger">Delete</button></div>`
    : `<div class="row"><button id="delGo" class="danger">Delete</button></div>`}`}
  </div>`;
  if (o.locked) return;
  box.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => {
    const [ux, uy] = b.dataset.n.split(",").map(Number), st = parseFloat($("nStep").value);
    moveSel(ux * st / PT_TO_MM, uy * st / PT_TO_MM);
  }));
  $("mvGo").onclick = () => moveSel(num("mvX", 0) / PT_TO_MM, num("mvY", 0) / PT_TO_MM);
  $("delGo").onclick = () => doEdit({ action: "delete", obj: S.sel }, true);
  if (canInk) {
    fillInkSelect($("rcInk"));
    $("rcInk").onchange = () => { $("rcNew").hidden = !$("rcInk").value.startsWith("＋"); };
    $("rcGo").onclick = () => {
      let ink;
      try { ink = readInk($("rcInk"), "rcName", "rcCMYK"); } catch (e) { return oops("Ink", e); }
      doEdit({ action: "recolour", obj: S.sel, ink, tint: Math.min(100, Math.max(0, num("rcTint", 100))) });
    };
  }
}

function moveSel(dx, dy) { if (dx || dy) doEdit({ action: "move", obj: S.sel, dx, dy }); }

async function doEdit(args, clearSel) {
  busy("Applying…");
  try {
    const r = await call("edit", { i: S.page, ...args });
    S.objects = r.objects; S.docInks = r.inks;
    S.ver++;
    setEdits(r.edits);
    if (clearSel) S.sel = -1;
    S.spots = (await call("page", { i: S.page })).spots;
    await render(false);
    buildSelCard();
    fillInkSelect($("bcInk"));
  } catch (err) { busy(""); oops("Edit not applied", err); }
}

$("undo").onclick = async () => {
  busy("Undoing…");
  try {
    const r = await call("undo");
    S.ver++;
    setEdits(r.edits);
    if (r.report) $("report").textContent = r.report.join("\n");
    if (r.inks) S.docInks = r.inks;
    busy("");
    await loadPage(r.page ?? S.page, false);
  } catch (err) { oops("Undo", err); }
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
      const pageBoxes = i === S.page ? S.boxes : (await call("page", { i })).boxes;
      const saved = S.boxes; S.boxes = pageBoxes;
      const st = areaStats(pl, pageBoxes.MediaBox);
      S.boxes = saved;
      if (st.maxTAC > lim + 0.5) {
        const mb = pageBoxes.MediaBox, s = st.s, [x, y] = st.maxAt;
        const r = [mb[0] + x / s - 4, mb[3] - y / s - 4, mb[0] + x / s + 4, mb[3] - y / s + 4];
        issues.push({ sev: "warn", page: i + 1, title: `Total ink above ${lim}%`, detail: `Highest ${st.maxTAC.toFixed(0)}% · ${(st.overArea * PT_TO_MM * PT_TO_MM).toFixed(1)} mm² over`, rects: [r], count: 1 });
      }
    }
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

// ------------------------------------------------------------------ barcodes
function fillBarcodeTypes() {
  $("bcType").innerHTML = S.bcTypes.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  $("bcType").onchange = applyTypeDefaults;
  applyTypeDefaults();
}
function applyTypeDefaults() {
  const t = S.bcTypes.find((x) => x.id === $("bcType").value);
  $("bcData").value = t.sample;
  $("bcX").value = t.x;
  $("bcH").value = t.h ?? "";
  $("bcHwrap").hidden = !t.linear;
  $("bcHRIwrap").hidden = !t.linear;
  updateBcInfo();
}
function updateBcInfo() {
  const t = S.bcTypes.find((x) => x.id === $("bcType").value);
  if (!t) return;
  const x = num("bcX", t.x);
  $("bcInfo").textContent = ["ean13", "upca", "ean8"].includes(t.id) ? `Magnification ${Math.round((x / 0.33) * 100)}% (nominal module 0.33 mm). Check digit is added if left off.` : "Position is the lower-left corner of the code, including its quiet zone.";
}
$("bcX").addEventListener("input", updateBcInfo);
$("bcInk").addEventListener("change", () => { $("bcNewInk").hidden = !$("bcInk").value.startsWith("＋"); });
$("bcAdd").onclick = async () => {
  let ink;
  try { ink = readInk($("bcInk"), "bcInkName", "bcInkCMYK"); } catch (e) { return oops("Ink", e); }
  const t = S.bcTypes.find((x) => x.id === $("bcType").value);
  const spec = { type: t.id, data: $("bcData").value.trim(), moduleMM: num("bcX", t.x), heightMM: num("bcH", t.h || 20), bwrMM: num("bcBWR", 0), hri: $("bcHRI").checked };
  busy("Building barcode…");
  try {
    const r = await call("barcode", { i: S.page, spec, ink, tint: Math.min(100, Math.max(0, num("bcTint", 100))), xMM: num("bcPosX", 0), yMM: num("bcPosY", 0) });
    S.objects = r.objects; S.docInks = r.inks;
    S.ver++;
    setEdits(r.edits);
    S.sel = S.objects.length - 1;
    S.spots = (await call("page", { i: S.page })).spots;
    await render(false);
    buildSelCard();
    fillInkSelect($("bcInk"));
  } catch (err) { busy(""); oops("Barcode not added", err); }
};
let placeArmed = false;
$("bcTap").onclick = () => { placeArmed = !placeArmed; $("bcTap").classList.toggle("on", placeArmed); $("readout").innerHTML = placeArmed ? `<span>Tap the page where the barcode's lower-left corner should go</span>` : ""; };

// ------------------------------------------------------------------ toolbar
$("prev").onclick = () => S.page > 0 && loadPage(S.page - 1, true);
$("next").onclick = () => S.page < S.pages - 1 && loadPage(S.page + 1, true);
$("fit").onclick = fitView;
$("seps").onclick = () => { S.sepsOn = !S.sepsOn; $("seps").classList.toggle("on", S.sepsOn); render(false); };
$("boxesBtn").onclick = () => { S.boxesOn = !S.boxesOn; $("boxesBtn").classList.toggle("on", S.boxesOn); drawOverlay(); };
$("dpi").onchange = () => { S.dpi = +$("dpi").value; render(false); };
$("panel").onclick = () => { const h = $("aside").classList.toggle("hidden"); $("panel").classList.toggle("on", !h); };
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
function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["inks", "edit", "pre", "bc", "info"]) $("tab-" + t).hidden = t !== name;
  if ($("aside").classList.contains("hidden") && S.open && name !== "inks") { $("aside").classList.remove("hidden"); $("panel").classList.add("on"); }
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

function pick(p) {
  const q = toPt(toImg(p)), tol = 3 / pxPerPt() / S.z + 1;
  const hits = S.objects.filter((o) => q.x >= o.bbox[0] - tol && q.x <= o.bbox[2] + tol && q.y >= o.bbox[1] - tol && q.y <= o.bbox[3] + tol).map((o) => o.k).reverse();
  if (!hits.length) return -1;
  const again = lastPick && Math.hypot(lastPick.x - p.x, lastPick.y - p.y) < 10 && hits.includes(S.sel);
  lastPick = p;
  return again ? hits[(hits.indexOf(S.sel) + 1) % hits.length] : hits[0];
}
function insideSel(p) {
  const o = S.objects[S.sel];
  if (!o) return false;
  const q = toPt(toImg(p)), tol = 6 / pxPerPt() / S.z;
  return q.x >= o.bbox[0] - tol && q.x <= o.bbox[2] + tol && q.y >= o.bbox[1] - tol && q.y <= o.bbox[3] + tol;
}

stage.addEventListener("pointerdown", (e) => {
  if (!S.w) return;
  stage.setPointerCapture(e.pointerId);
  const p = local(e);
  pts.set(e.pointerId, p);
  moved = 0;
  if (pts.size === 2) {
    drag = null;
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  } else if (S.mode === "measure") readAt(p);
  else if (S.mode === "select" && insideSel(p) && !S.objects[S.sel].locked) drag = { start: p, dx: 0, dy: 0 };
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
    } else { S.tx += p.x - prev.x; S.ty += p.y - prev.y; applyView(); }
  }
});
const end = (e) => {
  const p = local(e);
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (e.type !== "pointerup") { drag = null; drawOverlay(); return; }
  if (drag) {
    const d = drag;
    drag = null;
    if (moved > 3) { moveSel(d.dx / pxPerPt(), -d.dy / pxPerPt()); return; }
    drawOverlay();
  }
  if (moved < 8 && pts.size === 0) {
    if (placeArmed) {
      const q = toPt(toImg(p)), t = trimOrigin();
      $("bcPosX").value = mm(q.x - t[0]); $("bcPosY").value = mm(q.y - t[1]);
      placeArmed = false; $("bcTap").classList.remove("on");
      $("readout").innerHTML = `<span>Barcode position set to ${$("bcPosX").value}, ${$("bcPosY").value} mm. Tap Add barcode.</span>`;
      showTab("bc");
      return;
    }
    if (S.mode === "select") {
      S.sel = pick(p);
      drawOverlay(); buildSelCard();
      const o = S.objects[S.sel];
      $("readout").innerHTML = o ? `<span>${esc(o.desc)}</span>` : `<span class="k">Nothing here</span>`;
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
