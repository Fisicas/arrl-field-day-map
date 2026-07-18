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
  paths: new Map(),        // rendered section/group key -> <path> selection
  validSections: new Set(),// section codes with GeoJSON geometry
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

const THRESHOLDS = [1, 3, 6, 12, 25, 50];
const ONTARIO = {
  key: "ONTARIO",
  name: "Ontario (combined)",
  sections: ["GH", "ONE", "ONN", "ONS"],
};
const ONTARIO_SECTIONS = new Set(ONTARIO.sections);

// Far-flung sections rendered as inset boxes so the contiguous US stays large.
const INSETS = [
  { label: "AK", sections: ["AK"], rotate: [154, 0], parallels: [55, 65], w: 0.14, h: 0.22,
    compactW: 0.24, compactH: 0.86, compactSide: "west" },
  { label: "HI / PAC", sections: ["PAC"], rotate: [157, 0], parallels: [8, 18], w: 0.10, h: 0.14,
    compactW: 0.22, compactH: 0.74, compactSide: "west" },
  { label: "PR / VI", sections: ["PR", "VI"], rotate: [66, 0], parallels: [8, 18], w: 0.10, h: 0.12,
    compactW: 0.22, compactH: 0.74, compactSide: "east" },
];

const THEME_STORAGE_KEY = "field-day-map-theme";
const $ = (id) => document.getElementById(id);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function isDark() {
  return document.documentElement.dataset.theme !== "light";
}
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function updateThemeToggle() {
  const dark = isDark();
  $("theme-icon").textContent = dark ? "☀" : "☾";
  $("theme-label").textContent = dark ? "Light" : "Dark";
  $("theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
}
function applyTheme(theme, { persist = false, repaintView = false } = {}) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, document.documentElement.dataset.theme); } catch { /* unavailable */ }
  }
  updateThemeToggle();
  if (repaintView) repaint();
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* unavailable */ }
  applyTheme(saved === "light" ? "light" : "dark");
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(isDark() ? "light" : "dark", { persist: true, repaintView: true });
  });
}
// Heat ramp: perceptually ordered multi-hue, brighter/hotter = more QSOs.
function ramp() {
  const interp = isDark() ? d3.interpolateInferno : d3.interpolateYlOrRd;
  const [lo, hi] = isDark() ? [0.35, 0.97] : [0.12, 0.92];
  return d3.range(6).map((i) => interp(lo + ((hi - lo) * i) / 5));
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

function visualKey(section) {
  return ONTARIO_SECTIONS.has(section) ? ONTARIO.key : section;
}

function visualStats(stats, key) {
  if (key !== ONTARIO.key) return stats.get(key) || null;
  const recent = [];
  let count = 0;
  for (const section of ONTARIO.sections) {
    const s = stats.get(section);
    if (!s) continue;
    count += s.count;
    recent.push(...s.recent);
  }
  recent.sort((a, b) => epoch(a.timestamp) - epoch(b.timestamp));
  return count ? { count, recent } : null;
}

function renderedFeatures(features) {
  const result = [];
  let ontarioAdded = false;
  for (const feature of features) {
    const section = feature.properties.section;
    if (!ONTARIO_SECTIONS.has(section)) {
      result.push(feature);
    } else if (!ontarioAdded) {
      result.push({
        ...feature,
        properties: { ...feature.properties, section: ONTARIO.key, name: ONTARIO.name },
      });
      ontarioAdded = true;
    }
  }
  return result;
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
  const compact = window.matchMedia("(max-width: 800px)").matches;
  const insetStripHeight = compact ? Math.max(86, Math.min(112, width * 0.18)) : 0;
  const insetStripTop = height - insetStripHeight;

  state.paths.clear();
  const drawGroup = (feats, projection, region) => {
    const path = d3.geoPath(projection);
    svg.append("g").attr("data-map-region", region).selectAll("path").data(feats).join("path")
      .attr("class", "section-shape")
      .attr("d", path)
      .attr("tabindex", 0)
      .attr("role", "button")
      .each(function (d) { state.paths.set(d.properties.section, d3.select(this)); })
      .on("click", (event, d) => selectSection(d.properties.section))
      .on("keydown", (event, d) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSection(d.properties.section);
        }
      })
      .on("mousemove", (event, d) => showTooltip(event, d.properties.section))
      .on("mouseleave", hideTooltip);
  };

  // Main map: everything except the inset sections, Albers focused on CONUS+Canada.
  const insetSections = new Set(INSETS.flatMap((d) => d.sections));
  const displayFeatures = renderedFeatures(state.geo.features);
  const mainFeats = displayFeatures.filter((f) => !insetSections.has(f.properties.section));
  const mainBottom = compact ? insetStripTop - 8 : height - 8;
  const mainProj = d3.geoAlbers().rotate([96, 0]).parallels([30, 50])
    .fitExtent([[8, 8], [width - 8, mainBottom]],
      { type: "FeatureCollection", features: mainFeats });
  drawGroup(mainFeats, mainProj, "main");

  // Compact layouts reserve a separate bottom rail: AK/Pacific west, PR/VI east.
  if (compact) {
    svg.append("line").attr("class", "inset-divider")
      .attr("x1", 8).attr("x2", width - 8)
      .attr("y1", insetStripTop).attr("y2", insetStripTop);
  }
  let westX = 10;
  for (const def of INSETS) {
    const feats = displayFeatures.filter((f) => def.sections.includes(f.properties.section));
    if (!feats.length) continue;
    const w = width * (compact ? def.compactW : def.w);
    const h = compact ? insetStripHeight * def.compactH : height * def.h;
    const x = compact && def.compactSide === "east" ? width - w - 10 : westX;
    const y = compact ? insetStripTop + (insetStripHeight - h) / 2 : height - h - 10;
    svg.append("rect")
      .attr("class", "inset-box")
      .attr("x", x).attr("y", y).attr("width", w).attr("height", h).attr("rx", 6);
    const proj = d3.geoAlbers().rotate(def.rotate).parallels(def.parallels)
      .fitExtent([[x + 5, y + 16], [x + w - 5, y + h - 5]],
        { type: "FeatureCollection", features: feats });
    drawGroup(feats, proj, `inset-${def.label.toLowerCase().replaceAll(" / ", "-")}`);
    svg.append("text").attr("class", "inset-label")
      .attr("x", x + 7).attr("y", y + 13).text(def.label);
    if (!compact || def.compactSide === "west") westX += w + 8;
  }

  repaint();
}

