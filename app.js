/* W4JB Field Day section map — static GitHub Pages build.
 * Loads a pre-generated data/contacts.json and replays it client-side over the
 * time scrubber (no server, no SSE). The map/panel/filter logic is unchanged
 * from the local dashboard build; only the data source and the timebar differ. */

const state = {
  contacts: [],            // every QSO, in time order
  sorted: [],              // [{e: epochSeconds, c: contact}] for the replay cursor
  bands: new Set(),        // discovered from data
  modes: new Set(),
  bandOn: new Set(),       // active filters (all on by default)
  modeOn: new Set(),
  selected: null,          // section abbrev of clicked section
  viewTime: null,          // epoch seconds shown; null = full/complete contest
  tmin: null,              // earliest / latest contact epoch seconds
  tmax: null,
  geo: null,
  names: {},
  paths: new Map(),        // section -> <path> selection
};

// Replay driver: animates state.viewTime from tmin -> tmax over `durationMs`.
const replay = {
  playing: false,
  rafId: null,
  wallStart: 0,
  viewStart: 0,
  durationMs: 60000,       // full-contest playback wall-time (from the speed control)
  cursor: 0,               // index into state.sorted of the next contact to flash
  lastPaint: 0,
};

const THRESHOLDS = [1, 3, 6, 12, 25, 50];   // QSO-count bins for the 7-step ramp

// Far-flung sections rendered as inset boxes so the contiguous US stays large.
const INSETS = [
  { label: "AK", sections: ["AK"], rotate: [154, 0], parallels: [55, 65], w: 0.14, h: 0.22 },
  { label: "HI / PAC", sections: ["PAC"], rotate: [157, 0], parallels: [8, 18], w: 0.10, h: 0.14 },
  { label: "PR / VI", sections: ["PR", "VI"], rotate: [66, 0], parallels: [8, 18], w: 0.10, h: 0.12 },
];

const $ = (id) => document.getElementById(id);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function isDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
// Heat ramp: perceptually ordered multi-hue, brighter/hotter = more QSOs.
function ramp() {
  const interp = isDark() ? d3.interpolateInferno : d3.interpolateYlOrRd;
  const [lo, hi] = isDark() ? [0.35, 0.97] : [0.12, 0.92];
  return d3.range(7).map((i) => interp(lo + ((hi - lo) * i) / 6));
}

