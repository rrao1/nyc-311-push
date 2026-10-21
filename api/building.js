// Vercel serverless function — a building "report card" AGENT.
//
// ────────────────────────────────────────────────────────────────────────────
// THE IDEA
// ────────────────────────────────────────────────────────────────────────────
// You give it a NYC address ("350 W 42nd Street, 10036"). To answer "should I
// worry about renting here?", the agent has to investigate that ONE building
// across SEVERAL official NYC datasets — HPD violations, rodent inspections,
// bedbug filings — deciding which matter, then synthesize a renter's summary.
//
// TWO PATHS, same { answer, findings } shape:
//   • FAST PATH (mode:"full") — the default full check. We already KNOW we want
//     all three datasets, so we skip the model's tool-selection round-trip:
//     fire all three lookups in parallel, then make ONE model call to write the
//     summary. This is dramatically faster than the agent loop.
//   • AGENT LOOP (question) — for focused questions ("heat/mold?", "pests?") the
//     model still decides which datasets to hit. Tool calls within a turn now
//     run in parallel too.
// ────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { assessSeverity } from "./severity.js";

export const MODEL = "claude-haiku-4-5-20251001";
const MAX_STEPS = 8; // room for several dataset lookups + the final answer

// Which NYC Open Data sets the agent can reach, and each one's field names.
// (All verified queryable, no auth. Add evictions/litigation here later.)
// Exported so the lazy /api/detail endpoint reuses the exact same field map.
export const DATASETS = {
  violations: { id: "wvxf-dwi5", hn: "housenumber", st: "streetname", zip: "zip", label: "HPD housing violations" },
  rodent:     { id: "p937-wjvj", hn: "house_number", st: "street_name", borough: "borough", label: "DOHMH rodent inspections" },
  bedbug:     { id: "wz6d-d3jb", hn: "house_number", st: "street_name", zip: "postcode", label: "HPD bedbug filings" },
};

const FINDING_ORDER = ["violations", "rodent", "bedbug"];

