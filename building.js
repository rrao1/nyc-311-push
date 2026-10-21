// Frontend for the building report-card page. Talks to /api/building, which
// runs the multi-dataset agent loop and returns a renter's summary + structured
// findings. This page also has address autocomplete (NYC GeoSearch) and a map.

const addrForm = document.getElementById("addr-form");
const addrInput = document.getElementById("addr-input");
const addrSend = document.getElementById("addr-send");
const suggestionsEl = document.getElementById("addr-suggestions");
const card = document.getElementById("report-card");
const reportTitle = document.getElementById("report-title");
const cardsEl = document.getElementById("report-cards");
const answerEl = document.getElementById("report-answer");
const statusEl = document.getElementById("status");

// ── Module state ────────────────────────────────────────────────────────────
let currentAddress = ""; // what we SHOW the user (the label, or their raw text)
let queryAddress = "";   // the cleanest string we SEND to the backend agent
let selected = null;     // the chosen GeoSearch feature, normalized (see featureToState)

// Drill-down (lazy /api/detail) state. `detailBase` is the address payload sent
// to /api/detail; `detailCache` memoizes each category's result so re-opening a
// card is instant. Both are reset at the start of every new building check.
let detailBase = null;
const detailCache = new Map();

// The default check runs a full sweep across every dataset the agent has.
const FULL_CHECK =
  "Give me a complete report card for this building. Check ALL available datasets: " +
  "housing violations (including heat, hot water, and mold), rodent inspections, and " +
  "bedbug filings. Cover each one, then give me a bottom-line verdict and what to ask the landlord.";

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADDRESS AUTOCOMPLETE — Mapbox, via our /api/geocode proxy (token stays server-side)
// ═══════════════════════════════════════════════════════════════════════════
const GEOCODE_URL = "/api/geocode";               // Mapbox via our proxy (fallback)
const GEOSEARCH_AC = "https://geosearch.planninglabs.nyc/v2/autocomplete"; // NYC's own, keyless, ~60 ms
const RECENT_KEY = "rentcheck.recent";
let debounceTimer = null;
let searchToken = 0;      // guards against out-of-order responses
let suggestions = [];     // normalized features currently shown
let activeIndex = -1;     // keyboard-highlighted row

function featureToState(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || [];
  return {
    label: p.label || "",
    lng: Number(c[0]),
    lat: Number(c[1]),
    housenumber: p.housenumber || "",
    street: p.street || "", // already in NYC format, e.g. "EAST 10 STREET"
    borough: p.borough || "",
    postalcode: p.postalcode || "",
    bbl: p.bbl || "",
  };
}

// Build the cleanest possible address string for the backend agent to parse.
function cleanQueryAddress(s) {
  const line1 = [s.housenumber, s.street].filter(Boolean).join(" ").trim();
  if (!line1) return s.label || "";
  const parts = [line1];
  if (s.borough) parts.push(s.borough);
  parts.push(s.postalcode ? `NY ${s.postalcode}` : "NY");
  return parts.join(", ");
}

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  suggestions = [];
  activeIndex = -1;
  addrInput.setAttribute("aria-expanded", "false");
}

