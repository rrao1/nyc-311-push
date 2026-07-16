// ---- NYC 311 neighborhood dashboard ----
// The dashboard reads aggregated data straight from NYC's Socrata Open Data API.
// No API key is needed for this part — the counting happens on NYC's servers,
// so the browser only ever downloads ~12 small rows, not millions.

const SODA_ENDPOINT = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const MONTHS_BACK = 12;
const TOP_N = 12;

// --- Elements ---
const form = document.getElementById("zip-form");
const zipInput = document.getElementById("zip-input");
const results = document.getElementById("results");
const statRow = document.getElementById("stat-row");
const chartEl = document.getElementById("chart");
const chartTitle = document.getElementById("chart-title");
const chartCaption = document.getElementById("chart-caption");
const statusEl = document.getElementById("status");
const mapCaption = document.getElementById("map-caption");
const aiForm = document.getElementById("ai-form");
const aiInput = document.getElementById("ai-input");
const aiAnswer = document.getElementById("ai-answer");
const aiSend = document.getElementById("ai-send");

// Holds the most recently loaded data so the AI box can reference it.
let currentData = { zip: null, complaints: [], total: 0, since: null };

// --- Helpers ---
function sinceDateISO() {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS_BACK);
  return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

// Count-up animation for stat values (handles plain numbers and "62%").
function animateCount(el, targetText) {
  const isPct = String(targetText).includes("%");
  const num = parseFloat(String(targetText).replace(/[^0-9.]/g, ""));
  if (!isFinite(num)) {
    el.textContent = targetText;
    return;
  }
  const dur = 650;
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(num * eased);
    el.textContent = isPct ? val + "%" : val.toLocaleString("en-US");
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = targetText;
  }
  requestAnimationFrame(tick);
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// --- Data fetch ---
async function fetchTopComplaints(zip) {
  const since = sinceDateISO();
  const where = `incident_zip='${zip}' AND created_date >= '${since}'`;
  const params = new URLSearchParams({
    "$select": "complaint_type, count(*) AS count",
    "$where": where,
    "$group": "complaint_type",
    "$order": "count DESC",
    "$limit": String(TOP_N),
  });
  const url = `${SODA_ENDPOINT}?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NYC Open Data returned ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    type: titleCase(r.complaint_type || "Unknown"),
    count: Number(r.count) || 0,
  }));
}

// --- Render ---
function renderStats(complaints, total) {
  const top = complaints[0];
  const topShare = top && total ? Math.round((top.count / total) * 100) : 0;
  const tiles = [
    { value: fmt(total), label: "Total · last 12 mo" },
    { value: complaints.length ? `${topShare}%` : "—", label: "Top complaint share" },
    { value: fmt(complaints.length), label: "Complaint types" },
  ];
  statRow.innerHTML = tiles
    .map(
      (t) => `<div class="stat">
        <div class="stat-value">${t.value}</div>
        <div class="stat-label">${t.label}</div>
      </div>`
    )
    .join("");
  statRow.querySelectorAll(".stat-value").forEach((el) => animateCount(el, el.textContent));
}

function renderChart(complaints) {
  if (!complaints.length) {
    chartEl.innerHTML = `<p class="stat-label">No complaints found for this ZIP in the last 12 months.</p>`;
    return;
  }
  const max = complaints[0].count;
  chartEl.innerHTML = complaints
    .map(
      (c) => `<div class="bar-row filterable" data-type="${c.type}">
        <div class="bar-label"><span class="name" title="${c.type}">${c.type}</span><span class="count">${fmt(c.count)}</span></div>
        <div class="bar-track"><div class="bar-fill" data-w="${(c.count / max) * 100}"></div></div>
      </div>`
    )
    .join("");
  // Animate widths after paint.
  requestAnimationFrame(() => {
    chartEl.querySelectorAll(".bar-fill").forEach((el) => {
      el.style.width = el.dataset.w + "%";
    });
  });
}

// --- Session cache (re-viewing a ZIP in this session is instant) ---
const CACHE_PREFIX = "nyc311:";
function readCache(zip) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + zip);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeCache(zip, payload) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + zip, JSON.stringify(payload));
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

// --- Skeleton (shown immediately so the wait feels intentional) ---
function showSkeleton(zip) {
  chartTitle.textContent = `Top complaints in ${zip}`;
  chartCaption.textContent = "Last 12 months";
  statRow.innerHTML = Array.from({ length: 3 })
    .map(
      () =>
        `<div class="stat"><div class="skeleton skeleton-value"></div><div class="skeleton skeleton-label"></div></div>`
    )
    .join("");
  chartEl.innerHTML = Array.from({ length: 8 })
    .map(
      (_, i) =>
        `<div class="bar-row">
          <div class="bar-label">
            <span class="skeleton skeleton-name" style="width:${58 - i * 4}%"></span>
            <span class="skeleton skeleton-count"></span>
          </div>
          <div class="bar-track"><div class="skeleton skeleton-bar" style="width:${92 - i * 9}%"></div></div>
        </div>`
    )
    .join("");
  results.hidden = false;
}

function render(zip, complaints, total) {
  currentData = { zip, complaints, total, since: sinceDateISO() };
  chartTitle.textContent = `Top complaints in ${zip}`;
  chartCaption.textContent = "Last 12 months";
  renderStats(complaints, total);
  renderChart(complaints);
  results.hidden = false;
}

// --- Map (Leaflet) ---
const NYC_CENTER = [40.7128, -73.9855];

// Complaint categories → colors (from the validated categorical palette).
const CATEGORIES = [
  { key: "noise", label: "Noise", color: "#2a78d6", match: /noise/i },
  { key: "parking", label: "Parking & Vehicles", color: "#1baf7a", match: /parking|driveway|vehicle|traffic|blocked/i },
  { key: "sanitation", label: "Sanitation & Rodents", color: "#eda100", match: /sanitation|dirty|unsanitary|rodent|garbage|trash|litter|missed collection|sweeping/i },
  { key: "housing", label: "Housing & Heat", color: "#4a3aa7", match: /heat|hot water|plumbing|paint|plaster|apartment|door|window|electric|appliance|mold|construction|elevator/i },
  { key: "streets", label: "Streets & Infrastructure", color: "#eb6834", match: /street|sidewalk|curb|pothole|water system|sewer|snow|ice|highway|signal|light/i },
  { key: "other", label: "Other", color: "#898781", match: /.*/ },
];
function categorize(type) {
  return CATEGORIES.find((c) => c.match.test(type)) || CATEGORIES[CATEGORIES.length - 1];
}

let map = null;
let markerLayer = null;
let baseLayer = null;
let legendControl = null;
let allPoints = [];
let activeType = null;

function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return t || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function setBasemap() {
  if (!map) return;
  const dark = currentTheme() === "dark";
  const url = dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(url, {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
  baseLayer.bringToBack();
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView(NYC_CENTER, 11);
  setBasemap();
  markerLayer = L.markerClusterGroup({
    chunkedLoading: true,
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 34 : n < 100 ? 42 : 52;
      return L.divIcon({
        html: `<div class="cx-cluster" style="width:${size}px;height:${size}px">${n}</div>`,
        className: "",
        iconSize: [size, size],
      });
    },
  }).addTo(map);
}

function dotIcon(color) {
  return L.divIcon({
    className: "cx-dot-wrap",
    html: `<span class="cx-dot" style="background:${color}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
}