function repaint() {
  const stats = sectionStats();
  for (const [key, sel] of state.paths) {
    const s = visualStats(stats, key);
    const label = key === ONTARIO.key ? ONTARIO.name : `${key} — ${state.names[key] || key}`;
    sel.attr("fill", fillFor(s ? s.count : 0))
       .classed("selected", key === state.selected)
       .attr("aria-pressed", key === state.selected ? "true" : "false")
       .attr("aria-label", `${label}: ${s ? s.count : 0} filtered QSO${s && s.count === 1 ? "" : "s"}`);
  }
  renderLegend();
  renderStats(stats);
  renderDetail(stats);
  renderOffMap(stats);
  renderLatest();
  renderTimebar();
}

function flashSection(section) {
  if (prefersReducedMotion()) return;
  const sel = state.paths.get(visualKey(section));
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
    `<span class="legend-title">QSOs</span>` +
    `<span class="legend-item"><span class="swatch" style="background:${cssVar("--map-empty")}"></span><span>0</span></span>` +
    colors.map((c, i) => `<span class="legend-item"><span class="swatch" style="background:${c}"></span><span>${labels[i]}</span></span>`).join("");
}

function renderStats(stats) {
  let total = 0;
  for (const s of stats.values()) total += s.count;
  $("stat-qsos").textContent = total;
  $("stat-sections").textContent = [...stats.keys()].filter((k) => state.validSections.has(k)).length;
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
    `<td>${c.section}</td><td>${c.band}</td><td>${c.mode}</td></tr>`).join("");
}

function renderDetail(stats) {
  const table = $("detail-table");
  if (!state.selected) {
    $("detail-title").textContent = "Click a section";
    $("detail-hint").hidden = false;
    $("detail-hint").textContent =
      "Sections shade as contacts come in. Click one to see its most recent contacts.";
    table.hidden = true;
    $("detail-breakdown").hidden = true;
    return;
  }
  const isOntario = state.selected === ONTARIO.key;
  const name = isOntario ? ONTARIO.name : (state.names[state.selected] || state.selected);
  const s = visualStats(stats, state.selected);
  $("detail-title").textContent = isOntario
    ? `${name} — ${s ? s.count : 0} QSO${s && s.count === 1 ? "" : "s"}`
    : `${state.selected} — ${name} (${s ? s.count : 0} QSO${s && s.count === 1 ? "" : "s"})`;
  const breakdown = $("detail-breakdown");
  breakdown.hidden = !isOntario;
  if (isOntario) {
    breakdown.innerHTML = ONTARIO.sections.map((section) => {
      const subsection = stats.get(section);
      return `<span><strong>${section}</strong>: ${subsection ? subsection.count : 0}</span>`;
    }).join("");
  }
  $("detail-hint").hidden = !!s;
  if (!s) $("detail-hint").textContent = "No contacts yet with the current filters.";
  table.hidden = !s;
  if (s) table.tBodies[0].innerHTML = contactRows(s.recent, 12);
}