function renderSuggestions(features) {
  suggestions = features.map(featureToState);
  if (!suggestions.length) {
    hideSuggestions();
    return;
  }
  activeIndex = -1;
  suggestionsEl.innerHTML = suggestions
    .map((s, i) => `<li role="option" id="addr-opt-${i}" data-i="${i}">${escapeHtml(s.label)}</li>`)
    .join("");
  suggestionsEl.hidden = false;
  addrInput.setAttribute("aria-expanded", "true");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// NYC's GeoSearch server is slow (~1s/request), so cache by query text —
// backspacing or retyping a prior query then renders instantly.
const suggestCache = new Map();

// A non-selectable "Searching…" row so the ~1s call never looks frozen.
function showLoading() {
  suggestions = [];
  activeIndex = -1;
  suggestionsEl.innerHTML = '<li class="loading" aria-disabled="true">Searching addresses…</li>';
  suggestionsEl.hidden = false;
  addrInput.setAttribute("aria-expanded", "true");
}

// "350 WEST 42 STREET" → "350 West 42nd Street"
function prettyStreet(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(\d+)\b(?=\s+(Street|Avenue|Place|Road|Drive|Terrace|Lane)\b)/g, (m, n) => {
      const t = n % 100, u = n % 10;
      return n + (t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th");
    });
}
// NYC GeoSearch feature → the same shape the Mapbox proxy returns.
function fromGeoSearch(f) {
  const p = f.properties || {};
  const line1 = prettyStreet(p.name || `${p.housenumber || ""} ${p.street || ""}`);
  return { geometry: f.geometry, properties: {
    label: [line1, p.borough, p.postalcode ? `NY ${p.postalcode}` : "NY"].filter(Boolean).join(", "),
    housenumber: p.housenumber || "", street: p.street || "", borough: p.borough || "", postalcode: p.postalcode || "",
    bbl: (p.addendum && p.addendum.pad && p.addendum.pad.bbl) || "" } };
}

async function fetchSuggestions(text) {
  const key = text.toLowerCase();
  const token = ++searchToken;
  let features = null;
  try {
    const res = await fetch(`${GEOSEARCH_AC}?text=${encodeURIComponent(text)}`);
    if (!res.ok) throw new Error(`GeoSearch ${res.status}`);
    features = ((await res.json()).features || []).slice(0, 6).map(fromGeoSearch);
  } catch {
    try { // fallback: Mapbox through our proxy
      const res = await fetch(`${GEOCODE_URL}?text=${encodeURIComponent(text)}`);
      if (res.ok) features = ((await res.json()).features || []).slice(0, 5);
    } catch { /* both failed */ }
  }
  if (token !== searchToken) return; // a newer keystroke already fired
  if (!features) { hideSuggestions(); return; }
  suggestCache.set(key, features);
  if (!features.length) {
    suggestions = []; activeIndex = -1;
    suggestionsEl.innerHTML = '<li class="loading" aria-disabled="true">No NYC address matches yet. Keep typing the street.</li>';
    suggestionsEl.hidden = false;
    return;
  }
  renderSuggestions(features);
}

// Recent searches (this device only) + a hint, shown as soon as the box is focused.
function readRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } }
function saveRecent(s) {
  try {
    const list = [s, ...readRecent().filter((r) => r.label !== s.label)].slice(0, 4);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage blocked: skip */ }
}
function showStarter() {
  const recent = readRecent();
  suggestions = recent;
  activeIndex = -1;
  suggestionsEl.innerHTML =
    (recent.length ? '<li class="ac-head" aria-disabled="true">Recent</li>' + recent.map((s, i) => `<li role="option" id="addr-opt-${i}" data-i="${i}">${escapeHtml(s.label)}</li>`).join("") : "") +
    '<li class="loading" aria-disabled="true">Type a street address, e.g. 30 Rockefeller Plaza</li>';
  suggestionsEl.hidden = false;
  addrInput.setAttribute("aria-expanded", "true");
}
addrInput.addEventListener("focus", () => { if (!addrInput.value.trim()) showStarter(); });

// Adopt a chosen feature: fill the input, store state, and move the map.
function selectFeature(s) {
  selected = s;
  saveRecent(s);
  currentAddress = s.label || addrInput.value.trim();
  queryAddress = cleanQueryAddress(s);
  addrInput.value = s.label || addrInput.value;
  hideSuggestions();
  if (isFinite(s.lat) && isFinite(s.lng)) showOnMap(s.lat, s.lng);
  // Selecting an address (click or Enter) immediately runs the full report —
  // no extra click needed, so it never looks like it just dropped a pin.
  checkBuilding(FULL_CHECK, true);
}

// Typing fires a debounced search and invalidates any prior selection.
addrInput.addEventListener("input", () => {
  selected = null;
  const text = addrInput.value.trim();
  clearTimeout(debounceTimer);
  if (!text) { showStarter(); return; }
  if (text.length < 2) { hideSuggestions(); return; }
  // Cached query → render instantly. Otherwise show a loading row right away
  // (so it never looks frozen) and fire the request after a short debounce.
  if (suggestCache.has(text.toLowerCase())) {
    renderSuggestions(suggestCache.get(text.toLowerCase()));
    return;
  }
  showLoading();
  debounceTimer = setTimeout(() => fetchSuggestions(text), 90);
});

// Click a suggestion to select it.
suggestionsEl.addEventListener("mousedown", (e) => {
  // mousedown (not click) so it fires before the input's blur.
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault();
  const s = suggestions[Number(li.dataset.i)];
  if (s) selectFeature(s);
});

