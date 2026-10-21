// api/severity.js
// ────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC building-severity rule.
//
// This is the GROUND TRUTH for calibration evals: given the same `findings` the
// report card is built from, it computes the headline band the report SHOULD
// land on (RED / AMBER / GREEN / NOT_FOUND). The eval then checks the agent's
// prose against this — over-representation (C7c) = prose scarier than the band,
// under-representation (C7b) = prose calmer than the band.
//
// It's pure (no deps, no I/O) on purpose, so the AGENT can also call it to
// anchor its own headline later. Thresholds are named + exported because an
// eval rule should wear its assumptions on its sleeve — tune them here, in one
// place, and both the eval and the product move together.
// ────────────────────────────────────────────────────────────────────────────

export const BANDS = { RED: "RED", AMBER: "AMBER", GREEN: "GREEN", NOT_FOUND: "NOT_FOUND" };

// The knobs. Change these and re-run the eval to see calibration shift.
export const THRESHOLDS = {
  openViolationRecentMonths: 12, // an open violation this recent = a CURRENT problem
  ratFailWindowMonths: 24,       // a rat-activity failure this recent = a CURRENT problem
  cleanWindowMonths: 60,         // "clean" is judged over this window (5 years)
};

function monthsSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function byType(findings) {
  const m = {};
  for (const f of findings || []) if (f && f.type) m[f.type] = f;
  return m;
}

// Currently-open violations summed across all classes (A/B/C).
function openViolationTotal(v) {
  if (!v || !v.open_violations_by_class) return 0;
  return Object.values(v.open_violations_by_class).reduce((a, n) => a + (Number(n) || 0), 0);
}

// A rat-activity FAILURE within `months`. Exact from latest_rat_failure_date;
// older findings without it fall back to the recent[] sample (≤8 records).
function ratFailWithin(r, months) {
  if (!r) return false;
  // Exact when the data layer sends the latest rat-failure date (it now does).
  if ("latest_rat_failure_date" in r) return monthsSince(r.latest_rat_failure_date) <= months;
  if (!Array.isArray(r.recent)) return false;
  return r.recent.some(
    (rec) => /fail.*rat|rat.*activity/i.test(rec.result || "") && monthsSince(rec.date) <= months
  );
}

// Per-dataset status for the UI cards. Same rule, same recency window as the
// band above — this is what makes the frontend cards and the overall grade
// agree (they used to drift because the browser had its own un-windowed copy).
// Returns { <type>: { status: 'green'|'amber'|'red', note } } for present types.
export function assessCards(findings, opts = {}) {
  const t = { ...THRESHOLDS, ...opts };
  const { violations: v, rodent: r, bedbug: b } = byType(findings);
  const cards = {};

  if (v) {
    const openHaz = Number(v.open_hazardous_class_C) || 0;
    const open = openViolationTotal(v);
    const total = Number(v.total_violations) || 0;
    if (openHaz > 0) cards.violations = { status: "red", note: "Open hazardous (class C) violations right now" };
    else if (open > 0) cards.violations = { status: "amber", note: "Some open violations (none hazardous)" };
    else if (total > 0) cards.violations = { status: "green", note: "No open violations; past ones resolved" };
    else cards.violations = { status: "green", note: "No housing violations on record" };
  }

  if (r) {
    const ratAll = Number(r.failed_for_rat_activity) || 0;
    const recent = ratFailWithin(r, t.ratFailWindowMonths);
    let otherFailed = 0;
    for (const [k, n] of Object.entries(r.results || {})) {
      if (/failed/i.test(k) && !/rat activity/i.test(k)) otherFailed += Number(n) || 0;
    }
    const yrs = Math.round(t.ratFailWindowMonths / 12);
    if (recent) cards.rodent = { status: "red", note: `Rat-activity failure within the last ${yrs} year${yrs > 1 ? "s" : ""}` };
    else if (ratAll > 0) cards.rodent = { status: "amber", note: "Past rat-activity failures, since resolved" };
    else if (otherFailed > 0) cards.rodent = { status: "amber", note: "Some failed inspections on record" };
    else cards.rodent = { status: "green", note: "Passed inspections; no rat activity" };
  }

  if (b) {
    const filings = Number(b.filings) || 0;
    const infested = Number(b.infested_units) || 0;
    const netActive = b.net_active != null ? Number(b.net_active) : Math.max(0, infested - (Number(b.eradicated_units) || 0));
    const reInf = Number(b.re_infested) || 0;
    // net_active = infested units in the LATEST filing (not a lifetime sum).
    if (netActive > 0) cards.bedbug = { status: "red", note: `${netActive} unit${netActive > 1 ? "s" : ""} infested in the latest filing` };
    else if (reInf > 0) cards.bedbug = { status: "red", note: "Recurring infestations reported" };
    else if (infested > 0) cards.bedbug = { status: "green", note: "Past reports, all eradicated" };
    else if (filings > 0) cards.bedbug = { status: "green", note: "No infestations reported" };
    else cards.bedbug = { status: "green", note: "No bedbug filings on record" };
  }

  return cards;
}