// NYC stores streets like "EAST 10 STREET". Normalize whatever we get
// ("E 10th St") into that shape so our lookups actually match.
export function normalizeStreet(s) {
  let x = String(s || "").toUpperCase().replace(/'/g, "").trim();
  x = x.replace(/^(E|W|N|S)\.?\s+/, (m, d) => ({ E: "EAST ", W: "WEST ", N: "NORTH ", S: "SOUTH " }[d]));
  x = x.replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1"); // 10th -> 10
  return x.trim();
}

// Split a one-line address ("350 West 42 Street, Manhattan, NY 10036") into a
// house number + street. Used by the fast path when the caller sends a string.
export function parseAddress(address) {
  const line1 = String(address || "").split(",")[0].trim();
  const m = line1.match(/^\s*(\d+(?:-\d+)?[a-zA-Z]?)\s+(.*)$/); // "37-20 81 St" (Queens) too
  if (m) return { house_number: m[1], street_name: m[2] };
  return { house_number: "", street_name: line1 };
}

// Drop a leading legal citation ("§ 27-2011 ADM CODE ...") from an inspector's description.
export function stripCite(s) {
  return String(s || "").replace(/^\s*(?:§|SECTION\b|SEC\b|D?\d)[^:]{0,80}?\b(?:ADM\.?\s*CODE|HMC|RCNY|MDL(?:\s*\d+)?)\b[\s.:,]*/i, "");
}

function monthsAgo(dateStr) {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? Infinity : (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

export function truncate(s, n = 120) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

// ── THE TOOL ──────────────────────────────────────────────────────────────
const tools = [
  {
    name: "query_building",
    description:
      "Look up official NYC records for ONE building. Call it once per dataset " +
      "you want to check. Datasets: 'violations' (HPD housing code violations — " +
      "class C = immediately hazardous, e.g. no heat/hot water, mold), 'rodent' " +
      "(rat inspection results), 'bedbug' (landlord bedbug filings). Returns real " +
      "aggregated counts plus a few recent underlying records for that address.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: ["violations", "rodent", "bedbug"] },
        house_number: { type: "string", description: "e.g. '51'" },
        street_name: { type: "string", description: "Street only, e.g. 'East 10 Street' (spell out E/W as East/West)." },
        zip: { type: "string", description: "5-digit ZIP if known, e.g. '10003'." },
        borough: { type: "string", description: "e.g. 'Manhattan' (helps the rodent dataset)." },
      },
      required: ["dataset", "house_number", "street_name"],
    },
  },
];

// Small Socrata GET helper. Returns parsed rows, or throws with a clean message.
export async function socrata(id, params) {
  const res = await fetch(`https://data.cityofnewyork.us/resource/${id}.json?${params.toString()}`);
  if (!res.ok) throw new Error(`NYC Open Data returned ${res.status}`);
  return res.json();
}

// ── THE TOOL'S CODE — runs real queries and aggregates the answer ───────────
// Fires the aggregate count query AND a "recent records" query (and, for
// violations, a latest-open-date probe) in PARALLEL, so a single dataset lookup
// is no slower than its slowest sub-query.
async function runQueryBuilding({ dataset, house_number, street_name, zip, borough, bbl }) {
  const cfg = DATASETS[dataset];
  if (!cfg) return { error: `Unknown dataset '${dataset}'.` };

  const hn = String(house_number || "").replace(/'/g, "").trim();
  const sn = normalizeStreet(street_name);
  let where;
  if (/^\d{10}$/.test(String(bbl || ""))) {
    // The city's building ID: matches records however the street was typed
    // ("SOUTH    4 STREET", "S 4TH ST") and filed under a neighboring number.
    where = `bbl='${bbl}'`;
  } else {
    const clauses = [`${cfg.hn}='${hn}'`, `upper(${cfg.st}) like '%${sn}%'`];
    if (zip && cfg.zip) clauses.push(`${cfg.zip}='${String(zip).replace(/'/g, "").trim()}'`);
    if (borough && cfg.borough) clauses.push(`upper(${cfg.borough})=upper('${String(borough).replace(/'/g, "")}')`);
    where = clauses.join(" AND ");
  }

  try {
    if (dataset === "violations") {
      const countP = socrata(cfg.id, new URLSearchParams({ "$select": "class, violationstatus, count(*) AS count", "$where": where, "$group": "class, violationstatus", "$limit": "50" }));
      const recentP = socrata(cfg.id, new URLSearchParams({ "$select": "novissueddate, inspectiondate, class, violationstatus, novdescription", "$where": where, "$order": "novissueddate DESC", "$limit": "8" }));
      // Every OPEN violation (oldest first), so the summary gets exact open dates and
      // the real open class C list. Dated the same way the dashboard dates them.
      const openP = socrata(cfg.id, new URLSearchParams({ "$select": "inspectiondate, novissueddate, class, apartment, novdescription", "$where": `${where} AND upper(violationstatus) like 'OPEN%'`, "$order": "inspectiondate ASC", "$limit": "5000" }));
      const [rows, recentRows, openRows] = await Promise.all([countP, recentP, openP]);

      const open = {}; let openTotal = 0, total = 0;
      for (const r of rows) {
        const n = Number(r.count) || 0; total += n;
        if ((r.violationstatus || "").toLowerCase().startsWith("open")) { open[r.class] = (open[r.class] || 0) + n; openTotal += n; }
      }
      const recent = recentRows.map((r) => ({
        date: r.inspectiondate || r.novissueddate || null, // same date the dashboard shows
        class: r.class || "",
        status: r.violationstatus || "",
        desc: truncate(stripCite(r.novdescription), 120),
      }));
      const day = (r) => String(r.inspectiondate || r.novissueddate || "").slice(0, 10) || null;
      const openDates = openRows.map(day).filter(Boolean).sort();
      const oldest_open_date = openDates[0] || null;
      const newest_open_date = openDates[openDates.length - 1] || null;
      const openC = openRows.filter((r) => String(r.class || "").toUpperCase() === "C");
      const open_class_C_records = openC.slice().reverse().slice(0, 15)
        .map((r) => ({ date: day(r), apartment: r.apartment || "common area / building", desc: truncate(stripCite(r.novdescription), 90) }));
      return { type: "violations", dataset: cfg.label, address: `${hn} ${sn}`, total_violations: total, open_violations_total: openTotal, open_violations_by_class: open, open_hazardous_class_C: open.C || 0,
        oldest_open_date, newest_open_date, latest_open_date: newest_open_date, // any class
        oldest_open_class_C_date: openC.length ? day(openC[0]) : null, newest_open_class_C_date: openC.length ? day(openC[openC.length - 1]) : null,
        open_class_C_records, open_class_C_records_note: openC.length > 15 ? `newest 15 of ${openC.length} open class C` : `all ${openC.length} open class C`,
        recent, recent_note: "the 8 most recently issued violations, ANY status (open or closed)", note: "Class C = immediately hazardous." };
    }

    if (dataset === "rodent") {
      // All inspections, newest first: windowed counts are computed here exactly
      // (the dashboard's dial uses the same 5-year window).
      const rowsAll = await socrata(cfg.id, new URLSearchParams({ "$select": "inspection_date, result", "$where": where, "$order": "inspection_date DESC", "$limit": "2000" }));
      const byResult = {}; let ratFails = 0, ratFails5 = 0, insp5 = 0, latestFail = null;
      const isRat = (x) => /rat activity/i.test(x || "");
      for (const r of rowsAll) {
        byResult[r.result] = (byResult[r.result] || 0) + 1;
        const within5 = monthsAgo(r.inspection_date) <= 60;
        if (within5) insp5++;
        if (isRat(r.result)) { ratFails++; if (within5) ratFails5++; if (!latestFail) latestFail = r.inspection_date || null; }
      }
      const recent = rowsAll.slice(0, 8).map((r) => ({ date: r.inspection_date || null, result: r.result || "" }));
      const latest = rowsAll[0] ? { date: String(rowsAll[0].inspection_date || "").slice(0, 10) || null, result: rowsAll[0].result || "" } : null;
      return { type: "rodent", dataset: cfg.label, address: `${hn} ${sn}`, results: byResult, failed_for_rat_activity: ratFails,
        rat_failures_last_5_years: ratFails5, rat_failures_all_time: ratFails, inspections_last_5_years: insp5,
        latest_inspection: latest, latest_rat_failure_date: latestFail ? String(latestFail).slice(0, 10) : null,
        latest_rat_failure_months_ago: latestFail ? Math.floor(monthsAgo(latestFail)) : null, recent };
    }

    // bedbug — annual filings are largely MANDATORY reports, not warnings. Each
    // filing reports the past year, so summing filings double-counts: what's
    // infested NOW is the LATEST filing's count. Duplicate rows for the same
    // filing date are collapsed first.
    const rowsAll = await socrata(cfg.id, new URLSearchParams({ "$select": "filing_date, infested_dwelling_unit_count, eradicated_unit_count, re_infested_dwelling_unit", "$where": where, "$order": "filing_date DESC", "$limit": "500" }));
    const byDate = new Map();
    for (const x of rowsAll) {
      const k = String(x.filing_date || "").slice(0, 10); if (!k) continue;
      const o = byDate.get(k) || { date: k, infested: 0, eradicated: 0, re_infested: 0 };
      o.infested = Math.max(o.infested, Number(x.infested_dwelling_unit_count) || 0);
      o.eradicated = Math.max(o.eradicated, Number(x.eradicated_unit_count) || 0);
      o.re_infested = Math.max(o.re_infested, Number(x.re_infested_dwelling_unit) || 0);
      byDate.set(k, o);
    }
    const filingsList = [...byDate.values()]; // newest first
    const latest = filingsList[0] || null;
    const infested_units = filingsList.reduce((a, f) => a + f.infested, 0);
    const eradicated_units = filingsList.reduce((a, f) => a + f.eradicated, 0);
    const net_active = latest ? latest.infested : 0;
    const re_infested = latest ? latest.re_infested : 0;
    const recent = filingsList.slice(0, 8).map((x) => ({ date: x.date, infested: x.infested, eradicated: x.eradicated }));
    return { type: "bedbug", dataset: cfg.label, address: `${hn} ${sn}`, filings: filingsList.length, latest_filing: latest,
      infested_units, eradicated_units, infested_units_note: "summed across all filings ever (history, not current)", re_infested, net_active,
      net_active_note: "infested units in the LATEST filing only", recent };
  } catch (err) {
    return { dataset: cfg.label, error: err.message || "NYC Open Data query failed" };
  }
}

const SYSTEM =
  "You are a renter's advocate for NYC. Given a building address, investigate it with the " +
  "query_building tool (parse the address into house_number, street_name [street only, spell out " +
  "E/W as East/West], zip, borough; call the tool for the relevant datasets). The user already sees " +
  "per-dataset counts as cards.\n\n" +
  "After gathering data, write ONLY a short bottom-line summary: 2-3 sentences, plain prose, no " +
  "headings or bullets. Give the verdict and the most useful thing to ask the landlord. Base every " +
  "statement on tool results; never invent numbers; no outside knowledge.";

// System prompt for the FAST PATH: the data is already gathered, just write.
// The verdict's TONE is anchored to a deterministic SEVERITY band (see
// api/severity.js) so the model can't over- or under-state the headline — the
// calibration failure our evals caught (e.g. calling a not-found address
// "excellent"). The band is computed in code; the model only writes the prose.
const SYSTEM_WRITE =
  "You are a renter's advocate for NYC. Official records for ONE building have ALREADY been " +
  "gathered (JSON below): housing violations, rodent inspections, bedbug filings. The user ALREADY " +
  "SEES the per-dataset counts as cards, so DO NOT repeat every number.\n\n" +
  "You are also given a SEVERITY band computed deterministically from those records. Your verdict's " +
  "tone MUST match it — do not overstate or understate:\n" +
  "  • RED — lead with clear, specific concern about the current/serious issue.\n" +
  "  • AMBER — a mixed or resolved-history picture: neither alarming nor spotless.\n" +
  "  • GREEN — reassuring; a clean record is genuinely good news.\n" +
  "  • NOT_FOUND — NO city records matched this address. Do NOT rate the building good or bad, and " +
  "do NOT call it clean, excellent, or in good shape. State plainly that no records were found, " +
  "which may mean a well-kept building OR an address that didn't match city records, and suggest " +
  "double-checking the address.\n\n" +
  "TIME: today's date is given with the records. Use any *_months_ago field as given; otherwise compute \"how long ago\" from today's date exactly; " +
  "never say \"past year\" or \"recently\" about something more than 12 months before today. Prefer naming the month and year.\n" +
  "NO GUESSING: state only what the records show. Don't infer landlord behavior or speed (no \"slow to report\", \"quickly\", \"monitoring\"); " +
  "annual bedbug filings are mandatory reports, not a sign of a problem.\n\n" +
  "FACTS: use ONLY the counts and dates given; never compute your own totals. Dates mean exactly what their " +
  "field names say: oldest_open_date / newest_open_date are the OLDEST / NEWEST still-open violation of ANY class; " +
  "for class C (immediately hazardous) dates use oldest_open_class_C_date / newest_open_class_C_date and cite only open_class_C_records. For rats, latest_inspection is the most " +
  "recent inspection of ANY result and latest_rat_failure_date the most recent FAILURE; don't call a failure the latest " +
  "inspection unless the dates match. Give rat-failure counts from rat_failures_last_5_years (\"in the last 5 years\") or " +
  "rat_failures_all_time (\"ever\"). For bedbugs, what's infested now is net_active (the latest filing only); never " +
  "add up filings. Whenever you give a count, name its time window (\"open now\", \"in the last 5 years\", \"ever\", " +
  "\"in the latest filing\"). Use correct singular/plural.\n" +
  "NEVER mention the severity band, its name (RED, AMBER, GREEN, NOT_FOUND), a color rating, a grade, or any field " +
  "or internal label; just write the plain-language verdict. Never use em-dashes.\n\n" +
  "Write ONLY a short bottom-line summary: 2-3 sentences, plain prose, no headings, no bold, no bullets. " +
  "Give the verdict and the one or two facts that matter most. Don't list questions for the landlord (the page shows them separately). Base it strictly on the " +
  "data; never invent numbers; no outside knowledge.";

// ── FAST PATH — no agent loop. Query all three in parallel, then one write. ──
async function fullCheck(anthropic, { address, zip, borough, house_number, street_name, bbl }) {
  // Prefer explicit structured fields; fall back to parsing the address string.
  let hn = house_number, sn = street_name;
  if (!hn || !sn) {
    const parsed = parseAddress(address);
    hn = hn || parsed.house_number;
    sn = sn || parsed.street_name;
  }

  // PLUTO facts (same lookup the dashboard makes) so the summary can flag a
  // non-residential building or NYCHA the same way the hero does.
  const plutoP = /^\d{10}$/.test(String(bbl || ""))
    ? socrata("64uk-42ks", new URLSearchParams({ "$select": "unitsres, ownername", "$where": `bbl='${bbl}'`, "$limit": "1" })).then((r) => r[0] || null).catch(() => null)
    : Promise.resolve(null);
  const [results, pluto] = await Promise.all([
    Promise.all(FINDING_ORDER.map((dataset) => runQueryBuilding({ dataset, house_number: hn, street_name: sn, zip, borough, bbl }))),
    plutoP,
  ]);
  const notes = [];
  if (pluto && (Number(pluto.unitsres) === 0 || /EDUCATION|SCHOOL CONSTRUCTION/i.test(pluto.ownername || "")))
    notes.push("City land records list 0 residential units here (or a school owner): this does not look like a residential building, so say plainly that housing records may not apply, and do not call it clean or a good place to rent.");
  if (pluto && /HOUSING AUTH/i.test(pluto.ownername || ""))
    notes.push("This is NYCHA public housing: note that HPD records cover NYCHA poorly and these records are for the whole development.");

  // Findings for the UI: clean, error-free, in canonical order.
  const findings = results.filter((r) => r && r.type && !r.error);

  // Deterministic headline band — anchors the verdict's tone (calibration).
  const severity = assessSeverity(findings);

  const reply = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 220,
    temperature: 0, // same building → same summary
    system: SYSTEM_WRITE,
    messages: [
      {
        role: "user",
        content:
          `Today's date: ${new Date().toISOString().slice(0, 10)}\n` +
          `Building: ${address || `${hn} ${sn}`}\n\n` +
          `SEVERITY BAND (internal, never mention it; your verdict's tone MUST match it):\n` +
          `${severity.band}: ${severity.reasons.join("; ")}\n\n` +
          (notes.length ? `BUILDING NOTES:\n${notes.join("\n")}\n\n` : "") +
          `Records (JSON):\n${JSON.stringify(results, null, 2)}\n\n` +
          "Write the renter's report card.",
      },
    ],
  });
  const answer = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    .replace(/\s*—\s*/g, ", "); // house style: no em-dashes in user-facing copy
  return { answer, findings, severity };
}