function renderOffMap(stats) {
  const rows = [];
  for (const [section, s] of stats) {
    if (state.validSections.has(section)) continue;
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
  liveBtn.setAttribute("aria-pressed", state.viewTime === null ? "true" : "false");
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
  btn.setAttribute("aria-pressed", replay.playing ? "true" : "false");
  if (replay.playing) {
    btn.innerHTML = "&#9208; Pause";
    btn.setAttribute("aria-label", "Pause replay");
    btn.classList.add("on");
  } else if (complete) {
    btn.innerHTML = "&#8635; Replay";
    btn.setAttribute("aria-label", "Replay the completed contest from the beginning");
    btn.classList.remove("on");
  } else {
    btn.innerHTML = "&#9654; Play";
    btn.setAttribute("aria-label", "Play replay");
    btn.classList.remove("on");
  }
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
  repaint();
  replay.rafId = requestAnimationFrame(replayTick);
}

function stopReplay() {
  replay.playing = false;
  if (replay.rafId) cancelAnimationFrame(replay.rafId);
  replay.rafId = null;
  updatePlayBtn(false);
  setConn("paused");
  repaint();
}

function completeReplay(flashes) {
  replay.playing = false;
  replay.rafId = null;
  state.viewTime = null;
  setConn("complete");
  updatePlayBtn(true);
  repaint();
  for (const c of flashes.slice(-6)) {
    if (state.bandOn.has(c.band) && state.modeOn.has(c.mode)) flashSection(c.section);
  }
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

  if (done) {
    completeReplay(flashes);
    return;
  }

  state.viewTime = vt;

  // Throttle full repaints to ~15 fps; the map transitions smooth the rest.
  if (now - replay.lastPaint > 66 || done) {
    repaint();
    replay.lastPaint = now;
  } else {
    renderClock();
    renderTimebar();
  }
  for (const c of flashes.slice(-6)) if (state.bandOn.has(c.band) && state.modeOn.has(c.mode)) flashSection(c.section);
  replay.rafId = requestAnimationFrame(replayTick);
}

function initTimebar() {
  $("time-slider").addEventListener("input", (e) => {
    if (replay.playing) stopReplay();             // scrubbing pauses playback
    const v = +e.target.value;
    state.viewTime = v >= state.tmax ? null : v;
    if (state.viewTime === null) {
      setConn("complete");
      updatePlayBtn(true);
    } else {
      setConn("paused");
      updatePlayBtn(false);
    }
    repaint();
  });
  $("play-btn").addEventListener("click", () => {
    if (replay.playing) stopReplay();
    else startReplay();
  });
  $("live-btn").addEventListener("click", () => {
    if (replay.playing) {
      replay.playing = false;
      if (replay.rafId) cancelAnimationFrame(replay.rafId);
      replay.rafId = null;
    }
    state.viewTime = null;                        // jump to full/complete contest
    setConn("complete");
    updatePlayBtn(true);
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
  const s = visualStats(stats, section);
  const last = s ? s.recent[s.recent.length - 1] : null;
  const label = section === ONTARIO.key ? ONTARIO.name : `${section} — ${state.names[section] || section}`;
  const tt = $("tooltip");
  tt.innerHTML =
    `<div class="tt-title">${label}</div>` +
    `<div class="tt-sub">${s ? s.count : 0} QSOs` +
    (last ? ` · last ${last.call} ${last.section} ${last.band} ${last.mode} ${fmtTime(last.timestamp)}Z` : "") + `</div>`;
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
    chip.setAttribute("aria-pressed", onSet.has(v) ? "true" : "false");
    chip.setAttribute("aria-label", `${v} filter: ${onSet.has(v) ? "included" : "excluded"}`);
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
  initTheme();
  try {
    state.names = await (await fetch("data/section_names.json")).json();
  } catch { state.names = {}; }
  try {
    state.geo = await (await fetch("data/arrl_sections.geojson")).json();
    state.validSections = new Set(state.geo.features.map((f) => f.properties.section));
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

  new ResizeObserver(() => drawMap()).observe(document.querySelector(".map-pane"));
}

boot();