function epoch(ts) {
  return Date.parse(ts.replace(" ", "T") + "Z") / 1000;
}
function fmtClock(sec) {
  const d = new Date(sec * 1000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}
function fmtDayClock(sec) {
  const d = new Date(sec * 1000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${day} ${fmtClock(sec)}Z`;
}

/* ---------- filtering & aggregation ---------- */

function passesFilters(c) {
  if (!state.bandOn.has(c.band) || !state.modeOn.has(c.mode)) return false;
  if (state.viewTime !== null && epoch(c.timestamp) > state.viewTime) return false;
  return true;
}

function sectionStats() {
  const bySection = new Map();
  for (const c of state.contacts) {
    if (!passesFilters(c)) continue;
    let s = bySection.get(c.section);
    if (!s) bySection.set(c.section, (s = { count: 0, recent: [] }));
    s.count += 1;
    s.recent.push(c);
  }
  return bySection;
}

function lastVisible() {
  for (let i = state.contacts.length - 1; i >= 0; i--) {
    if (passesFilters(state.contacts[i])) return state.contacts[i];
  }
  return null;
}

function fillFor(count) {
  if (!count) return cssVar("--map-empty");
  const colors = ramp();
  let i = 0;
  while (i < THRESHOLDS.length - 1 && count >= THRESHOLDS[i + 1]) i++;
  return colors[i];
}

/* ---------- map ---------- */

function drawMap() {
  const svg = d3.select("#map");
  svg.selectAll("*").remove();
  if (!state.geo.features.length) return;
  const { width, height } = svg.node().getBoundingClientRect();

  state.paths.clear();
  const drawGroup = (feats, projection) => {
    const path = d3.geoPath(projection);
    svg.append("g").selectAll("path").data(feats).join("path")
      .attr("class", "section-shape")
      .attr("d", path)
      .each(function (d) { state.paths.set(d.properties.section, d3.select(this)); })
      .on("click", (event, d) => selectSection(d.properties.section))
      .on("mousemove", (event, d) => showTooltip(event, d.properties.section))
      .on("mouseleave", hideTooltip);
  };

  // Main map: everything except the inset sections, Albers focused on CONUS+Canada.
  const insetSections = new Set(INSETS.flatMap((d) => d.sections));
  const mainFeats = state.geo.features.filter((f) => !insetSections.has(f.properties.section));
  const mainProj = d3.geoAlbers().rotate([96, 0]).parallels([30, 50])
    .fitExtent([[8, 8], [width - 8, height - 8]],
      { type: "FeatureCollection", features: mainFeats });
  drawGroup(mainFeats, mainProj);

  // Insets along the bottom-left (empty ocean/Mexico area of the main projection).
  let x = 10;
  for (const def of INSETS) {
    const feats = state.geo.features.filter((f) => def.sections.includes(f.properties.section));
    if (!feats.length) continue;
    const w = width * def.w, h = height * def.h, y = height - h - 10;
    svg.append("rect")
      .attr("class", "inset-box")
      .attr("x", x).attr("y", y).attr("width", w).attr("height", h).attr("rx", 6);
    const proj = d3.geoAlbers().rotate(def.rotate).parallels(def.parallels)
      .fitExtent([[x + 5, y + 16], [x + w - 5, y + h - 5]],
        { type: "FeatureCollection", features: feats });
    drawGroup(feats, proj);
    svg.append("text").attr("class", "inset-label")
      .attr("x", x + 7).attr("y", y + 13).text(def.label);
    x += w + 8;
  }

  repaint();
}

function repaint() {
  const stats = sectionStats();
  for (const [section, sel] of state.paths) {
    const s = stats.get(section);
    sel.attr("fill", fillFor(s ? s.count : 0))
       .classed("selected", section === state.selected);
  }
  renderLegend();
  renderStats(stats);
  renderDetail(stats);
  renderOffMap(stats);
  renderLatest();
  renderTimebar();
}

function flashSection(section) {
  const sel = state.paths.get(section);
  if (!sel) return;
  sel.classed("flash", true);
  setTimeout(() => sel.classed("flash", false), 900);
}

/* ---------- panels ---------- */

function renderLegend() {
  const colors = ramp();
  const labels = THRESHOLDS.map((t, i) =>
    i < THRESHOLDS.length - 1 ? `${t}–${THRESHOLDS[i + 1] - 1}` : `${t}+`);
  $("legend").innerHTML =
    `<span class="lab">QSOs</span>` +
    `<span class="swatch" style="background:${cssVar("--map-empty")}"></span><span class="lab">0</span>` +
    colors.map((c) => `<span class="swatch" style="background:${c}"></span>`).join("") +
    `<span class="lab">${labels[0]} → ${labels[labels.length - 1]}</span>`;
}

function renderStats(stats) {
  let total = 0;
  for (const s of stats.values()) total += s.count;
  $("stat-qsos").textContent = total;
  $("stat-sections").textContent = [...stats.keys()].filter((k) => k !== "DX").length;
  renderClock();
}

function renderClock() {
  const t = state.viewTime !== null ? state.viewTime : state.tmax;
  if (t == null) return;
  const el = $("stat-clock");
  const text = fmtClock(t);
  if (el.textContent !== text) el.textContent = text;  // avoid needless DOM churn
}

function fmtTime(ts) {
  return ts ? ts.slice(11, 16) : "--:--";
}

function contactRows(list, n) {
  return list.slice(-n).reverse().map((c) =>
    `<tr><td>${fmtTime(c.timestamp)}</td><td class="call">${c.call}</td>` +
    `<td>${c.band}</td><td>${c.mode}</td></tr>`).join("");
}

function renderDetail(stats) {
  const table = $("detail-table");
  if (!state.selected) {
    $("detail-title").textContent = "Click a section";
    $("detail-hint").hidden = false;
    $("detail-hint").textContent =
      "Sections shade as contacts come in. Click one to see its most recent contacts.";
    table.hidden = true;
    return;
  }
  const name = state.names[state.selected] || state.selected;
  const s = stats.get(state.selected);
  $("detail-title").textContent =
    `${state.selected} — ${name} (${s ? s.count : 0} QSO${s && s.count === 1 ? "" : "s"})`;
  $("detail-hint").hidden = !!s;
  if (!s) $("detail-hint").textContent = "No contacts yet with the current filters.";
  table.hidden = !s;
  if (s) table.tBodies[0].innerHTML = contactRows(s.recent, 12);
}

function renderOffMap(stats) {
  const rows = [];
  for (const [section, s] of stats) {
    if (state.paths.has(section)) continue;
    const last = s.recent[s.recent.length - 1];
    const label = state.names[section] || `${section} (unrecognized section)`;
    rows.push(
      `<tr><td class="call" title="${label}">${section}</td>` +
      `<td>${s.count}</td><td>last: ${last.call} ${fmtTime(last.timestamp)}Z</td></tr>`);
  }
  $("offmap-table").tBodies[0].innerHTML =
    rows.join("") || `<tr><td class="panel-hint">none yet</td></tr>`;
}

function renderLatest() {
  const c = lastVisible();
  if (!c) { $("latest").textContent = "—"; return; }
  const asOf = state.viewTime !== null ? ` <span class="as-of">(as of ${fmtDayClock(state.viewTime)})</span>` : "";
  $("latest").innerHTML =
    `<span class="call">${c.call}</span> · ${c.section} · ${c.band} ${c.mode}${asOf}` +
    `<br>${c.timestamp} UTC`;
}

/* ---------- time scrubber + replay ---------- */

function renderTimebar() {
  const slider = $("time-slider");
  const label = $("time-label");
  const liveBtn = $("live-btn");
  if (state.tmin === null) {
    label.textContent = "loading…";
    return;
  }
  slider.min = state.tmin;
  slider.max = state.tmax;
  if (!slider.matches(":active")) {
    slider.value = state.viewTime !== null ? state.viewTime : state.tmax;
  }
  if (replay.playing) {
    label.textContent = `playing · ${fmtDayClock(state.viewTime)}`;
    liveBtn.classList.remove("on");
  } else if (state.viewTime !== null) {
    label.textContent = `viewing ${fmtDayClock(state.viewTime)}`;
    liveBtn.classList.remove("on");
  } else {
    label.textContent = `full contest · ${fmtDayClock(state.tmax)}`;
    liveBtn.classList.add("on");
  }
}

function setConn(status) {
  const dot = $("conn-dot");
  const label = $("conn-label");
  dot.classList.toggle("playing", status === "playing");
  dot.classList.toggle("live", status === "complete");
  label.textContent =
    status === "playing" ? "replaying" :
    status === "complete" ? "replay complete" :
    status === "paused" ? "paused" : "ready";
}

function updatePlayBtn(complete) {
  const btn = $("play-btn");
  if (replay.playing) { btn.innerHTML = "&#9208; Pause"; btn.classList.add("on"); }
  else if (complete) { btn.innerHTML = "&#8635; Replay"; btn.classList.remove("on"); }
  else { btn.innerHTML = "&#9654; Play"; btn.classList.remove("on"); }
}

function cursorFor(t) {
  // first index in state.sorted whose contact time is strictly after t
  let i = 0;
  while (i < state.sorted.length && state.sorted[i].e <= t) i++;
  return i;
}

function startReplay() {
  if (state.tmin === null) return;
  let from = state.viewTime;
  if (from === null || from >= state.tmax) from = state.tmin;  // restart from the top
  state.viewTime = from;
  replay.playing = true;
  replay.viewStart = from;
  replay.wallStart = performance.now();
  replay.cursor = cursorFor(from);
  replay.lastPaint = 0;
  setConn("playing");
  updatePlayBtn();
  replay.rafId = requestAnimationFrame(replayTick);
}

function stopReplay(complete) {
  replay.playing = false;
  if (replay.rafId) cancelAnimationFrame(replay.rafId);
  replay.rafId = null;
  updatePlayBtn(complete);
  setConn(complete ? "complete" : "paused");
}

function replayTick(now) {
  if (!replay.playing) return;
  const span = state.tmax - state.tmin;                    // contest seconds
  const progressSec = ((now - replay.wallStart) / replay.durationMs) * span;
  let vt = replay.viewStart + progressSec;

  const done = vt >= state.tmax;
  if (done) vt = state.tmax;

  // Flash sections whose contacts just became current (cap the burst on big steps).
  const flashes = [];
  while (replay.cursor < state.sorted.length && state.sorted[replay.cursor].e <= vt) {
    flashes.push(state.sorted[replay.cursor].c);
    replay.cursor++;
  }

  state.viewTime = done ? null : vt;

  // Throttle full repaints to ~15 fps; the map transitions smooth the rest.
  if (now - replay.lastPaint > 66 || done) {
    repaint();
    replay.lastPaint = now;
  } else {
    renderClock();
    renderTimebar();
  }
  for (const c of flashes.slice(-6)) if (state.bandOn.has(c.band) && state.modeOn.has(c.mode)) flashSection(c.section);

  if (done) { stopReplay(true); return; }
  replay.rafId = requestAnimationFrame(replayTick);
}

function initTimebar() {
  $("time-slider").addEventListener("input", (e) => {
    if (replay.playing) stopReplay(false);       // scrubbing pauses playback
    const v = +e.target.value;
    state.viewTime = v >= state.tmax ? null : v;
    repaint();
  });
  $("play-btn").addEventListener("click", () => {
    if (replay.playing) stopReplay(false);
    else startReplay();
  });
  $("live-btn").addEventListener("click", () => {
    if (replay.playing) stopReplay(false);
    state.viewTime = null;                        // jump to full/complete contest
    repaint();
  });
  $("speed-select").addEventListener("change", (e) => {
    replay.durationMs = (+e.target.value) * 1000;
    if (replay.playing) {                         // re-anchor so speed change is smooth
      replay.viewStart = state.viewTime;
      replay.wallStart = performance.now();
    }
  });
  setInterval(renderClock, 1000);
}

/* ---------- tooltip ---------- */

function showTooltip(event, section) {
  const stats = sectionStats();
  const s = stats.get(section);
  const last = s ? s.recent[s.recent.length - 1] : null;
  const tt = $("tooltip");
  tt.innerHTML =
    `<div class="tt-title">${section} — ${state.names[section] || section}</div>` +
    `<div class="tt-sub">${s ? s.count : 0} QSOs` +
    (last ? ` · last ${last.call} ${last.band} ${last.mode} ${fmtTime(last.timestamp)}Z` : "") + `</div>`;
  tt.hidden = false;
  const pane = tt.parentElement.getBoundingClientRect();
  tt.style.left = Math.min(event.clientX - pane.left + 14, pane.width - 250) + "px";
  tt.style.top = (event.clientY - pane.top + 14) + "px";
}
function hideTooltip() { $("tooltip").hidden = true; }

function selectSection(section) {
  state.selected = state.selected === section ? null : section;
  repaint();
}

/* ---------- filters ---------- */

function renderFilters() {
  makeChips("band-filters", [...state.bands].sort((a, b) => parseInt(b) - parseInt(a)), state.bandOn);
  makeChips("mode-filters", [...state.modes].sort(), state.modeOn);
}

function makeChips(containerId, values, onSet) {
  const box = $(containerId);
  box.querySelectorAll(".chip").forEach((el) => el.remove());
  for (const v of values) {
    const chip = document.createElement("button");
    chip.className = "chip" + (onSet.has(v) ? " on" : "");
    chip.textContent = v;
    chip.onclick = () => {
      onSet.has(v) ? onSet.delete(v) : onSet.add(v);
      renderFilters();
      repaint();
    };
    box.appendChild(chip);
  }
}

/* ---------- ingest ---------- */

function ingest(c) {
  state.contacts.push(c);
  const t = epoch(c.timestamp);
  if (state.tmin === null || t < state.tmin) state.tmin = t;
  if (state.tmax === null || t > state.tmax) state.tmax = t;
  if (c.band && !state.bands.has(c.band)) { state.bands.add(c.band); state.bandOn.add(c.band); }
  if (c.mode && !state.modes.has(c.mode)) { state.modes.add(c.mode); state.modeOn.add(c.mode); }
}

/* ---------- boot ---------- */

async function boot() {
  try {
    state.names = await (await fetch("data/section_names.json")).json();
  } catch { state.names = {}; }
  try {
    state.geo = await (await fetch("data/arrl_sections.geojson")).json();
  } catch {
    $("detail-title").textContent = "Missing map data";
    $("detail-hint").textContent =
      "data/arrl_sections.geojson not found — contacts will still appear in the off-map tally.";
    state.geo = { type: "FeatureCollection", features: [] };
  }

  let contacts = [];
  try {
    contacts = await (await fetch("data/contacts.json")).json();
  } catch {
    $("conn-label").textContent = "failed to load contacts";
  }
  contacts.sort((a, b) => epoch(a.timestamp) - epoch(b.timestamp));
  for (const c of contacts) ingest(c);
  state.sorted = state.contacts.map((c) => ({ e: epoch(c.timestamp), c }));

  renderFilters();
  initTimebar();

  // Start paused just before the first contact so the map opens empty, ready to replay.
  state.viewTime = state.tmin - 1;
  setConn("ready");
  updatePlayBtn();
  drawMap();

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint);
  new ResizeObserver(() => drawMap()).observe($("map"));
}

boot();
