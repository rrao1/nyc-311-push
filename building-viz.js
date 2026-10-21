// building-viz.js — the building page dashboard.
//
// Tiles fill in as their data arrives, fastest first:
//   1. GeoSearch (~0.1 s)       → hero title
//   2. Building records (~1 s)  → verdict, apartment, at-a-glance dials, history, questions
//   3. The 250 m block (~2–3 s) → 3D map, vs-the-neighbors swarm, noise clock
//   (4. The AI summary is loaded separately by building.js and lands last.)
//
// Sources (all public): NYC Planning Labs GeoSearch; NYC Open Data (violations,
// rodent inspections, bedbug filings, HPD complaints, PLUTO, building footprints,
// 311, street trees, restaurant inspections); NY Open Data (subway entrances);
// Mapbox GL JS with the public token from /api/map-token.
//
// Accuracy rule: show only what the records say. Buildings are drawn from the
// city's real footprints and heights; nothing is placed inside a building.

(function () {
  const SOCRATA = "https://data.cityofnewyork.us/resource/";
  const NYS = "https://data.ny.gov/resource/";
  const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
  const RADIUS = 250; // metres

  const $ = (id) => document.getElementById(id);
  const root = $("viz");
  if (!root) return;
  const el = {
    map: $("viz-map"), layers: $("viz-layers"), heroTitle: $("hero-title"), verdict: $("hero-verdict"),
    unit: $("viz-unit"), aptTitle: $("apt-title"), facts: $("viz-facts"), dials: $("viz-dials"), dialDetail: $("viz-dial-detail"),
    blockStat: $("viz-block-stat"), swarm: $("viz-swarm"), timeline: $("viz-timeline"), tlSummary: $("viz-tl-summary"),
    range: $("viz-range"), tip: $("viz-tip"), noise: $("viz-noise"), noiseSub: $("viz-noise-sub"), questions: $("viz-questions"),
    copy: $("viz-copy"), status: $("viz-status"),
  };

  let state = null, hood = null, map = null, range = "all", renderToken = 0, openDial = null;
  const visible = { buildings: true, noise: false, rats: false, trees: false, subway: true, food: false };
  // Start fetching the map token right away so the map isn't waiting on it later.
  const tokenP = fetch("/api/map-token").then((r) => (r.ok ? r.json() : {})).then((d) => d.token || null).catch(() => null);

  // ── helpers ──────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const fmt = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const fmtMonth = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const toDate = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) || d > new Date() ? null : d; };
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const sentence = (t) => { t = String(t || "").trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
  const titleCase = (t) => String(t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/'([A-Z])\b/g, (m, c) => "'" + c.toLowerCase()) // "Nicholas's", not "Nicholas'S"
    .replace(/\b(\d+)([a-z])\b/g, (m, n, c) => n + c.toUpperCase()) // "4A", not "4a" (81st stays)
    .replace(/\b(Llc|Lp|Inc|Hdfc|Nycha)\b/g, (m) => m.toUpperCase());
  const ordinalStreet = (t) => titleCase(t).replace(/\b(\d+)\b(?=\s+(Street|Avenue|Place|Road|Drive|Terrace|Lane)\b)/g, (m, n) => {
    const x = n % 100, u = n % 10; return n + (x >= 11 && x <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"); });
  const plural = (n, w, p) => `${n} ${n === 1 ? w : p || w + "s"}`;
  const monthsAgo = (d) => (Date.now() - d) / (30.44 * 864e5);
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const done = (node) => node && node.classList.remove("is-loading");

  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Data request failed (${r.status})`); return r.json(); }
  const socrata = (id, params, base = SOCRATA) => getJSON(base + id + ".json?" + new URLSearchParams(params));

  function plainDesc(s, max = 140) {
    let t = String(s || "");
    // Leading legal citation ("§ 27-2011 ADM CODE ...", "D26-41.03 ADM CODE ..."): drop it.
    const cite = t.match(/^\s*(?:§|SECTION\b|SEC\b|D?\d)[^:]{0,80}?\b(?:ADM\.?\s*CODE|HMC|RCNY|MDL(?:\s*\d+)?)\b[\s.:,]*/i);
    if (cite) t = t.slice(cite[0].length);
    const i = t.search(/:\s+[A-Z]/);
    if (i > -1 && i < 160 && /§|HMC|ADM CODE|RCNY|MDL/.test(t.slice(0, i))) t = t.slice(i + 1);
    const verb = t.search(/\b(PROPERLY|REPAIR|REPLACE|PROVIDE|ABATE|CLEANSE|EXTERMINATE|REMOVE|TRACE|INSTALL|MAINTAIN|ARRANGE|PAINT|RESTORE|DISCONTINUE|LEGALIZE|SUPPLY|CORRECT|OBTAIN|SECURE|FURNISH|POST|FILE)\b/i);
    if (verb > 0 && verb < 140 && /§|HMC|RCNY|ADM CODE|MDL/i.test(t.slice(0, verb))) t = t.slice(verb);
    t = sentence(t.replace(/,?\s*section\s*['"]+\s*['"]*\s*$/i, "").replace(/\s+/g, " ")); // empty trailing "section '' ''"
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
  }
  // HPD complaint categories in plain words.
  const PLAIN = { "HEAT/HOT WATER": "heat or hot water", "UNSANITARY CONDITION": "pests or unsanitary conditions", "PLUMBING": "plumbing", "PAINT/PLASTER": "paint or plaster",
    "DOOR/WINDOW": "doors or windows", "ELECTRIC": "electrical", "GENERAL": "general building", "APPLIANCE": "appliances", "FLOORING/STAIRS": "floors or stairs", "WATER LEAK": "a water leak",
    "SAFETY": "safety", "ELEVATOR": "the elevator", "OUTSIDE BUILDING": "the outside of the building", "NONCONST": "general building" };
  const plainCat = (major) => PLAIN[String(major || "").toUpperCase()] || String(major || "a building").toLowerCase();
  // "Apt 2-A", "2A", "2 a", "2/A" all become "2A".
  const normApt = (a) => String(a || "").toUpperCase().replace(/\bAPARTMENT|\bAPT\.?|#|[\s\-./]+/g, "");

  // Animated count-up for big numbers (once, on first paint).
  function countUp(node) {
    const target = Number(node.dataset.n);
    if (!isFinite(target) || reduceMotion() || target < 2) { node.textContent = node.dataset.n; return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); node.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const animateNums = (scope) => scope.querySelectorAll("[data-n]").forEach(countUp);

  // ── data ────────────────────────────────────────────────────────────────
  // House numbers compare hyphen- and space-insensitively ("37-20" = "3720" = "37 20").
  const normHouse = (h) => String(h || "").toUpperCase().replace(/[\s-]+/g, "");
  async function resolve(addressText) {
    const data = await getJSON(`${GEOSEARCH}?text=${encodeURIComponent(addressText)}&size=1`);
    const f = (data.features || [])[0];
    const pad = f && f.properties && f.properties.addendum && f.properties.addendum.pad;
    if (!pad || !pad.bbl) throw new Error("We couldn't match that address to a NYC building. Check the house number and street, and include the borough.");
    const p = f.properties;
    const want = (String(addressText).match(/^\s*(\d+(?:-\d+)?[A-Za-z]?)/) || [])[1];
    const got = String(p.housenumber || "");
    // Never swap in a different building silently: refuse, and offer the closest record.
    if (want && got && normHouse(want) !== normHouse(got)) {
      const err = new Error(`No exact match for ${String(addressText).split(",")[0].trim()}.`);
      err.suggestion = [ordinalStreet(p.name || p.label), p.borough].filter(Boolean).join(", ");
      throw err;
    }
    return { bbl: pad.bbl, bin: pad.bin, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: p.name || p.label,
      housenumber: got, street: p.street || "", borough: p.borough || "", postalcode: p.postalcode || "" };
  }

  // Newest first, paged, so a big building keeps its RECENT records (the cap drops the oldest).
  async function pagedDesc(id, params, order, cap = 20000) {
    const out = [], size = 5000;
    for (let off = 0; off < cap; off += size) {
      const rows = await socrata(id, { ...params, $order: `${order} DESC, :id`, $limit: String(size), $offset: String(off) });
      out.push(...rows);
      if (rows.length < size) break;
    }
    return out;
  }

  async function loadBuilding(b) {
    const w = `bbl='${b.bbl}'`;
    const [viol, rodent, bedbug, pluto, compl] = await Promise.all([
      pagedDesc("wvxf-dwi5", { $select: "inspectiondate,novissueddate,class,violationstatus,apartment,novdescription", $where: w }, "inspectiondate"),
      socrata("p937-wjvj", { $select: "inspection_date,result", $where: w, $order: "inspection_date DESC", $limit: "2000" }),
      socrata("wz6d-d3jb", { $select: "filing_date,infested_dwelling_unit_count,eradicated_unit_count,re_infested_dwelling_unit", $where: w, $order: "filing_date", $limit: "200" }),
      socrata("64uk-42ks", { $select: "numfloors,unitsres,yearbuilt,ownername", $where: w, $limit: "1" }).catch(() => []),
      pagedDesc("ygpa-z7cr", { $select: "complaint_id,received_date,apartment,major_category,minor_category,space_type,complaint_status", $where: w }, "received_date").catch(() => []),
    ]);
    const asc = (a, b) => a.date - b.date;
    // Bedbug filings: one per filing date (the dataset repeats some filings).
    const bugBy = {};
    bedbug.forEach((r) => { const d = toDate(r.filing_date); if (!d) return; const k = d.toISOString().slice(0, 10), o = bugBy[k] || (bugBy[k] = { date: d, infested: 0, eradicated: 0, reinfested: 0 });
      o.infested = Math.max(o.infested, Number(r.infested_dwelling_unit_count) || 0); o.eradicated = Math.max(o.eradicated, Number(r.eradicated_unit_count) || 0); o.reinfested = Math.max(o.reinfested, Number(r.re_infested_dwelling_unit) || 0); });
    return {
      ...b,
      violations: viol.map((r) => ({ date: toDate(r.inspectiondate || r.novissueddate), cls: (r.class || "").toUpperCase(), open: /^open/i.test(r.violationstatus || ""), apt: r.apartment || "", desc: plainDesc(r.novdescription), full: plainDesc(r.novdescription, 2000) })).filter((v) => v.date).sort(asc),
      rodent: rodent.map((r) => ({ date: toDate(r.inspection_date), result: r.result || "" })).filter((r) => r.date).sort(asc),
      bedbug: Object.values(bugBy).sort(asc),
      pluto: pluto[0] || {},
      // One HPD complaint can list several problems (one row each): group them by complaint_id.
      complaints: Object.values(compl.reduce((acc, r) => {
        const k = r.complaint_id || r.received_date + r.apartment;
        const c = acc[k] || (acc[k] = { date: toDate(r.received_date), apt: r.apartment || "", major: r.major_category || "", whats: [], where: (r.space_type || "").toLowerCase(), open: !/^close/i.test(r.complaint_status || "") });
        const w = [r.major_category, r.minor_category].filter(Boolean).join(": ");
        if (w && !c.whats.includes(w)) c.whats.push(w);
        return acc;
      }, {})).map((c) => ({ ...c, what: c.whats.slice(0, 3).join("; ") + (c.whats.length > 3 ? ` (+${c.whats.length - 3} more)` : "") })).filter((c) => c.date),
    };
  }

  async function loadHood(b) {
    const dLat = RADIUS / 111320, dLng = RADIUS / (111320 * Math.cos((b.lat * Math.PI) / 180));
    const box = [b.lng - dLng, b.lat - dLat, b.lng + dLng, b.lat + dLat];
    const circle = (col) => `within_circle(${col},${b.lat},${b.lng},${RADIUS})`;
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const [foot, noise, rats, trees, subway, food] = await Promise.all([
      socrata("5zhs-2jue", { $select: "the_geom,base_bbl,mappluto_bbl,bin,height_roof", $where: `within_box(the_geom,${box[3]},${box[0]},${box[1]},${box[2]})`, $limit: "3000" }).catch(() => []),
      socrata("erm2-nwe9", { $select: "latitude,longitude,complaint_type,created_date", $where: `starts_with(complaint_type,'Noise') AND ${circle("location")} AND created_date > '${yearAgo}'`, $limit: "5000" }).catch(() => []),
      socrata("erm2-nwe9", { $select: "latitude,longitude", $where: `complaint_type='Rodent' AND ${circle("location")} AND created_date > '${yearAgo}'`, $limit: "2000" }).catch(() => []),
      socrata("hn5i-inap", { $select: "location", $where: `tpstructure='Full' AND ${circle("location")}`, $limit: "3000" }).catch(() => []),
      socrata("i9wp-a4ja", { $select: "stop_name,daytime_routes,entrance_georeference", $where: circle("entrance_georeference"), $limit: "200" }, NYS).catch(() => []),
      socrata("43nn-pn8j", { $select: "camis,dba,grade,latitude,longitude,max(grade_date) as g", $where: `${circle("location")} AND grade in('A','B','C')`, $group: "camis,dba,grade,latitude,longitude", $limit: "2000" }).catch(() => []),
    ]);
    // The box query over-fetches; keep footprints whose centroid is really within RADIUS.
    const kx = 111320 * Math.cos((b.lat * Math.PI) / 180);
    const centroid = (g) => { const ring = g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0]; let x = 0, y = 0; ring.forEach((p) => { x += p[0]; y += p[1]; }); return [x / ring.length, y / ring.length]; };
    // Condos and new buildings: the footprint's base_bbl is the old lot, while records are
    // filed under the billing BBL (mappluto_bbl). Match on BIN or either BBL; key on the billing one.
    const isMine = (f) => (!!b.bin && f.bin === String(b.bin)) || f.mappluto_bbl === b.bbl || f.base_bbl === b.bbl;
    const keyOf = (f) => f.mappluto_bbl || f.base_bbl;
    const inCircle = (f) => { if (!f.the_geom) return false; const [x, y] = centroid(f.the_geom); return Math.hypot((x - b.lng) * kx, (y - b.lat) * 111320) <= RADIUS || isMine(f); };
    foot.splice(0, foot.length, ...foot.filter(inCircle));
    const bbls = [...new Set(foot.map(keyOf).filter(Boolean))];
    const inList = bbls.map((x) => `'${x}'`).join(",");
    const [vio, plu] = bbls.length ? await Promise.all([
      socrata("wvxf-dwi5", { $select: "bbl,class,count(*) as n", $where: `violationstatus='Open' AND bbl in(${inList})`, $group: "bbl,class", $limit: "5000" }).catch(() => []),
      socrata("64uk-42ks", { $select: "bbl,address,numfloors,yearbuilt,unitsres", $where: `bbl in(${inList})`, $limit: "3000" }).catch(() => []),
    ]) : [[], []];
    const openBy = {};
    vio.forEach((r) => { const o = openBy[r.bbl] || (openBy[r.bbl] = { n: 0, c: 0 }); o.n += Number(r.n) || 0; if (r.class === "C") o.c += Number(r.n) || 0; });
    const facts = {};
    plu.forEach((r) => { facts[String(r.bbl).replace(/\.0+$/, "")] = r; });
    const pt = (lng, lat, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(lng), Number(lat)] }, properties: props || {} });
    const fc = (fs) => ({ type: "FeatureCollection", features: fs.filter((f) => isFinite(f.geometry.coordinates[0]) && isFinite(f.geometry.coordinates[1]) && f.geometry.coordinates[0] !== 0) });
    return {
      b, box,
      buildings: { type: "FeatureCollection", features: foot.filter((f) => f.the_geom).map((f) => {
        const k = keyOf(f), o = openBy[k] || { n: 0, c: 0 }, p = facts[k] || {};
        return { type: "Feature", geometry: f.the_geom, properties: { bbl: k || "", mine: isMine(f), h: Math.max(3, (Number(f.height_roof) || 20) * 0.3048),
          open: o.n, hazard: o.c, address: p.address || "", floors: Math.round(Number(p.numfloors) || 0), year: Number(p.yearbuilt) || 0, units: Number(p.unitsres) || 0 } };
      }) },
      noise: fc(noise.map((r) => pt(r.longitude, r.latitude, { kind: r.complaint_type }))),
      noiseTimes: noise.map((r) => new Date(r.created_date)).filter((d) => !isNaN(d)),
      rats: fc(rats.map((r) => pt(r.longitude, r.latitude))),
      trees: fc(trees.filter((r) => r.location).map((r) => pt(r.location.coordinates[0], r.location.coordinates[1]))),
      subway: fc(subway.filter((r) => r.entrance_georeference).map((r) => pt(r.entrance_georeference.coordinates[0], r.entrance_georeference.coordinates[1], { name: r.stop_name, routes: String(r.daytime_routes || "").trim() }))),
      food: fc(food.map((r) => pt(r.longitude, r.latitude, { name: titleCase(r.dba), grade: r.grade }))),
    };
  }

  // ── stage 2: building tiles ──────────────────────────────────────────────
  function stats(s) {
    const open = s.violations.filter((v) => v.open);
    const openC = open.filter((v) => v.cls === "C").length;
    const latestOpen = open.length ? open[open.length - 1].date : null; // violations are sorted oldest first
    const fiveY = s.rodent.filter((r) => monthsAgo(r.date) <= 60);
    const ratFails = s.rodent.filter((r) => /rat activity/i.test(r.result));
    const ratFails5 = fiveY.filter((r) => /rat activity/i.test(r.result)).length;
    const lastRatFail = ratFails.length ? ratFails[ratFails.length - 1].date : null;
    // Bedbugs: the LATEST filing says what's infested now; older filings are history, not a running total.
    const lastBug = s.bedbug.length ? s.bedbug[s.bedbug.length - 1] : null;
    const bugActive = lastBug ? lastBug.infested : 0, bugRe = lastBug ? lastBug.reinfested : 0;
    const recentInfested = lastBug && monthsAgo(lastBug.date) <= 36 ? lastBug.infested : 0;
    const heat = s.complaints.filter((c) => /heat|hot water/i.test(c.major) && monthsAgo(c.date) <= 24);
    return { open, openC, latestOpen, fiveY, ratFails, ratFails5, lastRatFail, lastBug, bugActive, bugRe, recentInfested, heat };
  }

  // Mirrors assessSeverity() in api/severity.js rule for rule (same windows), so the hero
  // and the AI summary land on the same tone from the same records.
  function band(s, st) {
    if (!s.violations.length && !s.rodent.length && !s.bedbug.length) return "NOT_FOUND";
    const ratRecent = st.lastRatFail && monthsAgo(st.lastRatFail) <= 24, openRecent = st.latestOpen && monthsAgo(st.latestOpen) <= 12;
    if (st.openC || st.bugActive || ratRecent || openRecent) return "RED";
    if (!st.open.length && !st.bugActive && !st.ratFails.length) return "GREEN";
    return "AMBER";
  }
  // Office towers, schools, etc.: housing records may not apply.
  const isNonRes = (s) => (s.pluto.unitsres != null && Number(s.pluto.unitsres) === 0) || /EDUCATION|SCHOOL CONSTRUCTION/i.test(s.pluto.ownername || "");
  const isNycha = (s) => /HOUSING AUTH/i.test(s.pluto.ownername || "");

  function renderVerdict(s) {
    const st = stats(s), bd = band(s, st), nonRes = isNonRes(s);
    const TONE = { RED: "bad", AMBER: "mid", GREEN: "good", NOT_FOUND: "neutral" };
    let tone = TONE[bd], head;
    if (bd === "RED") head = st.openC ? "Open hazards on record" : "Current issues on record";
    else if (bd === "AMBER") head = st.open.length ? "Some open issues" : "No open violations, some past issues";
    else if (bd === "GREEN") head = s.violations.length ? "Clean right now, with past history" : "Clean record";
    else head = "No city records found";
    if (nonRes) { tone = "neutral"; head = "Not listed as residential"; }
    const notes = [];
    if (nonRes) notes.push("This doesn't look like a residential building, so housing records may not apply.");
    if (isNycha(s)) notes.push("This is NYCHA public housing. HPD records cover NYCHA poorly, and the facts here are for the whole development, not just this building.");
    if (bd === "NOT_FOUND" && !nonRes) notes.push("No violations, rat inspections, or bedbug filings matched this building. That can mean a well-kept building or records filed under another address.");
    el.verdict.innerHTML = `<span class="verdict-pill" data-tone="${tone}">${esc(head)}</span>
      ${notes.map((t) => `<p class="hero-notice">${esc(t)}</p>`).join("")}
      <div class="verdict-stats">
        <button type="button" class="stat-btn" data-open="violations" aria-label="See all ${st.open.length} open violations"><b data-n="${st.open.length}">${st.open.length}</b> open ${st.open.length === 1 ? "violation" : "violations"} <span class="go" aria-hidden="true">→</span></button>
        <span><b data-n="${st.openC}">${st.openC}</b> immediately hazardous</span>
        <span><b>${st.lastRatFail ? MONTHS[st.lastRatFail.getMonth()] + " ’" + String(st.lastRatFail.getFullYear()).slice(2) : "None"}</b> last rat failure${st.ratFails.length ? ` · ${st.ratFails5} in last 5 yrs` : ""}</span>
      </div>
      <button type="button" class="link-btn" data-open="violations">See all ${plural(s.violations.length, "violation")} →</button>`;
    animateNums(el.verdict);
  }

  // A ring that shows the share of "good" (resolved / passed / clean).
  function ring(share, tone, big, label, sub, key) {
    const R = 34, C = 2 * Math.PI * R, fill = Math.max(0, Math.min(1, share));
    return `<button type="button" class="dial" data-dial="${key}" data-tone="${tone}" aria-expanded="false">
      <svg viewBox="0 0 84 84" aria-hidden="true"><circle class="dial-track" cx="42" cy="42" r="${R}"></circle>
        <circle class="dial-fill" cx="42" cy="42" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${C * (1 - fill)}" transform="rotate(-90 42 42)"></circle></svg>
      <span class="dial-big" data-n="${big}">${big}</span>
      <span class="dial-label">${esc(label)}</span><span class="dial-sub">${esc(sub)}</span><span class="dial-cta">Details <span aria-hidden="true">▾</span></span></button>`;
  }

  function renderGlance(s) {
    const st = stats(s);
    const year = Number(s.pluto.yearbuilt) || 0, floors = Math.round(Number(s.pluto.numfloors) || 0), units = Number(s.pluto.unitsres) || 0;
    el.facts.innerHTML = [
      year ? `<span><b>${year}</b> built</span>` : "",
      floors ? `<span><b>${floors}</b> floors</span>` : "",
      units ? `<span><b>${units}</b> apartments</span>` : "",
      s.pluto.ownername && !/LIMITED\s*LI\s*ABILITY|^A NEW YORK|UNAVAILABLE OWNER/i.test(s.pluto.ownername) ? `<span class="owner">Owner <b>${esc(titleCase(s.pluto.ownername))}</b></span>` : "",
    ].join("");
    const total = s.violations.length, resolved = total - st.open.length;
    const yrNow = new Date().getFullYear(), thisYr = s.violations.filter((v) => v.date.getFullYear() === yrNow), thisYrOpen = thisYr.filter((v) => v.open).length;
    const violSub = !total ? "none on record"
      : st.open.length === total ? (total === 1 ? "the only one on record, still open" : `all ${total} on record still open`)
      : thisYr.length ? `of ${total} ever · ${thisYr.length} issued in ${yrNow}${thisYrOpen === thisYr.length ? "" : thisYrOpen ? `, ${thisYrOpen} open` : ", closed"}`
      : `of ${total} ever · the rest resolved`;
    const passes = st.fiveY.filter((r) => /^passed/i.test(r.result)).length, checks = st.fiveY.filter((r) => /^passed|rat activity/i.test(r.result)).length;
    const cleanFilings = s.bedbug.filter((b) => !b.infested).length;
    el.dials.innerHTML =
      ring(total ? st.open.length / total : 0, st.openC ? "bad" : st.open.length ? "mid" : "good", st.open.length, st.open.length === 1 ? "open violation" : "open violations", violSub, "viol") +
      ring(checks ? (checks - passes) / checks : 0, st.lastRatFail && monthsAgo(st.lastRatFail) <= 24 ? "bad" : st.fiveY.some((r) => /rat activity/i.test(r.result)) ? "mid" : "good",
        st.ratFails5, `${st.ratFails5 === 1 ? "rat failure" : "rat failures"}, last 5 yrs`,
        checks ? `${passes} of ${checks} passed · 5 yrs${st.fiveY.filter((r) => /other reason/i.test(r.result) && !/rat activity/i.test(r.result)).length ? ` · ${st.fiveY.filter((r) => /other reason/i.test(r.result) && !/rat activity/i.test(r.result)).length} failed for other reasons` : ""}` : "no inspections · 5 yrs", "rats") +
      ring(s.bedbug.length ? (s.bedbug.length - cleanFilings) / s.bedbug.length : 0, st.bugActive ? "bad" : st.bugRe ? "mid" : "good",
        st.bugActive, `${st.bugActive === 1 ? "bedbug unit" : "bedbug units"}, latest filing`,
        s.bedbug.length ? `${cleanFilings} of ${s.bedbug.length} filings clean${s.bedbug.some((b) => b.infested) ? ` · past: ${s.bedbug.reduce((a, b) => a + b.infested, 0)} reported, ${s.bedbug.reduce((a, b) => a + b.eradicated, 0)} eradicated` : ""}` : "no filings", "bugs");
    done(el.dials);
    animateNums(el.dials);
    requestAnimationFrame(() => el.dials.querySelectorAll(".dial-fill").forEach((c) => { c.style.strokeDashoffset = c.dataset.off; }));
    el.dialDetail.innerHTML = "";
    openDial = null;
  }

  function dialDetail(key) {
    const s = state, sevName = { C: "Immediately hazardous", B: "Hazardous", A: "Non-hazardous", I: "Order" };
    let rows = [];
    if (key === "viol") {
      const open = s.violations.filter((v) => v.open).sort((a, b) => (b.cls === "C") - (a.cls === "C") || b.date - a.date);
      rows = open.length ? open.slice(0, 6).map((v) => `<li><span class="sev-pill" data-sev="${v.cls.toLowerCase()}">${esc(sevName[v.cls] || v.cls)}</span><span class="unit-date">${fmt(v.date)}${v.apt ? ` · apt ${esc(v.apt)}` : " · common area"}</span><p>${esc(v.desc)}</p></li>`) : [`<li><p>Nothing open. ${plural(s.violations.length, "past violation")} on record, all resolved.</p></li>`];
      rows.push(`<li class="more"><button type="button" class="link-btn" data-open="violations">See all violations, with full descriptions →</button></li>`);
    } else if (key === "rats") {
      rows = s.rodent.slice(-6).reverse().map((r) => `<li><span class="sev-pill" data-sev="${/rat activity/i.test(r.result) ? "c" : /^passed/i.test(r.result) ? "ok" : ""}">${esc(r.result)}</span><span class="unit-date">${fmt(r.date)}</span></li>`);
      if (!rows.length) rows = ["<li><p>No rat inspections on record.</p></li>"];
    } else {
      rows = s.bedbug.slice(-6).reverse().map((b) => `<li><span class="sev-pill" data-sev="${b.infested ? "c" : "ok"}">${b.infested ? plural(b.infested, "infested unit") : "No infestations"}</span><span class="unit-date">Filed ${fmt(b.date)}</span></li>`);
      if (!rows.length) rows = ["<li><p>No bedbug filings on record.</p></li>"];
    }
    return `<ul class="unit-list">${rows.join("")}</ul>`;
  }

  function unitBody(apt) {
    const vs = state.violations.filter((v) => normApt(v.apt) === apt).sort((a, b) => b.date - a.date);
    const cs = state.complaints.filter((c) => normApt(c.apt) === apt).sort((a, b) => b.date - a.date);
    const common = state.violations.filter((v) => v.open && !normApt(v.apt)).length;
    const commonNote = common ? `<p class="tile-note">${plural(common, "open violation")} in common areas (halls, stairs, systems) also affect this unit.</p>` : "";
    // A clean unit in a building with open hazards isn't good news: keep the tone neutral and say so.
    const openC = state.violations.filter((v) => v.open && v.cls === "C"), openCCommon = openC.filter((v) => !normApt(v.apt)).length;
    const hazNote = openC.length ? `<p class="tile-note">The building has ${plural(openC.length, "immediately hazardous violation")} open${openCCommon ? `, ${openCCommon === openC.length ? "all" : "some"} in common areas` : " in other apartments"}.</p>` : "";
    const cleanTone = openC.length ? "neutral" : "good";
    if (!vs.length && !cs.length) {
      // No exact match: offer unit labels that do appear in the records ("PH" → "PHB", "02A" → "2A").
      const counts = {};
      [...state.violations, ...state.complaints].forEach((r) => { const k = normApt(r.apt); if (k) counts[k] = (counts[k] || 0) + 1; });
      const strip0 = (x) => x.replace(/^0+(?=\w)/, "");
      const near = Object.keys(counts).filter((k) => k !== apt && (k.startsWith(apt) || k.includes(apt) || strip0(k) === strip0(apt))).sort((a, b) => counts[b] - counts[a]).slice(0, 8);
      const chips = near.length ? `<p class="tile-note">Units with similar labels in the records:</p><div class="apt-chips">${near.map((k) => `<button type="button" class="f-chip" data-apt="${esc(k)}">${esc(k)}</button>`).join("")}</div>` : "";
      return `<div class="unit-status" data-tone="${cleanTone}"><span class="us-big">Nothing on record</span><span>No violations or tenant complaints name apartment ${esc(apt)}.</span></div>${chips}${hazNote}${commonNote}`;
    }
    const openN = vs.filter((v) => v.open).length;
    const recs = [...vs.map((v) => ({ d: v.date, open: v.open, k: v.open ? (v.cls === "C" ? "c" : "b") : "closed", label: `${v.open ? "Open" : "Closed"} violation: ${v.desc}` })),
      ...cs.map((c) => ({ d: c.date, k: "complaint", open: c.open, label: `Tenant complaint about ${plainCat(c.major)}${c.where ? ` (${c.where})` : ""}` }))].sort((a, b) => a.d - b.d);
    const t0 = new Date(Math.min(recs[0].d, Date.now() - 5 * 365 * 864e5)), t1 = Date.now();
    const strip = `<p class="strip-cap">This unit's records over time: <i data-k="c"></i>open hazardous <i data-k="b"></i>open <i data-k="closed"></i>closed <i data-k="complaint"></i>complaint</p><div class="unit-strip" role="img" aria-label="${recs.length} records for this unit over time">${recs.map((r) => `<i data-k="${r.k}" style="left:${(((r.d - t0) / (t1 - t0)) * 100).toFixed(1)}%" title="${esc(fmt(r.d) + ": " + r.label)}"></i>`).join("")}
      <span class="us-y0">${t0.getFullYear()}</span><span class="us-y1">today</span></div>`;
    const ordered = recs.slice().sort((a, b) => (b.open === true) - (a.open === true) || b.d - a.d);
    const li = (r) => `<li><span class="unit-date">${fmt(r.d)}</span><p>${esc(r.label)}</p></li>`;
    const list = ordered.slice(0, 2).map(li).join("") + (ordered.length > 2 ? `<li class="more-wrap"><details><summary>Show ${ordered.length - 2} more</summary><ul class="unit-list compact">${ordered.slice(2, 20).map(li).join("")}</ul></details></li>` : "");
    return `<div class="unit-status" data-tone="${openN ? "bad" : cleanTone}"><span class="us-big">${openN ? plural(openN, "open violation") : "Nothing open"}</span><span>${plural(vs.length, "violation")} and ${plural(cs.length, "tenant complaint")} on record</span></div>
      ${strip}<ul class="unit-list compact">${list}</ul>${openN ? "" : hazNote}${commonNote}`;
  }

  function findUnit(raw, asked) {
    const apt = normApt(raw);
    ["viz-unit-input", "apt-input"].forEach((id) => { const n = $(id); if (n) n.value = apt; });
    if (!state) return;
    done(el.unit);
    if (!apt) { el.aptTitle.textContent = "Your apartment"; el.unit.innerHTML = `<p class="tile-empty">${asked ? "Type an apartment number first, like 4B." : "Add your unit to see the records that name it."}</p>`; return; }
    el.aptTitle.textContent = `Apartment ${apt}`;
    el.unit.innerHTML = unitBody(apt);
    renderQuestions(state);
    // Keep the shareable URL in step with the unit on screen.
    try { const u = new URL(window.location.href); u.searchParams.set("apt", apt); history.replaceState(null, "", u); } catch { /* ignore */ }
  }

  function renderQuestions(s) {
    const st = stats(s), q = [];
    if (st.openC) q.push(st.openC === 1 ? "Where is the open immediately hazardous violation, and when will it be fixed?" : `Which of the ${st.openC} immediately hazardous violations are in or near this apartment, and when will each be fixed?`);
    else if (st.open.length) q.push(`When will the ${plural(st.open.length, "open violation")} be closed?`);
    if (st.lastRatFail && monthsAgo(st.lastRatFail) <= 36) q.push(`Rats were found here in ${fmtMonth(st.lastRatFail)}. How often does pest control come, and can I see the latest report?`);
    if (st.heat.length >= 3) q.push(`Tenants filed ${st.heat.length} heat or hot-water complaints in the last two years. How reliable is the heat in winter?`);
    if (st.recentInfested) q.push(`The building's latest bedbug filing (${fmtMonth(st.lastBug.date)}) reported ${plural(st.recentInfested, "infested unit")}. Has this unit ever been treated?`);
    const apt = normApt(($("apt-input") || {}).value);
    if (apt) {
      const last = s.complaints.filter((c) => normApt(c.apt) === apt).sort((a, b) => b.date - a.date)[0];
      if (last) q.push(`A tenant complained about ${plainCat(last.major)} in apartment ${apt} in ${fmtMonth(last.date)}. What was fixed?`);
    }
    if (!isNonRes(s)) q.push("Is this apartment rent stabilized? Can I see its rent history?");
    if (!q.length) q.push("Can I see the building's certificate of occupancy? City housing records may not cover this building.");
    el.questions.innerHTML = q.map((x) => `<li>${esc(x)}</li>`).join("");
  }

  // ── history timeline ─────────────────────────────────────────────────────
  function renderTimeline(s) {
    const now = new Date();
    const all = [...s.violations.map((v) => v.date), ...s.rodent.map((r) => r.date), ...s.bedbug.map((b) => b.date)];
    done(el.timeline);
    if (!all.length) { el.timeline.innerHTML = `<p class="tile-empty">No violations, rat inspections, or bedbug filings on record.</p>`; return; }
    const first = new Date(Math.min(...all));
    const start = range === "all" ? new Date(first.getFullYear(), 0, 1) : new Date(now.getFullYear() - Number(range), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const hiddenOpen = s.violations.filter((v) => v.open && v.date < start).length; // still open, but off the left edge
    const W = Math.max(300, el.timeline.clientWidth || 640), narrow = W < 520;
    const L = narrow ? 6 : 96, R = 10, T = 6, laneH = { v: 110, r: 30, b: 30 }, gap = 22;
    const yV = T + 18, yR = yV + laneH.v + gap, yB = yR + laneH.r + gap, H = yB + laneH.b + 28;
    const x = (d) => L + ((d - start) / (end - start)) * (W - L - R);
    const months = new Map();
    s.violations.forEach((v) => { if (v.date < start) return; const k = `${v.date.getFullYear()}-${v.date.getMonth()}`;
      if (!months.has(k)) months.set(k, { d: new Date(v.date.getFullYear(), v.date.getMonth(), 1), C: 0, B: 0, A: 0 }); const m = months.get(k); if (m[v.cls] != null) m[v.cls]++; });
    const ml = [...months.values()], tot = (m) => m.C + m.B + m.A, maxM = Math.max(10, ...ml.map(tot)); // floor of 10: one violation shouldn't fill the lane
    const bw = Math.max(1.5, (W - L - R) / ((end - start) / 2.63e9) - 1), sy = (n) => Math.max(4, (n / maxM) * (laneH.v - 14)); // never thinner than 4 px
    let bars = "";
    ml.forEach((m) => { let y = yV + laneH.v; const tip = `${fmtMonth(m.d)}: ${tot(m)} violations · ${m.C} immediately hazardous, ${m.B} hazardous, ${m.A} non-hazardous`;
      [["C", "c"], ["B", "b"], ["A", "a"]].forEach(([c, sev]) => { if (!m[c]) return; const h = sy(m[c]); y -= h;
        bars += `<rect class="tl-bar" data-sev="${sev}" x="${x(m.d).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" data-tip="${esc(tip)}"></rect>`; }); });
    const peak = ml.reduce((a, b) => (tot(b) > (a ? tot(a) : -1) ? b : a), null);
    const peakNote = peak && tot(peak) >= 3 ? `<text class="tl-peak" x="${Math.min(x(peak.d), W - R - 4)}" y="${yV + laneH.v - sy(tot(peak)) - 5}" text-anchor="${x(peak.d) > W - 140 ? "end" : "middle"}">Peak ${fmtMonth(peak.d)} · ${tot(peak)}</text>` : "";
    const rk = (r) => /rat activity/i.test(r) ? "fail" : /^passed/i.test(r) ? "pass" : "other";
    const rats = s.rodent.filter((r) => r.date >= start).map((r) => { const k = rk(r.result);
      return `<circle class="tl-rat" data-k="${k}" cx="${x(r.date).toFixed(1)}" cy="${yR + laneH.r / 2}" r="${k === "other" ? 3 : 5.5}" data-tip="${esc(`${fmt(r.date)}: ${r.result}`)}"></circle>`; }).join("");
    const bugs = s.bedbug.filter((b) => b.date >= start).map((b) => { const cx = x(b.date), cy = yB + laneH.b / 2, r = b.infested ? 7.5 : 5;
      return `<path class="tl-bug" data-k="${b.infested ? "infested" : "clean"}" d="M${cx - r} ${cy} L${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} Z" data-tip="${esc(`${fmt(b.date)} filing: ${plural(b.infested, "infested unit")}`)}"></path>`; }).join("");
    let grid = ""; const step = end.getFullYear() - start.getFullYear() > 12 ? 2 : 1;
    for (let yr = start.getFullYear() + (start.getMonth() ? 1 : 0); yr <= now.getFullYear(); yr += step) { const gx = x(new Date(yr, 0, 1)); if (gx < L - 1) continue;
      grid += `<line class="tl-grid" x1="${gx}" x2="${gx}" y1="${T}" y2="${H - 20}"></line><text class="tl-year" x="${gx + 3}" y="${H - 6}">${narrow ? "’" + String(yr).slice(2) : yr}</text>`; }
    const lanes = narrow ? `<text class="tl-lane-sub" x="${L}" y="${yV + 2}">Violations per month</text><text class="tl-lane-sub" x="${L}" y="${yR - 3}">Rat inspections</text><text class="tl-lane-sub" x="${L}" y="${yB - 3}">Bedbug filings</text>`
      : `<text class="tl-lane" x="0" y="${yV + 12}">Violations</text><text class="tl-lane-sub" x="0" y="${yV + 27}">per month</text><text class="tl-lane" x="0" y="${yR + laneH.r / 2 + 4}">Rat checks</text><text class="tl-lane" x="0" y="${yB + laneH.b / 2 + 4}">Bedbugs</text>`;
    el.timeline.innerHTML = `<svg class="tl" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(el.tlSummary.textContent)}">${grid}${lanes}
      <line class="tl-base" x1="${L}" x2="${W - R}" y1="${yV + laneH.v}" y2="${yV + laneH.v}"></line>
      <line class="tl-ymax" x1="${L}" x2="${W - R}" y1="${yV + 14}" y2="${yV + 14}"></line><text class="tl-ylab" x="${W - R}" y="${yV + 10}" text-anchor="end">${maxM} / month</text>
      <line class="tl-track" x1="${L}" x2="${W - R}" y1="${yR + laneH.r / 2}" y2="${yR + laneH.r / 2}"></line>
      <line class="tl-track" x1="${L}" x2="${W - R}" y1="${yB + laneH.b / 2}" y2="${yB + laneH.b / 2}"></line>${bars}${peakNote}${rats}${bugs}</svg>
      <div class="legend"><span><i data-sev="c"></i>Immediately hazardous</span><span><i data-sev="b"></i>Hazardous</span><span><i data-sev="a"></i>Non-hazardous</span>
      <span><i class="dot" data-k="fail"></i>Failed for rats</span><span><i class="dot" data-k="pass"></i>Passed</span><span><i class="dia" data-k="infested"></i>Bedbugs reported</span><span><i class="dia hollow"></i>Filing, none found</span></div>
      ${hiddenOpen ? `<p class="tile-note">${hiddenOpen === 1 ? "1 open violation is" : `${hiddenOpen} open violations are`} older than this view. <button type="button" class="link-btn" data-range-all>Show all years</button></p>` : ""}`;
  }

  function summarize(s) {
    const byYear = {}; s.violations.forEach((v) => { const y = v.date.getFullYear(); byYear[y] = (byYear[y] || 0) + 1; });
    const now = new Date().getFullYear(), prior = Object.keys(byYear).map(Number).filter((y) => y < now);
    const thisYr = byYear[now] || 0, prevMax = Math.max(0, ...prior.map((y) => byYear[y])), prevMaxYr = prior.find((y) => byYear[y] === prevMax);
    const last5 = [1, 2, 3, 4, 5].map((k) => byYear[now - k] || 0); // zero years count
    const typicalRaw = last5.reduce((a, b) => a + b, 0) / 5;
    const typical = typicalRaw === 0 ? "none" : typicalRaw < 1 ? "less than 1" : `about ${Math.round(typicalRaw)}`;
    let line;
    if (!s.violations.length) line = "No housing violations on record.";
    else if (thisYr > prevMax && thisYr > 5) line = `${now} is the worst year on record: ${thisYr} violations so far, past the ${prevMaxYr} high of ${prevMax}.`;
    else {
      // Say WHAT this year's violations are, not just how many.
      const yr = s.violations.filter((v) => v.date.getFullYear() === now);
      const sev = { C: "immediately hazardous", B: "hazardous", A: "non-hazardous" };
      const kinds = ["C", "B", "A"].map((c) => [c, yr.filter((v) => v.cls === c).length]).filter(([, n]) => n).map(([c, n]) => `${n} ${sev[c]}`).join(", ");
      const openYr = yr.filter((v) => v.open).length;
      const status = !yr.length ? "" : openYr === yr.length ? (yr.length === 1 ? ", still open" : ", all still open") : openYr ? `, ${openYr} still open` : (yr.length === 1 ? ", already closed" : ", all closed");
      const what = yr.length && yr.length <= 2 ? ` (${yr.map((v) => v.desc.toLowerCase().replace(/[.…]+$/, "")).join("; ")})` : "";
      line = thisYr ? `${plural(thisYr, "violation")} so far in ${now}: ${kinds}${status}${what}. A typical recent year (last 5) had ${typical}.`
        : `No violations so far in ${now}. A typical recent year (last 5) had ${typical}.`;
    }
    el.tlSummary.textContent = line;
  }

  // ── stage 3: block tiles ─────────────────────────────────────────────────
  function renderBlockStat(n) {
    const seen = new Set();
    const mineF = n.buildings.features.find((f) => f.properties.mine);
    // "Yours" comes from the building's own records when loaded, so this tile and the hero agree.
    const mineOpen = state && state.bbl === n.b.bbl ? state.violations.filter((v) => v.open).length : mineF ? mineF.properties.open : 0;
    const mineUnits = (state && state.bbl === n.b.bbl && Number(state.pluto.unitsres)) || (mineF && mineF.properties.units) || 0;
    const others = n.buildings.features.filter((f) => !f.properties.mine && f.properties.bbl && !seen.has(f.properties.bbl) && seen.add(f.properties.bbl));
    // Big buildings rack up more violations: compare per apartment when we know unit counts.
    const withUnits = others.filter((f) => f.properties.units > 0);
    const perApt = mineUnits > 0 && withUnits.length >= Math.max(3, others.length / 2);
    const pool = perApt ? withUnits : others;
    const val = (open, units) => (perApt ? open / units : open);
    const mineV = val(mineOpen, mineUnits);
    const vals = pool.map((f) => val(f.properties.open, f.properties.units));
    const fewer = vals.filter((v) => v < mineV).length;
    const sorted = vals.slice().sort((a, b) => a - b), median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const pct = pool.length ? Math.round((fewer / pool.length) * 100) : 0;
    const fmtV = (v) => (perApt ? (v === 0 ? "0" : v < 0.1 ? v.toFixed(2) : v.toFixed(1)) : String(v));
    const unit = perApt ? "open violations per apartment" : "open violations";
    let big, tone, line;
    if (!pool.length) { big = "–"; tone = "mid"; line = "No neighboring buildings found."; }
    else if (!mineOpen) { big = "✓"; tone = "good"; line = `No open violations. ${pool.filter((f) => f.properties.open > 0).length} of ${pool.length} nearby buildings have at least one.`; }
    else { big = `${pct}%`; tone = pct >= 75 ? "bad" : pct >= 40 ? "mid" : "good"; line = `${pct === 100 ? `More ${unit} than every one` : `More ${unit} than ${pct}%`} of ${pool.length} ${perApt ? "residential " : ""}buildings within ${RADIUS} m. You: ${fmtV(mineV)}. Typical: ${fmtV(median)}.`; }
    el.blockStat.innerHTML = `<span class="block-pct" data-tone="${tone}">${big}</span><span>${esc(line)}</span>`;
    return { others: pool, mineOpen, mineV, perApt, val, fmtV };
  }

  // Beeswarm: one dot per nearby building, x = open violations (or per apartment), log scale.
  function renderSwarm(n, cmp) {
    done(el.swarm);
    const k = cmp.perApt ? 10 : 1; // stretch per-apartment rates so the log scale has room
    const vals = cmp.others.map((f) => ({ v: cmp.val(f.properties.open, f.properties.units), open: f.properties.open, bbl: f.properties.bbl, a: f.properties.address }));
    const W = Math.max(240, el.swarm.clientWidth || 300), pad = 14;
    const maxV = Math.max(cmp.perApt ? 1 : 10, cmp.mineV, ...vals.map((d) => d.v));
    const x = (v) => pad + (Math.log10(v * k + 1) / Math.log10(maxV * k + 1)) * (W - pad * 2);
    // Size the plot to the tallest stack (often the "none" column) so dots aren't dropped:
    // shrink dots first, then grow the height, up to a cap.
    const stack = (rr) => { const bins = {}; vals.forEach((d) => { const b = Math.floor(x(d.v) / (rr * 2)); bins[b] = (bins[b] || 0) + 1; }); return Math.max(1, ...Object.values(bins)); };
    let r = 3.4; while (r > 1.8 && stack(r) * r * 2 > 110) r -= 0.4;
    const H = Math.min(340, Math.max(150, stack(r) * r * 2 + 50)), mid = (H - 30) / 2 + 4, placed = [];
    let dropped = 0;
    const dots = vals.sort((a, b) => a.v - b.v).map((d) => {
      const cx = x(d.v); let cy = mid, j = 0;
      while (placed.some((p) => Math.abs(p.cx - cx) < r * 2 && Math.abs(p.cy - cy) < r * 2) && j < 200) { j++; cy = mid + (j % 2 ? 1 : -1) * Math.ceil(j / 2) * r * 2; }
      if (cy < 6 || cy > H - 34) { dropped++; return ""; }
      placed.push({ cx, cy });
      const tone = d.open === 0 ? "z" : d.open < 10 ? "l" : d.open < 50 ? "m" : "h";
      const tip = `${d.a ? titleCase(d.a) : "Building"}: ${plural(d.open, "open violation")}${cmp.perApt ? ` (${cmp.fmtV(d.v)} per apartment)` : ""}`;
      return `<circle class="sw-dot" data-t="${tone}" data-bbl="${esc(d.bbl)}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" data-tip="${esc(tip)}"></circle>`;
    }).join("");
    const tickVals = cmp.perApt ? [0, 0.1, 1, 10] : [0, 1, 10, 100, 1000];
    const ticks = tickVals.filter((t) => t <= maxV).map((t) => `<line class="sw-tick" x1="${x(t)}" x2="${x(t)}" y1="${H - 30}" y2="${H - 24}"></line><text class="sw-tl" x="${x(t)}" y="${H - 12}" text-anchor="middle">${t === 0 ? "none" : t}</text>`).join("");
    const mx = x(cmp.mineV);
    el.swarm.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open violations for ${cmp.others.length} nearby buildings, yours highlighted">
      <line class="sw-axis" x1="${pad}" x2="${W - pad}" y1="${H - 30}" y2="${H - 30}"></line>${ticks}${dots}
      <line class="sw-you-line" x1="${mx}" x2="${mx}" y1="14" y2="${H - 30}"></line>
      <circle class="sw-you" cx="${mx}" cy="${mid}" r="8"></circle><text class="sw-you-t" x="${Math.min(Math.max(mx, 24), W - 24)}" y="10" text-anchor="middle">You · ${cmp.fmtV(cmp.mineV)}</text></svg>
      <p class="tile-note">${cmp.perApt ? "Open violations per apartment" : "Open violations per building"}, log scale.${dropped ? ` ${vals.length - dropped} of ${vals.length} buildings shown (the rest overlap).` : ""} Tap or hover a dot to find it on the map.</p>`;
  }

  // Noise heatmap: rows Mon–Sun, columns 12am–11pm (NYC local time from the data).
  function renderNoise(n) {
    done(el.noise);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    n.noiseTimes.forEach((d) => { grid[(d.getDay() + 6) % 7][d.getHours()]++; });
    const total = n.noiseTimes.length;
    if (!total) { el.noise.innerHTML = `<p class="tile-empty">No noise complaints within ${RADIUS} m in the past 12 months.</p>`; el.noiseSub.textContent = ""; return; }
    const max = Math.max(...grid.flat()), dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const W = 300, L = 30, T = 16, cw = (W - L) / 24, ch = 16, H = T + ch * 7 + 34;
    let cells = "";
    grid.forEach((row, di) => row.forEach((v, h) => {
      const k = v / max;
      cells += `<rect class="nh-cell" x="${(L + h * cw).toFixed(2)}" y="${T + di * ch}" width="${(cw - 1).toFixed(2)}" height="${ch - 1}" rx="2" style="fill-opacity:${v ? (0.12 + 0.88 * Math.sqrt(k)).toFixed(2) : 0.06}" data-tip="${dayNames[di]} ${h % 12 || 12}${h < 12 ? "am" : "pm"}: ${plural(v, "complaint")}"></rect>`;
    }));
    const days = dayNames.map((d, i) => `<text class="nh-d" x="${L - 5}" y="${T + i * ch + 11.5}" text-anchor="end">${d}</text>`).join("");
    const hours = [[0, "12a"], [6, "6a"], [12, "12p"], [18, "6p"]].map(([h, t]) => `<text class="nh-h" x="${(L + h * cw).toFixed(1)}" y="${T - 5}">${t}</text>`).join("");
    const ly = T + ch * 7 + 14;
    const legend = `<text class="nh-h" x="${L}" y="${ly + 10}">Quiet</text>${[0.06, 0.3, 0.55, 0.8, 1].map((o, i) => `<rect class="nh-cell" x="${L + 34 + i * 16}" y="${ly}" width="14" height="12" rx="2" style="fill-opacity:${o}"></rect>`).join("")}<text class="nh-h" x="${L + 34 + 5 * 16 + 4}" y="${ly + 10}">Loud (${max})</text>`;
    el.noise.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Noise complaints by weekday and hour, past 12 months">${hours}${days}${cells}${legend}</svg>`;
    let best = [0, 0]; grid.forEach((row, d) => row.forEach((v, h) => { if (v > grid[best[0]][best[1]]) best = [d, h]; }));
    const wkEnd = grid[4].slice(20).concat(grid[5], grid[6].slice(0, 20)).reduce((a, b) => a + b, 0), bh = best[1];
    el.noiseSub.textContent = `${total} complaints within ${RADIUS} m in the past 12 months. Loudest: ${DAYS[(best[0] + 1) % 7]}s around ${bh % 12 || 12} ${bh < 12 ? "am" : "pm"}. ${Math.round((wkEnd / total) * 100)}% come Friday night through Sunday.`;
  }

  // ── the 3D map ──────────────────────────────────────────────────────────
  const C = { pop: "#f6c443", hl: "#2f5bea", bins: ["#e9e6dd", "#f0b39f", "#de6b44", "#b8262a"], binsDark: ["#3a3a37", "#7a4535", "#b85336", "#d84a42"],
    noise: "#2f5bea", rats: "#8a5a2b", trees: "#2e8b57", subway: "#00933c", food: { A: "#2f5bea", B: "#2e8b57", C: "#e8641b" } };
  const LAYERS = [
    { id: "buildings", name: "Building conditions", color: "#c8352f", count: (n) => `${new Set(n.buildings.features.map((f) => f.properties.bbl)).size}` },
    { id: "noise", name: "Noise (12 mo)", color: C.noise, count: (n) => `${n.noise.features.length}` },
    { id: "rats", name: "Rats", color: C.rats, count: (n) => `${n.rats.features.length}` },
    { id: "trees", name: "Trees", color: C.trees, count: (n) => `${n.trees.features.length}` },
    { id: "subway", name: "Subway", color: C.subway, count: (n) => `${new Set(n.subway.features.map((f) => f.properties.name)).size}` },
    { id: "food", name: "Food grades", color: C.food.A, count: (n) => `${n.food.features.length}` },
  ];
  function renderLayerBar(n) {
    el.layers.innerHTML = LAYERS.map((l) => `<button type="button" class="layer-chip" data-layer="${l.id}" aria-pressed="${visible[l.id]}"><i style="background:${l.color}"></i>${esc(l.name)}<span class="lc-count">${esc(l.count(n))}</span></button>`).join("");
  }
  function circlePoly(lng, lat, r) {
    const pts = [], k = Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * 2 * Math.PI; pts.push([lng + (r / (111320 * k)) * Math.cos(a), lat + (r / 111320) * Math.sin(a)]); }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: {} };
  }
  function applyVisibility() {
    el.layers.querySelectorAll(".layer-chip").forEach((b) => b.setAttribute("aria-pressed", String(!!visible[b.dataset.layer])));
    if (!map || !map.getLayer("hood-3d")) return;
    const set = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    set("hood-3d", visible.buildings); set("hood-3d-plain", !visible.buildings);
    set("noise-heat", visible.noise); set("rats-pt", visible.rats); set("trees-pt", visible.trees);
    set("subway-pt", visible.subway); set("subway-lbl", visible.subway); set("food-pt", visible.food); set("food-lbl", visible.food);
    const ground = visible.noise || visible.rats || visible.trees || visible.food;
    ["hood-3d", "hood-3d-plain"].forEach((id) => map.setPaintProperty(id, "fill-extrusion-opacity", ground ? 0.4 : 0.92));
    $("viz-map-legend").style.display = visible.buildings ? "" : "none";
  }
  function highlightBuilding(bbl) { if (map && map.getLayer("hood-hl")) map.setFilter("hood-hl", ["==", ["get", "bbl"], bbl || "__none__"]); }

  async function renderMap(s, n) {
    if (map) { map.remove(); map = null; }
    const token = await tokenP;
    if (!window.mapboxgl || !token) { done(el.map); el.map.innerHTML = `<p class="tile-empty map-msg">The 3D map needs a public Mapbox token on the server.</p>`; return; }
    mapboxgl.accessToken = token;
    const dark = isDark(), bins = dark ? C.binsDark : C.bins;
    el.map.innerHTML = "";
    // Pin the label to the middle of the building's real footprint (the address
    // point sits out on the sidewalk), so it lands on the yellow building.
    const mineF = n.buildings.features.find((f) => f.properties.mine);
    let pinAt = [s.lng, s.lat];
    if (mineF) {
      const g = mineF.geometry, ring = g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0];
      let x = 0, y = 0; ring.forEach((p) => { x += p[0]; y += p[1]; }); pinAt = [x / ring.length, y / ring.length];
    }
    map = new mapboxgl.Map({ container: el.map, style: dark ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11",
      center: pinAt, zoom: 17.1, pitch: 45, bearing: -28, antialias: true, cooperativeGestures: true });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    const pin = document.createElement("div"); pin.className = "bldg-pin"; pin.innerHTML = "<span>Your building</span>";
    new mapboxgl.Marker({ element: pin, anchor: "bottom", offset: [0, -22] }).setLngLat(pinAt).addTo(map);
    map.once("style.load", () => { try { addLayers(); } catch (err) { console.error("3D map layers failed:", err); } done(el.map); });
    function addLayers() {
      const labels = (map.getStyle().layers.find((l) => l.type === "symbol" && l.layout && l.layout["text-field"]) || {}).id;
      map.addSource("ring", { type: "geojson", data: circlePoly(s.lng, s.lat, RADIUS) });
      map.addLayer({ id: "ring", type: "line", source: "ring", paint: { "line-color": dark ? "#f5f4ef" : "#111", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.5 } }, labels);
      map.addSource("noise", { type: "geojson", data: n.noise });
      map.addLayer({ id: "noise-heat", type: "heatmap", source: "noise", layout: { visibility: "none" }, paint: { "heatmap-radius": 22, "heatmap-intensity": 1.1, "heatmap-opacity": 0.85,
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(47,91,234,0)", 0.2, "rgba(47,91,234,0.45)", 0.5, "#6f8ff5", 0.8, "#f6c443", 1, "#e8641b"] } }, labels);
      map.addSource("rats", { type: "geojson", data: n.rats });
      map.addLayer({ id: "rats-pt", type: "circle", source: "rats", layout: { visibility: "none" }, paint: { "circle-radius": 6, "circle-color": C.rats, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }, labels);
      map.addSource("trees", { type: "geojson", data: n.trees });
      map.addLayer({ id: "trees-pt", type: "circle", source: "trees", layout: { visibility: "none" }, paint: { "circle-radius": 3.5, "circle-color": C.trees, "circle-opacity": 0.9 } }, labels);
      map.addSource("hood", { type: "geojson", data: n.buildings });
      map.addLayer({ id: "hood-3d", type: "fill-extrusion", source: "hood", paint: { "fill-extrusion-color": ["case", ["get", "mine"], C.pop, ["step", ["get", "open"], bins[0], 1, bins[1], 10, bins[2], 50, bins[3]]],
        "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } }, labels);
      map.addLayer({ id: "hood-3d-plain", type: "fill-extrusion", source: "hood", layout: { visibility: "none" }, paint: { "fill-extrusion-color": ["case", ["get", "mine"], C.pop, dark ? "#3a3a37" : "#e9e6dd"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.92 } }, labels);
      map.addLayer({ id: "hood-hl", type: "fill-extrusion", source: "hood", filter: ["==", ["get", "bbl"], "__none__"], paint: { "fill-extrusion-color": C.hl, "fill-extrusion-height": ["+", ["get", "h"], 1.5], "fill-extrusion-opacity": 1 } }, labels);
      map.addSource("food", { type: "geojson", data: n.food });
      map.addLayer({ id: "food-pt", type: "circle", source: "food", layout: { visibility: "none" }, paint: { "circle-radius": 8, "circle-color": ["match", ["get", "grade"], "A", C.food.A, "B", C.food.B, C.food.C], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "food-lbl", type: "symbol", source: "food", layout: { visibility: "none", "text-field": ["get", "grade"], "text-size": 10, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"], "text-allow-overlap": true }, paint: { "text-color": "#fff" } });
      map.addSource("subway", { type: "geojson", data: n.subway });
      map.addLayer({ id: "subway-pt", type: "circle", source: "subway", paint: { "circle-radius": 7, "circle-color": C.subway, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      map.addLayer({ id: "subway-lbl", type: "symbol", source: "subway", layout: { "text-field": ["get", "routes"], "text-size": 11, "text-offset": [0, 1.4], "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"] }, paint: { "text-color": dark ? "#f5f4ef" : "#111", "text-halo-color": dark ? "#111" : "#fff", "text-halo-width": 1.5 } });
      const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: "260px", className: "rc-popup" });
      map.on("click", "hood-3d", (ev) => { const p = ev.features[0].properties, mine = p.mine === true || p.mine === "true";
        const sub = [p.year ? `Built ${p.year}` : "", Number(p.floors) ? `${p.floors} floors` : ""].filter(Boolean).join(" · ");
        popup.setLngLat(ev.lngLat).setHTML(`<strong>${esc(mine ? "Your building" : p.address ? titleCase(p.address) : "Building")}</strong><div>${Number(p.open) ? `<b>${p.open}</b> open violations${Number(p.hazard) ? `, <b>${p.hazard}</b> immediately hazardous` : ""}` : "No open violations"}</div><div class="pp-sub">${esc(sub)}</div>`).addTo(map); });
      map.on("click", "food-pt", (ev) => { const p = ev.features[0].properties; popup.setLngLat(ev.lngLat).setHTML(`<strong>${esc(p.name)}</strong><div>Health grade ${esc(p.grade)}</div>`).addTo(map); });
      map.on("click", "subway-pt", (ev) => { const p = ev.features[0].properties; popup.setLngLat(ev.lngLat).setHTML(`<strong>${esc(p.name)}</strong><div>${esc(p.routes)} trains</div>`).addTo(map); });
      ["hood-3d", "food-pt", "subway-pt"].forEach((id) => { map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; }); map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; }); });
      applyVisibility();
      if (!reduceMotion()) map.easeTo({ bearing: 12, duration: 7000 });
    }
  }

  // ── modal: definitions + the full violation list ─────────────────────────
  const modal = $("viz-modal"), modalTitle = $("modal-title"), modalBody = $("modal-body");
  const vFilter = { status: "open", cls: "all", where: "all", sort: "new" }, PAGE = 300;
  let vShown = PAGE;
  function violationList() {
    const s = state, sevName = { C: "Immediately hazardous", B: "Hazardous", A: "Non-hazardous", I: "City order" };
    const old5 = (v) => v.open && monthsAgo(v.date) >= 60;
    const rows = s.violations.filter((v) => (vFilter.status === "all" || (vFilter.status === "old5" ? old5(v) : vFilter.status === "open" ? v.open : !v.open))
      && (vFilter.cls === "all" || v.cls === vFilter.cls)
      && (vFilter.where === "all" || (vFilter.where === "common" ? !normApt(v.apt) : !!normApt(v.apt))))
      .sort((a, b) => (b.open - a.open) || (vFilter.sort === "old" ? a.date - b.date : b.date - a.date));
    const chip = (group, val, label) => `<button type="button" class="f-chip" data-g="${group}" data-v="${val}" aria-pressed="${vFilter[group] === val}">${label}</button>`;
    const nOpen = s.violations.filter((v) => v.open).length, nOld = s.violations.filter(old5).length;
    return `<div class="f-row" role="group" aria-label="Status">${chip("status", "open", `Open (${nOpen})`)}${nOld ? chip("status", "old5", `Open 5+ years (${nOld})`) : ""}${chip("status", "closed", `Closed (${s.violations.length - nOpen})`)}${chip("status", "all", `All (${s.violations.length})`)}</div>
      <div class="f-row" role="group" aria-label="Class">${chip("cls", "all", "Any class")}${chip("cls", "C", "C · immediately hazardous")}${chip("cls", "B", "B · hazardous")}${chip("cls", "A", "A · non-hazardous")}</div>
      <div class="f-row" role="group" aria-label="Where">${chip("where", "all", "Anywhere")}${chip("where", "apt", "In an apartment")}${chip("where", "common", "Common areas")}</div>
      <div class="f-row" role="group" aria-label="Sort">${chip("sort", "new", "Newest first")}${chip("sort", "old", "Oldest first")}</div>
      <p class="tile-note">${plural(rows.length, "violation")} match. ${vFilter.sort === "old" ? "Oldest" : "Newest"} first, open before closed.</p>
      <ul class="v-list">${rows.slice(0, vShown).map((v) => `<li data-open="${v.open}">
        <div class="v-meta"><span class="sev-pill" data-sev="${v.cls.toLowerCase()}">${v.cls} · ${esc(sevName[v.cls] || "Other")}</span>
          <span class="v-status" data-open="${v.open}">${v.open ? "Open" : "Closed"}</span>
          <span class="unit-date">${fmt(v.date)} · ${normApt(v.apt) ? "Apt " + esc(normApt(v.apt)) : "Common area / building"}</span></div>
        <p>${esc(v.full)}</p></li>`).join("")}</ul>${rows.length > vShown ? `<p class="tile-note">Showing ${vShown} of ${rows.length}. <button type="button" class="link-btn" data-more>Show ${Math.min(PAGE, rows.length - vShown)} more</button></p>` : ""}
      <p class="tile-note">Source: HPD housing violations (NYC Open Data). Descriptions are the inspector's wording, with legal code references removed.</p>`;
  }
  function openModal(kind) {
    if (kind === "define") { modalTitle.textContent = "What's a violation?"; modalBody.innerHTML = $("tpl-define").innerHTML; }
    else { if (!state) return; vShown = PAGE; modalTitle.textContent = `Violations at ${el.heroTitle.textContent || "this building"}`; modalBody.innerHTML = violationList(); }
    modal.dataset.kind = kind;
    if (!modal.open) modal.showModal();
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b && (b.dataset.open === "define" || b.dataset.open === "violations")) openModal(b.dataset.open); });
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest(".modal-x")) { modal.close(); return; }
    if (e.target.closest("[data-more]")) { const y = modalBody.scrollTop; vShown += PAGE; modalBody.innerHTML = violationList(); modalBody.scrollTop = y; return; }
    const c = e.target.closest(".f-chip"); if (!c) return;
    vFilter[c.dataset.g] = c.dataset.v; vShown = PAGE; modalBody.innerHTML = violationList();
  });

  // ── wiring ───────────────────────────────────────────────────────────────
  el.layers.addEventListener("click", (e) => { const b = e.target.closest(".layer-chip"); if (!b) return; visible[b.dataset.layer] = !visible[b.dataset.layer]; applyVisibility(); });
  el.dials.addEventListener("click", (e) => {
    const b = e.target.closest(".dial"); if (!b || !state) return;
    const k = b.dataset.dial; openDial = openDial === k ? null : k;
    el.dials.querySelectorAll(".dial").forEach((d) => d.setAttribute("aria-expanded", String(d.dataset.dial === openDial)));
    el.dialDetail.innerHTML = openDial ? dialDetail(openDial) : "";
  });
  $("viz-unit-form").addEventListener("submit", (e) => { e.preventDefault(); findUnit($("viz-unit-input").value, true); });
  el.unit.addEventListener("click", (e) => { const b = e.target.closest("[data-apt]"); if (b) findUnit(b.dataset.apt, true); });
  el.copy.addEventListener("click", async () => {
    const text = [...el.questions.querySelectorAll("li")].map((li, i) => `${i + 1}. ${li.textContent}`).join("\n");
    try { await navigator.clipboard.writeText(text); el.copy.textContent = "Copied"; } catch { el.copy.textContent = "Couldn't copy"; }
    setTimeout(() => { el.copy.textContent = "Copy questions"; }, 1600);
  });
  const setRange = (r) => { range = r; el.range.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.range === r))); renderTimeline(state); };
  el.range.addEventListener("click", (e) => { const b = e.target.closest("button[data-range]"); if (b && state) setRange(b.dataset.range); });
  el.timeline.addEventListener("click", (e) => { if (e.target.closest("[data-range-all]") && state) setRange("all"); });
  // One tooltip for the timeline, swarm and noise clock.
  function wireTip(container) {
    const show = (e) => {
      const t = e.target.closest("[data-tip]");
      if (container === el.swarm) highlightBuilding(t && t.dataset.bbl);
      if (!t) { el.tip.hidden = true; return; }
      el.tip.textContent = t.getAttribute("data-tip"); el.tip.hidden = false;
      el.tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - el.tip.offsetWidth - 8)}px`;
      el.tip.style.top = `${e.clientY - el.tip.offsetHeight - 12}px`;
    };
    container.addEventListener("pointermove", show);
    container.addEventListener("pointerdown", show); // a tap on touch screens
    container.addEventListener("pointerleave", () => { el.tip.hidden = true; if (container === el.swarm) highlightBuilding(null); });
  }
  [el.timeline, el.swarm, el.noise].forEach(wireTip);
  let rz = null;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (state) renderTimeline(state); if (hood) renderSwarm(hood, renderBlockStat(hood)); }, 150); });

  function skeletons() {
    el.heroTitle.textContent = ""; el.heroTitle.classList.add("skel-line");
    el.verdict.innerHTML = `<span class="skel-line w60"></span>`;
    el.unit.innerHTML = `<div class="skel-block"></div>`; el.unit.classList.add("is-loading");
    el.facts.innerHTML = `<div class="skel-line"></div>`;
    el.dials.innerHTML = `<div class="skel-dial"></div><div class="skel-dial"></div><div class="skel-dial"></div>`; el.dials.classList.add("is-loading");
    el.dialDetail.innerHTML = "";
    el.blockStat.innerHTML = `<span class="skel-line"></span>`;
    el.questions.innerHTML = `<li class="skel-line"></li><li class="skel-line"></li>`;
    el.tlSummary.textContent = ""; el.noiseSub.textContent = ""; el.layers.innerHTML = "";
    [el.map, el.swarm, el.timeline, el.noise].forEach((n) => { n.innerHTML = ""; n.classList.add("is-loading"); });
  }
  function tileError(node, msg) { done(node); node.innerHTML = `<p class="tile-empty">${esc(msg)}</p>`; }
  function setStatus(msg) { el.status.textContent = msg || ""; el.status.hidden = !msg; }

  // Couldn't resolve the building: clear EVERY tile (no skeletons left spinning) and say why.
  function renderNoBuilding(err) {
    const sug = err && err.suggestion;
    const apt = (($("apt-input") || {}).value || "").trim();
    const link = sug ? `/building?address=${encodeURIComponent(sug)}${apt ? `&apt=${encodeURIComponent(apt)}` : ""}` : "";
    setStatus("");
    el.heroTitle.classList.remove("skel-line");
    el.heroTitle.textContent = sug ? "No exact match" : "Building not found";
    el.verdict.innerHTML = `<span class="verdict-pill" data-tone="neutral">Nothing to show yet</span>
      <p class="hero-notice">${esc((err && err.message) || "We couldn't find that building.")}${sug ? ` Closest city record: <b>${esc(sug)}</b>.` : ""}</p>
      ${sug ? `<a class="link-btn" href="${esc(link)}">Did you mean ${esc(sug)}? →</a>` : `<p class="tile-note">Try the full street address with the borough, e.g. 350 W 42nd St, Manhattan.</p>`}`;
    const msg = "No building to show. Check the address above.";
    el.facts.innerHTML = ""; el.dialDetail.innerHTML = ""; el.layers.innerHTML = ""; el.tlSummary.textContent = ""; el.noiseSub.textContent = "";
    el.blockStat.innerHTML = `<span>${esc(msg)}</span>`;
    [el.map, el.timeline, el.noise, el.unit, el.dials].forEach((n) => tileError(n, msg));
    done(el.swarm); el.swarm.innerHTML = "";
    el.questions.innerHTML = `<li>${esc("Questions for the landlord appear once we find the building.")}</li>`;
    $("viz-map-legend").style.display = "none"; // .map-legend sets display, which beats [hidden]
  }

  // Resolves to { ok, bbl, ... } as soon as the address is (or isn't) matched to a building,
  // so building.js can skip the AI summary for an address we couldn't place.
  async function render(addressText) {
    const token = ++renderToken;
    root.hidden = false;
    setStatus("");
    state = null; hood = null;
    skeletons();
    $("viz-map-legend").style.display = "";
    let b;
    try { b = await resolve(addressText); }
    catch (err) { if (token !== renderToken) return { ok: false, stale: true }; renderNoBuilding(err); return { ok: false, error: err.message, suggestion: err.suggestion || null }; }
    if (token !== renderToken) return { ok: false, stale: true };
    el.heroTitle.classList.remove("skel-line");
    el.heroTitle.textContent = ordinalStreet(String(b.label).split(",")[0]);

    loadBuilding(b).then((s) => {
      if (token !== renderToken) return;
      state = s;
      range = s.violations.length && new Date().getFullYear() - s.violations[0].date.getFullYear() > 12 ? "10" : "all";
      el.range.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.range === range)));
      renderVerdict(s); renderGlance(s); summarize(s); renderTimeline(s); renderQuestions(s);
      if (hood) renderSwarm(hood, renderBlockStat(hood)); // block tile now uses this building's own count
      findUnit((($("apt-input") || {}).value) || new URLSearchParams(window.location.search).get("apt") || "");
    }).catch(() => { if (token === renderToken) {
      el.verdict.innerHTML = `<p class="tile-empty">Couldn't load the building's records. Try again in a moment.</p>`; el.facts.innerHTML = ""; el.questions.innerHTML = "";
      [el.unit, el.dials, el.timeline].forEach((n) => tileError(n, "Couldn't load the building's records. Try again in a moment.")); } });

    loadHood(b).then((n) => {
      if (token !== renderToken) return;
      hood = n;
      renderLayerBar(n);
      renderSwarm(n, renderBlockStat(n));
      renderNoise(n);
      renderMap(b, n);
    }).catch(() => { if (token === renderToken) { el.blockStat.innerHTML = ""; [el.map, el.swarm, el.noise].forEach((x) => tileError(x, "Couldn't load the block. Try again in a moment.")); } });
    return { ok: true, bbl: b.bbl, bin: b.bin, label: b.label, housenumber: b.housenumber, street: b.street, borough: b.borough, postalcode: b.postalcode, lat: b.lat, lng: b.lng };
  }

  window.BuildingViz = { render, refreshTheme: () => { if (hood) renderMap(hood.b, hood); } };
})();