// Keyboard navigation.
addrInput.addEventListener("keydown", (e) => {
  if (suggestionsEl.hidden || !suggestions.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % suggestions.length;
    highlightActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
    highlightActive();
  } else if (e.key === "Enter") {
    // Enter picks the highlighted (else top) result; selectFeature() then kicks
    // off the report itself. preventDefault stops a duplicate form submit.
    e.preventDefault();
    const pick = activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0];
    // Unhighlighted Enter on a top hit with a DIFFERENT house number: don't take it
    // silently; submit the typed text so the page can say "Did you mean...".
    const typed = (addrInput.value.match(/^\s*(\d+(?:-\d+)?[A-Za-z]?)/) || [])[1];
    const hn = (x) => String(x || "").toUpperCase().replace(/[\s-]+/g, "");
    if (activeIndex < 0 && pick && typed && pick.housenumber && hn(typed) !== hn(pick.housenumber)) { hideSuggestions(); addrForm.requestSubmit(); return; }
    if (pick) selectFeature(pick);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

function highlightActive() {
  suggestionsEl.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === activeIndex);
  });
  const el = suggestionsEl.querySelector("li.active");
  if (el) el.scrollIntoView({ block: "nearest" });
  addrInput.setAttribute("aria-activedescendant", activeIndex >= 0 ? `addr-opt-${activeIndex}` : "");
}

// Hide the dropdown when focus leaves the field.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".addr-field")) hideSuggestions();
});

// ═══════════════════════════════════════════════════════════════════════════
// MAP (Leaflet) — mirrors the neighborhood page's basemap + theme flip
// ═══════════════════════════════════════════════════════════════════════════
const NYC_CENTER = [40.7128, -73.9855];
let map = null;
let baseLayer = null;
let marker = null;

function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return t || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function setBasemap() {
  if (!map) return;
  const dark = currentTheme() === "dark";
  // Esri Canvas basemaps: free, no API key (CARTO started requiring one).
  // Base + label layers, in a light and a dark gray to match the theme.
  const shade = dark ? "Dark" : "Light";
  const esri = (layer) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${shade}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
  const opts = { maxZoom: 16 }; // Canvas tiles stop at z16; deeper zoom looks blurry
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.layerGroup([
    L.tileLayer(esri("Base"), { ...opts, zIndex: 1, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }),
    L.tileLayer(esri("Reference"), { ...opts, zIndex: 2 }),
  ]).addTo(map);
}

function ensureMap() {
  if (map) return;
  map = L.map("building-map", { zoomControl: true, maxZoom: 16 }).setView(NYC_CENTER, 11);
  setBasemap();
}