/**
 * @param {Array} findings  the per-dataset objects from /api/building
 * @param {object} [opts]   threshold overrides
 * @returns {{ band: string, reasons: string[], signals: object, cards: object }}
 */
export function assessSeverity(findings, opts = {}) {
  const t = { ...THRESHOLDS, ...opts };
  const { violations: v, rodent: r, bedbug: b } = byType(findings);
  const cards = assessCards(findings, opts);

  const signals = {
    openClassC: (v && Number(v.open_hazardous_class_C)) || 0,
    openTotal: openViolationTotal(v),
    latestOpenMonths: v ? monthsSince(v.latest_open_date) : Infinity,
    ratFailsAllTime: (r && Number(r.failed_for_rat_activity)) || 0,
    ratFailRecent: ratFailWithin(r, t.ratFailWindowMonths),
    bedbugNetActive: (b && Number(b.net_active)) || 0,
  };

  // Any record at all? This is what separates a genuinely clean building from an
  // address that simply didn't match city records (the Case-5 false-glow trap).
  const hasAnyRecord =
    (v && Number(v.total_violations) > 0) ||
    (r && r.results && Object.keys(r.results).length > 0) ||
    (b && Number(b.filings) > 0);

  if (!hasAnyRecord) {
    return {
      band: BANDS.NOT_FOUND,
      reasons: ["No records in any dataset — could be a clean building OR an address that didn't match city records. Do not present as a glowing verdict."],
      signals,
      cards,
    };
  }

  // 🔴 RED — any current / serious signal present.
  const red = [];
  if (signals.openClassC >= 1) red.push(`${signals.openClassC} open Class C (immediately hazardous) violation(s)`);
  if (signals.bedbugNetActive >= 1) red.push(`${signals.bedbugNetActive} net-active bedbug unit(s)`);
  if (signals.ratFailRecent) red.push(`rat-activity failure within the last ${t.ratFailWindowMonths} months`);
  if (signals.latestOpenMonths <= t.openViolationRecentMonths) red.push(`an open violation within the last ${t.openViolationRecentMonths} months`);
  if (red.length) return { band: BANDS.RED, reasons: red, signals, cards };

  // 🟢 GREEN — nothing open, nothing active, nothing recent-or-standing on rodents.
  const rodentClean = !signals.ratFailRecent && signals.ratFailsAllTime === 0;
  if (signals.openTotal === 0 && signals.bedbugNetActive === 0 && rodentClean) {
    return {
      band: BANDS.GREEN,
      reasons: ["No open violations, no active bedbug units, and no rat-activity failures on record."],
      signals,
      cards,
    };
  }

  // 🟡 AMBER — real history, but resolved or old. Not scary, not spotless.
  const amber = [];
  if (signals.openTotal > 0) amber.push(`${signals.openTotal} open violation(s), none Class C or recent`);
  if (signals.ratFailsAllTime > 0) amber.push(`${signals.ratFailsAllTime} past rat-activity failure(s), none recent`);
  if (b && Number(b.eradicated_units) > 0) amber.push("past bedbug infestation(s), all eradicated");
  else if (v && Number(v.total_violations) > 0) amber.push(`${v.total_violations} past violation(s), all resolved`);
  return {
    band: BANDS.AMBER,
    reasons: amber.length ? amber : ["Resolved history on record; nothing currently open or active."],
    signals,
    cards,
  };
}