function popupHtml(p) {
  const cat = categorize(p.type);
  const date = p.date
    ? new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
  return `<div class="map-popup">
    <span class="mp-chip" style="--c:${cat.color}">${cat.label}</span>
    <div class="mp-title">${p.type}</div>
    ${p.descriptor ? `<div class="mp-desc">${p.descriptor}</div>` : ""}
    ${p.address ? `<div class="mp-addr">${p.address}</div>` : ""}
    <div class="mp-meta">${date} · ${p.status || "unknown status"}</div>
  </div>`;
}

function renderMarkers(points) {
  markerLayer.clearLayers();
  const markers = points.map((p) =>
    L.marker([p.lat, p.lng], { icon: dotIcon(categorize(p.type).color) }).bindPopup(popupHtml(p))
  );
  markerLayer.addLayers(markers);
}

function updateLegend() {
  if (legendControl) {
    map.removeControl(legendControl);
    legendControl = null;
  }
  const present = new Set(allPoints.map((p) => categorize(p.type).key));
  const cats = CATEGORIES.filter((c) => present.has(c.key));
  if (!cats.length) return;
  legendControl = L.control({ position: "bottomright" });
  legendControl.onAdd = () => {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML = cats
      .map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`)
      .join("");
    return div;
  };
  legendControl.addTo(map);
}

async function fetchComplaintPoints(zip) {
  const since = sinceDateISO();
  const where = `incident_zip='${zip}' AND created_date >= '${since}' AND latitude IS NOT NULL`;
  const params = new URLSearchParams({
    "$select": "latitude, longitude, complaint_type, descriptor, created_date, status, incident_address",
    "$where": where,
    "$order": "created_date DESC",
    "$limit": "800",
  });
  const res = await fetch(`${SODA_ENDPOINT}?${params.toString()}`);
  if (!res.ok) throw new Error(`points ${res.status}`);
  const rows = await res.json();
  return rows
    .map((r) => ({
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      type: titleCase(r.complaint_type || "Unknown"),
      descriptor: r.descriptor || "",
      date: r.created_date || "",
      status: r.status || "",
      address: r.incident_address || "",
    }))
    .filter((p) => p.lat && p.lng);
}

function applyMapFilter() {
  const pts = activeType ? allPoints.filter((p) => p.type === activeType) : allPoints;
  renderMarkers(pts);
  chartEl.querySelectorAll(".bar-row").forEach((r) => {
    r.classList.toggle("active", r.dataset.type === activeType);
  });
  if (pts.length) {
    map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), {
      padding: [30, 30], maxZoom: 16, duration: 0.8,
    });
  }
  mapCaption.textContent = activeType
    ? `Showing “${activeType}” — click the bar again to reset`
    : `${allPoints.length} recent located complaints · click a bar to filter`;
}

async function loadPoints(zip) {
  ensureMap();
  map.setView(NYC_CENTER, 11); // start city-wide, then fly in
  map.invalidateSize();
  markerLayer.clearLayers();
  mapCaption.textContent = "Loading map…";
  try {
    allPoints = await fetchComplaintPoints(zip);
    renderMarkers(allPoints);
    updateLegend();
    if (allPoints.length) {
      map.flyToBounds(L.latLngBounds(allPoints.map((p) => [p.lat, p.lng])), {
        padding: [30, 30], maxZoom: 15, duration: 1.4,
      });
    }
    mapCaption.textContent = `${allPoints.length} recent located complaints · click a point for details, or a bar to filter`;
  } catch (err) {
    mapCaption.textContent = "Couldn't load map points.";
  }
}

// Click a chart bar to filter the map to that complaint type.
chartEl.addEventListener("click", (e) => {
  const row = e.target.closest(".bar-row");
  if (!row || !row.dataset.type || !map) return;
  activeType = activeType === row.dataset.type ? null : row.dataset.type;
  applyMapFilter();
});

// --- Main flow ---
async function loadZip(zip) {
  aiAnswer.hidden = true;
  activeType = null;

  // Instant path: this ZIP was already loaded this session.
  const cached = readCache(zip);
  if (cached) {
    render(zip, cached.complaints, cached.total);
    loadPoints(zip);
    setStatus("");
    return;
  }

  showSkeleton(zip);
  setStatus("Loading live 311 data from NYC…");
  const slowTimer = setTimeout(() => {
    setStatus("NYC's server is computing this ZIP for the first time — this can take a few seconds…");
  }, 4000);

  try {
    const complaints = await fetchTopComplaints(zip);
    const total = complaints.reduce((s, c) => s + c.count, 0);
    writeCache(zip, { complaints, total });
    render(zip, complaints, total);
    loadPoints(zip);
    setStatus("");
  } catch (err) {
    results.hidden = true;
    setStatus(`Couldn't load data: ${err.message}. Try again in a moment.`, true);
  } finally {
    clearTimeout(slowTimer);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setStatus("Please enter a valid 5-digit NYC ZIP code.", true);
    return;
  }
  // Reflect the ZIP in the URL so the view is shareable / bookmarkable.
  history.replaceState(null, "", `?zip=${zip}`);
  loadZip(zip);
});

// On first load, honor a ?zip= parameter so links deep-link to a neighborhood.
(function initFromURL() {
  const zip = new URLSearchParams(window.location.search).get("zip");
  if (zip && /^\d{5}$/.test(zip)) {
    zipInput.value = zip;
    loadZip(zip);
  }
})();

// --- AI chat (calls our serverless /api/chat, which holds the Claude key) ---
aiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = aiInput.value.trim();
  if (!question || !currentData.zip) return;

  aiSend.disabled = true;
  aiAnswer.hidden = false;
  aiAnswer.classList.remove("error");
  aiAnswer.textContent = "Thinking…";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zip: currentData.zip,
        complaints: currentData.complaints,
        total: currentData.total,
        question,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    aiAnswer.textContent = data.answer;
  } catch (err) {
    aiAnswer.classList.add("error");
    aiAnswer.textContent =
      `${err.message}\n\n(The chat needs the serverless function running — it works once deployed to Vercel with ANTHROPIC_API_KEY set, or locally via "vercel dev". The dashboard above works without it.)`;
  } finally {
    aiSend.disabled = false;
  }
});

// --- Theme toggle ---
document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const isDark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.getAttribute("data-theme") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", isDark ? "light" : "dark");
  setBasemap();
});