function pinIcon() {
  return L.divIcon({
    className: "bld-pin-wrap",
    html: `<span class="bld-pin"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 16],
  });
}

function showOnMap(lat, lng) {
  // Reveal the (initially hidden) location strip + fill its label and Maps link.
  const strip = document.getElementById("location-strip");
  if (strip) strip.hidden = false;
  const addrEl = document.getElementById("loc-addr");
  if (addrEl) addrEl.textContent = currentAddress || "";
  const mapsLink = document.getElementById("loc-maps-link");
  if (mapsLink) mapsLink.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(currentAddress || `${lat},${lng}`);
  // Init the map lazily now that its container is visible (avoids 0-size init).
  ensureMap();
  map.invalidateSize();
  if (marker) marker.remove();
  marker = L.marker([lat, lng], { icon: pinIcon() }).addTo(map);
  map.setView([lat, lng], 16, { animate: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT CARDS — one per structured finding from the backend
// ═══════════════════════════════════════════════════════════════════════════
const ICONS = {
  // Clipboard-with-check → housing violations record
  violations:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/><path d="M8.5 13.2l2.2 2.2 4.3-4.6"/></svg>',
  // Magnifying glass → inspection
  rodent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
  // Bed → bedbug filings (a bed, not a bug)
  bedbug:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v10"/><path d="M21 20v-5a3 3 0 0 0-3-3H3"/><path d="M3 15h18"/><path d="M7 12v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/></svg>',
};

const TITLES = {
  violations: "Housing Violations",
  rodent: "Rodent Inspections",
  bedbug: "Bedbug Filings",
};

// Map a finding to { status: 'green'|'amber'|'red', stat, note }.
// Status reflects the CURRENT/open risk — resolved history is not a warning.
function assess(f) {
  if (f.type === "violations") {
    const total = Number(f.total_violations) || 0;
    const openHaz = Number(f.open_hazardous_class_C) || 0;
    const openByClass = f.open_violations_by_class || {};
    let open = 0;
    for (const v of Object.values(openByClass)) open += Number(v) || 0;
    if (openHaz > 0)
      return { status: "red", stat: `${open} open · ${openHaz} hazardous · ${total} on record`, note: "Open hazardous (class C) violations right now" };
    if (open > 0)
      return { status: "amber", stat: `${open} open · ${total} on record`, note: "Some open violations (none hazardous)" };
    if (total > 0)
      return { status: "green", stat: `0 open · ${total} resolved`, note: "No open violations; past ones resolved" };
    return { status: "green", stat: "None on record", note: "No housing violations on record" };
  }
  if (f.type === "rodent") {
    const results = f.results || {};
    let passed = 0, failed = 0;
    for (const [k, v] of Object.entries(results)) {
      const n = Number(v) || 0;
      if (/passed/i.test(k)) passed += n;
      else if (/failed/i.test(k)) failed += n;
    }
    const ratFails = Number(f.failed_for_rat_activity) || 0;
    const stat = `${passed} passed · ${failed} failed`;
    if (ratFails > 0) return { status: "red", stat, note: "Failed an inspection for rat activity" };
    if (failed > 0) return { status: "amber", stat, note: "Some failed inspections on record" };
    return { status: "green", stat, note: "Passed inspections; no rat activity" };
  }
  // bedbug — filings are largely mandatory ANNUAL reports; only an ACTIVE
  // (net, still-uneradicated) infestation or a recurrence is a real flag. A
  // building whose every past infestation was eradicated is GREEN, but we stay
  // honest and note the history rather than hide it.
  const filings = Number(f.filings) || 0;
  const infested = Number(f.infested_units) || 0;
  const netActive = f.net_active != null ? Number(f.net_active) : Math.max(0, infested - (Number(f.eradicated_units) || 0));
  const reInfested = Number(f.re_infested) || 0;
  if (netActive > 0)
    return { status: "red", stat: `${netActive} infested in latest filing · ${filings} filings`, note: `${netActive} unit${netActive > 1 ? "s" : ""} infested in the latest filing` };
  if (reInfested > 0)
    return { status: "red", stat: `Recurring · ${filings} filings`, note: "Recurring infestations reported" };
  if (infested > 0)
    return { status: "green", stat: `0 active · ${filings} filings`, note: "Past reports, all eradicated" };
  if (filings > 0)
    return { status: "green", stat: `0 infested · ${filings} annual filings`, note: "No infestations reported" };
  return { status: "green", stat: "None on record", note: "No bedbug filings on record" };
}

const CARD_ORDER = ["violations", "rodent", "bedbug"];

// Format a Socrata ISO date. `month` → "Mar 2026"; otherwise "Mar 15, 2026".
function fmtDate(iso, monthOnly = false) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US",
    monthOnly ? { month: "short", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

const CHEVRON =
  '<svg class="rc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// Plain-language empty-state per category.
function emptyMsg(t) {
  return t === "violations" ? "No individual violation records on file." :
         t === "rodent" ? "No inspection records on file." :
         "No bedbug filings on file.";
}

// Render a list of individual records (used for both the flagged + recent
// sections). Record shapes: violations {date,class,status,desc},
// rodent {date,result}, bedbug {date,infested,eradicated}.
function recordRows(t, records) {
  const rows = records.map((r) => {
    if (t === "violations") {
      const isOpen = /^open/i.test(r.status || "");
      const cls = (r.class || "").toUpperCase();
      return `<li class="rec">
          <span class="rec-date">${escapeHtml(fmtDate(r.date) || "Date n/a")}</span>
          <span class="rec-tags">
            <span class="rec-tag ${isOpen ? "open" : "closed"}">${escapeHtml(r.status || "—")}</span>
            ${cls ? `<span class="rec-class rec-class-${cls === "C" ? "c" : "x"}">Class ${escapeHtml(cls)}</span>` : ""}
          </span>
          ${r.desc ? `<span class="rec-desc">${escapeHtml(r.desc)}</span>` : ""}
        </li>`;
    }
    if (t === "rodent") {
      const failed = /(failed|rat activity|active)/i.test(r.result || "");
      return `<li class="rec">
          <span class="rec-date">${escapeHtml(fmtDate(r.date) || "Date n/a")}</span>
          <span class="rec-tags"><span class="rec-tag ${failed ? "open" : "closed"}">${escapeHtml(r.result || "—")}</span></span>
        </li>`;
    }
    // bedbug — an ACTIVE infestation is infested beyond what was eradicated.
    const infested = Number(r.infested) || 0;
    const eradicated = Number(r.eradicated) || 0;
    const active = Math.max(0, infested - eradicated);
    const label = active > 0
      ? `${active} unit${active > 1 ? "s" : ""} still infested`
      : infested > 0 ? `${infested} infested, all eradicated` : "No infestation";
    return `<li class="rec">
        <span class="rec-date">${escapeHtml(fmtDate(r.date) || "Date n/a")}</span>
        <span class="rec-tags"><span class="rec-tag ${active > 0 ? "open" : "closed"}">${escapeHtml(label)}</span></span>
      </li>`;
  }).join("");
  return `<ul class="rec-list">${rows}</ul>`;
}

// JOB D — "check the receipts" source links. Official NYC Open Data dataset
// page for each category, plus HPD Online for the two HPD datasets. Rendered
// with a red accent when the category is flagged so verification is prominent.
const DATASET_IDS = { violations: "wvxf-dwi5", rodent: "p937-wjvj", bedbug: "wz6d-d3jb" };
function sourceLinks(t, status) {
  const id = DATASET_IDS[t];
  const links = [
    `<a class="rc-src" href="https://data.cityofnewyork.us/d/${id}" target="_blank" rel="noopener">Verify on NYC Open Data →</a>`,
  ];
  if (t === "violations" || t === "bedbug") {
    links.push(`<a class="rc-src" href="https://hpdonline.nyc.gov/hpdonline/" target="_blank" rel="noopener">HPD Online (official building lookup) →</a>`);
  }
  return `<div class="rc-sources${status === "red" ? " flagged" : ""}">
      <span class="rc-src-label">Check the receipts</span>
      ${links.join("")}
    </div>`;
}

// Render the lazily-loaded drill-down: a TL;DR summary, a highlighted
// "Needs attention" section (flagged records of ANY age), then recent history.
function renderDetail(el, t, data) {
  const flagged = Array.isArray(data.flagged) ? data.flagged : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  let html = "";
  if (data.summary) html += `<div class="rc-tldr">${escapeHtml(data.summary)}</div>`;
  if (flagged.length) {
    html += `<div class="rc-flagged">
        <div class="rc-flagged-head"><span aria-hidden="true">⚠️</span>Needs attention</div>
        ${recordRows(t, flagged)}
      </div>`;
  }
  html += `<div class="rc-recent"><div class="rc-section-head">Recent history</div>` +
    (recent.length ? recordRows(t, recent) : `<div class="rc-empty">${emptyMsg(t)}</div>`) +
    `</div>`;
  el.innerHTML = html;
}

// Fetch (and cache) a category's drill-down the FIRST time its card is opened.
async function loadDetail(item, t) {
  const el = item.querySelector(".rc-detail");
  if (!el || el.dataset.loaded === "true" || el.dataset.loading === "true") return;

  const cached = detailCache.get(t);
  if (cached) { renderDetail(el, t, cached); el.dataset.loaded = "true"; return; }

  el.dataset.loading = "true";
  el.innerHTML = '<div class="rc-detail-loading"><span class="spinner"></span><span class="loading-text">Pulling the records…</span></div>';
  try {
    const res = await fetch("/api/detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: t, ...(detailBase || {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    detailCache.set(t, data);
    renderDetail(el, t, data);
    el.dataset.loaded = "true";
  } catch (err) {
    el.innerHTML = `<div class="rc-empty">Couldn't load the detailed records (${escapeHtml(err.message)}). The source links below still work.</div>`;
  } finally {
    el.dataset.loading = "false";
  }
}

// Overall letter grade. CURRENT/open issues (red) drive it; a few open-but-minor
// items (amber) nudge it; fully-resolved history barely matters.
function gradeFor(assessed) {
  let red = 0, amber = 0;
  for (const { a } of assessed) { if (a.status === "red") red++; else if (a.status === "amber") amber++; }
  let grade;
  if (red >= 3) grade = "F";
  else if (red === 2) grade = "D";
  else if (red === 1) grade = "C";
  else if (amber === 0) grade = "A+";
  else if (amber === 1) grade = "A";
  else if (amber === 2) grade = "A-";
  else grade = "B";

  // A little judgment: a spotless CURRENT record but a heavy RESOLVED history
  // (lots of past violations) isn't a pristine A+ — nudge down one notch.
  const v = assessed.find((x) => x.t === "violations");
  const totalV = v ? Number(v.f.total_violations) || 0 : 0;
  if (grade === "A+" && totalV >= 15) grade = "A";

  const worst = red > 0 ? "red" : amber > 0 ? "amber" : "green";
  const headline =
    red > 0 ? "Open issues on record" :
    amber > 0 ? "Mostly clean, a few things to check" :
    totalV >= 15 ? "Clean now, with past history" :
    "Clean record";
  return { grade, worst, headline };
}

function renderCards(findings, severity) {
  if (!Array.isArray(findings) || !findings.length) {
    cardsEl.hidden = true;
    cardsEl.innerHTML = "";
    return;
  }
  const byType = {};
  for (const f of findings) if (f && f.type) byType[f.type] = f;
  const present = CARD_ORDER.filter((t) => byType[t]);
  if (!present.length) {
    cardsEl.hidden = true;
    cardsEl.innerHTML = "";
    return;
  }

  // The per-card STATUS (colour) and its note come from the backend severity
  // rule (api/severity.js) — the single source of truth, with recency windowing.
  // assess() still supplies the human-readable stat line. Falling back to
  // assess()'s own status keeps things working if severity is ever absent.
  const cardStatus = (severity && severity.cards) || {};
  const assessed = present.map((t) => {
    const a = assess(byType[t]);
    const s = cardStatus[t];
    if (s) { a.status = s.status; if (s.note) a.note = s.note; }
    return { t, f: byType[t], a };
  });

  // Banner: a not-found address must NOT show a glowing letter grade (the visual
  // twin of the false-glow we fixed in the prose). Otherwise, the letter grade
  // is derived from the (now authoritative) card statuses.
  let grade, worst, headline;
  if (severity && severity.band === "NOT_FOUND") {
    grade = "?";
    worst = "amber";
    headline = "No city records found. Verify the address";
  } else {
    ({ grade, worst, headline } = gradeFor(assessed));
  }

  const banner = `<div class="grade-banner" data-status="${worst}">
      <div class="grade-letter">${grade}</div>
      <div class="grade-caption">
        <div class="grade-headline">${headline}</div>
        <div class="grade-sub">Overall grade across ${present.length} record${present.length > 1 ? "s" : ""} checked</div>
      </div>
    </div>`;

  const cards = assessed
    .map(({ t, f, a }) => {
      const pid = `rc-panel-${t}`;
      // Violations: surface the most-recent OPEN date up front (from the main
      // finding) — it drives the status and shouldn't wait on the lazy fetch.
      const openFlag = (t === "violations" && f.latest_open_date)
        ? `<div class="rc-open-flag"><span class="rc-open-dot"></span>Most recent open: <strong>${escapeHtml(fmtDate(f.latest_open_date, true))}</strong></div>`
        : "";
      return `<div class="report-card-item" data-status="${a.status}" data-type="${t}">
        <button type="button" class="rc-head" aria-expanded="false" aria-controls="${pid}">
          <span class="rc-icon" aria-hidden="true">${ICONS[t] || ""}</span>
          <span class="rc-body">
            <span class="rc-title">${TITLES[t]}</span>
            <span class="rc-stat">${escapeHtml(a.stat)}</span>
            <span class="rc-note"><span class="rc-dot"></span>${escapeHtml(a.note)}</span>
          </span>
          <span class="rc-view">View details${CHEVRON}</span>
        </button>
        <div class="rc-panel" id="${pid}" role="region" aria-label="${escapeHtml(TITLES[t])} records" hidden>
          ${openFlag}
          <div class="rc-detail" data-loaded="false"></div>
          ${sourceLinks(t, a.status)}
        </div>
      </div>`;
    })
    .join("");

  cardsEl.innerHTML = banner + cards;
  cardsEl.hidden = false;
}

// Expand/collapse a card's "receipts" panel (delegated — cards re-render often).
cardsEl.addEventListener("click", (e) => {
  const head = e.target.closest(".rc-head");
  if (!head) return;
  const item = head.closest(".report-card-item");
  const panel = item.querySelector(".rc-panel");
  const isOpen = head.getAttribute("aria-expanded") === "true";
  head.setAttribute("aria-expanded", isOpen ? "false" : "true");
  item.classList.toggle("open", !isOpen);
  panel.hidden = isOpen;
  // First open → lazily fetch this category's full drill-down (cached after).
  if (!isOpen) loadDetail(item, item.dataset.type);
});

// Tiny, safe markdown renderer: headings, bullets, dividers, **bold**.
// Everything is HTML-escaped first, so model output can never inject markup.
function renderAnswer(text) {
  // Plain prose only: drop any title line, "Bottom line:" prefix, markdown marks.
  let clean = String(text || "").trim()
    .replace(/^#+\s.*\n/, "")
    .replace(/^\**\s*bottom\s*line\s*\**\s*[:\-–—]*\s*\**\s*/i, "");
  const lines = clean.split("\n");
  if (lines.length > 1 && /^\*\*.+\*\*$/.test(lines[0].trim())) clean = lines.slice(1).join(" ");
  clean = clean.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^[-•]\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
  // First sentence becomes the lede.
  const m = clean.match(/^(.+?[.!?])(\s+|$)(.*)$/);
  const lede = m ? m[1] : clean, rest = m ? m[3] : "";
  answerEl.innerHTML =
    '<div class="take">' +
      '<div class="take-label">The short version</div>' +
      `<p class="take-lede">${escapeHtml(lede)}</p>` +
      (rest ? `<p class="take-body">${escapeHtml(rest)}</p>` : "") +
      '<p class="take-foot">Written by Claude from the records on this page. Double-check anything important before you sign.</p>' +
    "</div>";
  answerEl.hidden = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK FLOW
// ═══════════════════════════════════════════════════════════════════════════

// A progress display shown while the report loads. The three dataset checks now
// run in PARALLEL on the server and finish fast, so we complete them in a quick
// satisfying stagger — then land on a lively "Writing your report" phase (an
// indeterminate bar + rotating captions) that stays honest until the model
// finishes, instead of a spinner that looks stuck.
const LOADING_STEPS = [
  "Checking HPD housing violations",
  "Scanning DOHMH rodent inspections",
  "Reviewing HPD bedbug filings",
];
const WRITING_CAPTIONS = [
  "Cross-referencing records…",
  "Tallying open vs. resolved…",
  "Checking inspection history…",
  "Weighing what matters for renters…",
  "Drafting your bottom line…",
];
let loadTimers = [];

function startLoading() {
  stopLoading();
  answerEl.classList.remove("error");
  answerEl.hidden = false;
  answerEl.innerHTML =
    '<div class="take is-pending">' +
      '<div class="take-label">The short version</div>' +
      '<span class="skel-line"></span><span class="skel-line"></span><span class="skel-line w60"></span>' +
      `<p class="take-foot" aria-live="polite">${escapeHtml(WRITING_CAPTIONS[0])}</p>` +
    "</div>";
  const caption = answerEl.querySelector(".take-foot");
  let ci = 0;
  loadTimers.push(setInterval(() => { ci = (ci + 1) % WRITING_CAPTIONS.length; caption.textContent = WRITING_CAPTIONS[ci]; }, 1500));
}

// The final phase: reveal the indeterminate bar and cycle micro-captions so the
// wait for the model never looks frozen.
function startWriting(writing, caption) {
  if (!writing) return;
  writing.hidden = false;
  let ci = 0;
  if (caption) caption.textContent = WRITING_CAPTIONS[0];
  loadTimers.push(setInterval(() => {
    ci = (ci + 1) % WRITING_CAPTIONS.length;
    if (caption) caption.textContent = WRITING_CAPTIONS[ci];
  }, 1500));
}

function stopLoading() {
  for (const t of loadTimers) { clearTimeout(t); clearInterval(t); }
  loadTimers = [];
}

// full === true → the fast path (mode:"full"): backend queries all three
// datasets in parallel and makes ONE model call to write the summary.
// full === false → a focused question routed through the agent loop.
async function checkBuilding(ask, full = false) {
  if (!queryAddress) {
    setStatus("Enter a building address first.", true);
    return;
  }
  // Reset the drill-down cache and capture the address payload /api/detail
  // will use — the same structured fields (falling back to the raw string).
  detailCache.clear();
  detailBase = { address: queryAddress };
  if (selected) {
    if (selected.postalcode) detailBase.zip = selected.postalcode;
    if (selected.borough) detailBase.borough = selected.borough;
    if (selected.housenumber) detailBase.house_number = selected.housenumber;
    if (selected.street) detailBase.street_name = selected.street;
  }

  card.hidden = false;
  reportTitle.textContent = "AI summary";
  document.getElementById("viz").hidden = false;
  document.body.classList.add("has-results"); // collapse the intro once there's something to show
  cardsEl.hidden = true;
  cardsEl.innerHTML = "";
  answerEl.hidden = false;
  answerEl.classList.remove("error");
  startLoading();
  setStatus("");
  addrSend.disabled = true;

  // Shareable link for exactly what's on screen.
  if (full) {
    try {
      const u = new URL(window.location.href), apt = (document.getElementById("apt-input").value || "").trim();
      u.searchParams.set("address", queryAddress);
      if (apt) u.searchParams.set("apt", apt); else u.searchParams.delete("apt");
      history.replaceState(null, "", u);
    } catch { /* ignore */ }
  }

  // The dashboard resolves the address to ONE building (refusing a different house
  // number). The AI summary runs only for that building, keyed by its BBL.
  let viz = null;
  if (full && window.BuildingViz) {
    viz = await window.BuildingViz.render(queryAddress);
    if (viz.stale) return; // a newer check took over
    if (!viz.ok) {
      stopLoading();
      card.hidden = true;
      answerEl.hidden = true;
      answerEl.innerHTML = "";
      addrSend.disabled = false;
      return;
    }
    const label = [prettyStreet(viz.label), viz.borough].filter(Boolean).join(", ");
    currentAddress = label;
    if (isFinite(viz.lat) && isFinite(viz.lng)) showOnMap(viz.lat, viz.lng);
    if (!selected) selected = { label, housenumber: viz.housenumber, street: viz.street, borough: viz.borough, postalcode: viz.postalcode, bbl: viz.bbl };
    if (viz.postalcode) detailBase.zip = viz.postalcode;
    if (viz.borough) detailBase.borough = viz.borough;
    if (viz.housenumber) detailBase.house_number = viz.housenumber;
    if (viz.street) detailBase.street_name = viz.street;
  }

  let body;
  if (full) {
    body = { mode: "full", address: viz && viz.ok ? currentAddress : queryAddress };
    if (selected && selected.bbl) body.bbl = selected.bbl;
    if (viz && viz.ok) body.bbl = viz.bbl; // the building the dashboard shows, always
    if (selected) {
      if (selected.postalcode) body.zip = selected.postalcode;
      if (selected.borough) body.borough = selected.borough;
      if (selected.housenumber) body.house_number = selected.housenumber;
      if (selected.street) body.street_name = selected.street;
    }
  } else {
    body = { question: `For the building at ${queryAddress}: ${ask}` };
    if (selected && selected.postalcode) body.zip = selected.postalcode;
  }

  try {
    const res = await fetch("/api/building", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    renderCards(data.findings, data.severity);
    renderAnswer(data.answer);
    answerEl.dataset.band = (data.severity && data.severity.band) || "";
  } catch (err) {
    cardsEl.hidden = true;
    answerEl.classList.add("error");
    answerEl.textContent =
      `${err.message}\n\n(The report card needs the serverless function running. It works once deployed to Vercel with ANTHROPIC_API_KEY set, or locally via "vercel dev".)`;
  } finally {
    stopLoading();
    addrSend.disabled = false;
  }
}

// Submitting the address = a full check. If the user didn't pick a suggestion,
// best-effort geocode their text so the map still moves and the lookup is clean.
addrForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideSuggestions();
  const val = addrInput.value.trim();
  if (!val) return;

  if (selected && selected.label === val) {
    // already have a clean selection with coords + fields
  } else {
    // Send the user's own text: the dashboard's resolver checks the house number and
    // refuses (with "Did you mean...") rather than silently showing a different building.
    selected = null;
    currentAddress = val;
    queryAddress = val;
  }
  checkBuilding(FULL_CHECK, true);
});

// Shareable links: building.html?address=169+East+109+Street,+Manhattan runs the check.
(function runFromUrl() {
  const a = new URLSearchParams(window.location.search).get("address");
  if (!a) return;
  addrInput.value = a;
  const apt = new URLSearchParams(window.location.search).get("apt");
  if (apt) document.getElementById("apt-input").value = apt;
  addrForm.requestSubmit();
})();

// Chips: fill the address box, or ask a specific question.
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.fill) {
    addrInput.value = chip.dataset.fill;
    addrInput.focus();
  } else if (chip.dataset.ask) {
    if (!queryAddress) {
      currentAddress = addrInput.value.trim();
      queryAddress = currentAddress;
    }
    checkBuilding(chip.dataset.ask);
  }
});

// Theme toggle (same behavior as the neighborhood page — also reflows basemap).
document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const isDark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.getAttribute("data-theme") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", isDark ? "light" : "dark");
  setBasemap();
  if (window.BuildingViz) window.BuildingViz.refreshTheme();
});
