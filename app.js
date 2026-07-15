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
    { value: fmt(total), label: "Total complaints (last 12 mo)" },
    { value: complaints.length ? `${topShare}%` : "—", label: top ? `are “${top.type}”` : "top share" },
    { value: fmt(complaints.length), label: "Distinct complaint types shown" },
  ];
  statRow.innerHTML = tiles
    .map(
      (t) => `<div class="stat">
        <div class="stat-value">${t.value}</div>
        <div class="stat-label">${t.label}</div>
      </div>`
    )
    .join("");
}

function renderChart(complaints) {
  if (!complaints.length) {
    chartEl.innerHTML = `<p class="stat-label">No complaints found for this ZIP in the last 12 months.</p>`;
    return;
  }
  const max = complaints[0].count;
  chartEl.innerHTML = complaints
    .map(
      (c) => `<div class="bar-row">
        <div class="bar-label"><span class="name">${c.type}</span><span class="count">${fmt(c.count)}</span></div>
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

// --- Main flow ---
async function loadZip(zip) {
  aiAnswer.hidden = true;

  // Instant path: this ZIP was already loaded this session.
  const cached = readCache(zip);
  if (cached) {
    render(zip, cached.complaints, cached.total);
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
});