// ── AGENT LOOP — model decides which datasets to hit (focused questions) ────
async function agentLoop(anthropic, { question, zip }) {
  const messages = [{ role: "user", content: zip ? `(User is viewing ZIP ${zip}.) ${question}` : question }];

  // Latest clean result per type; rendered as cards in canonical order.
  const findingsByType = new Map();
  const collectFindings = () =>
    FINDING_ORDER.filter((t) => findingsByType.has(t)).map((t) => findingsByType.get(t));

  let steps = 0;
  while (steps++ < MAX_STEPS) {
    const reply = await anthropic.messages.create({ model: MODEL, max_tokens: 300, system: SYSTEM, tools, messages });

    if (reply.stop_reason !== "tool_use") {
      const answer = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (process.env.DEBUG_AGENT) console.error(`[step ${steps}] Claude gave its FINAL ANSWER — loop ends.`);
      const findings = collectFindings();
      return { answer, findings, severity: assessSeverity(findings) };
    }

    messages.push({ role: "assistant", content: reply.content });

    // Run ALL tool_use blocks from this turn IN PARALLEL, not one-by-one.
    const toolBlocks = reply.content.filter((b) => b.type === "tool_use");
    const settled = await Promise.all(toolBlocks.map((b) => runQueryBuilding(b.input)));

    const toolResults = [];
    for (let i = 0; i < toolBlocks.length; i++) {
      const block = toolBlocks[i];
      const result = settled[i];
      if (result && result.type && !result.error) findingsByType.set(result.type, result);
      if (process.env.DEBUG_AGENT)
        console.error(`[step ${steps}] Claude checked ${result.dataset || block.input.dataset} for ${block.input.house_number} ${block.input.street_name} → ${JSON.stringify(result).slice(0, 140)}`);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const findings = collectFindings();
  return { answer: "I couldn't finish the lookup. Try giving a full street address with ZIP.", findings, severity: assessSeverity(findings) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  try {
    const body = req.body || {};
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // FAST PATH: default full check. All three datasets, in parallel, one write.
    if (body.mode === "full") {
      const out = await fullCheck(anthropic, body);
      return res.status(200).json(out);
    }

    // AGENT LOOP: focused question — the model chooses which datasets to hit.
    if (!body.question) return res.status(400).json({ error: "Missing 'question' (or mode:'full')." });
    const out = await agentLoop(anthropic, body);
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown error calling Claude." });
  }
}
