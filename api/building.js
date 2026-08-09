// Vercel serverless function — a building "report card" AGENT.
//
// ────────────────────────────────────────────────────────────────────────────
// THE IDEA
// ────────────────────────────────────────────────────────────────────────────
// You give it a NYC address ("51 E 10th Street, 10003"). To answer "should I
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

// Split a one-line address ("51 East 10 Street, Manhattan, NY 10003") into a
// house number + street. Used by the fast path when the caller sends a string.
export function parseAddress(address) {
  const line1 = String(address || "").split(",")[0].trim();
  const m = line1.match(/^\s*(\d+[a-zA-Z]?)\s+(.*)$/);
  if (m) return { house_number: m[1], street_name: m[2] };
  return { house_number: "", street_name: line1 };
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
async function runQueryBuilding({ dataset, house_number, street_name, zip, borough }) {
  const cfg = DATASETS[dataset];
  if (!cfg) return { error: `Unknown dataset '${dataset}'.` };

  const hn = String(house_number || "").replace(/'/g, "").trim();
  const sn = normalizeStreet(street_name);
  const clauses = [`${cfg.hn}='${hn}'`, `upper(${cfg.st}) like '%${sn}%'`];
  if (zip && cfg.zip) clauses.push(`${cfg.zip}='${String(zip).replace(/'/g, "").trim()}'`);
  if (borough && cfg.borough) clauses.push(`upper(${cfg.borough})=upper('${String(borough).replace(/'/g, "")}')`);
  const where = clauses.join(" AND ");

  try {
    if (dataset === "violations") {
      const countP = socrata(cfg.id, new URLSearchParams({ "$select": "class, violationstatus, count(*) AS count", "$where": where, "$group": "class, violationstatus", "$limit": "50" }));
      const recentP = socrata(cfg.id, new URLSearchParams({ "$select": "novissueddate, inspectiondate, class, violationstatus, novdescription", "$where": where, "$order": "novissueddate DESC", "$limit": "8" }));
      const openP = socrata(cfg.id, new URLSearchParams({ "$select": "novissueddate", "$where": `${where} AND upper(violationstatus) like 'OPEN%'`, "$order": "novissueddate DESC", "$limit": "1" }));
      const [rows, recentRows, openRows] = await Promise.all([countP, recentP, openP]);

      const open = {}; let openTotal = 0, total = 0;
      for (const r of rows) {
        const n = Number(r.count) || 0; total += n;
        if ((r.violationstatus || "").toLowerCase().startsWith("open")) { open[r.class] = (open[r.class] || 0) + n; openTotal += n; }
      }
      const recent = recentRows.map((r) => ({
        date: r.novissueddate || r.inspectiondate || null,
        class: r.class || "",
        status: r.violationstatus || "",
        desc: truncate(r.novdescription, 120),
      }));
      const latest_open_date = (openRows[0] && openRows[0].novissueddate) || null;
      return { type: "violations", dataset: cfg.label, address: `${hn} ${sn}`, total_violations: total, open_violations_by_class: open, open_hazardous_class_C: open.C || 0, latest_open_date, recent, note: "Class C = immediately hazardous." };
    }

    if (dataset === "rodent") {
      const countP = socrata(cfg.id, new URLSearchParams({ "$select": "result, count(*) AS count", "$where": where, "$group": "result", "$limit": "50" }));
      const recentP = socrata(cfg.id, new URLSearchParams({ "$select": "inspection_date, result", "$where": where, "$order": "inspection_date DESC", "$limit": "8" }));
      const [rows, recentRows] = await Promise.all([countP, recentP]);

      const byResult = {}; let ratFails = 0;
      for (const r of rows) { const n = Number(r.count) || 0; byResult[r.result] = n; if (/rat activity/i.test(r.result || "")) ratFails += n; }
      const recent = recentRows.map((r) => ({ date: r.inspection_date || null, result: r.result || "" }));
      return { type: "rodent", dataset: cfg.label, address: `${hn} ${sn}`, results: byResult, failed_for_rat_activity: ratFails, recent };
    }

    // bedbug — annual filings are largely MANDATORY reports, not warnings. A
    // building can file "9 infested" across the years yet have every one of
    // those eradicated and none recur — that is NOT an active problem. So we
    // aggregate eradications + recurrences too and derive a NET-ACTIVE count.
    const countP = socrata(cfg.id, new URLSearchParams({ "$select": "count(*) AS filings, sum(infested_dwelling_unit_count) AS infested_units, sum(eradicated_unit_count) AS eradicated_units, sum(re_infested_dwelling_unit) AS re_infested", "$where": where, "$limit": "1" }));
    const recentP = socrata(cfg.id, new URLSearchParams({ "$select": "filing_date, infested_dwelling_unit_count, eradicated_unit_count", "$where": where, "$order": "filing_date DESC", "$limit": "8" }));
    const [rows, recentRows] = await Promise.all([countP, recentP]);
    const r = rows[0] || {};
    const infested_units = Number(r.infested_units) || 0;
    const eradicated_units = Number(r.eradicated_units) || 0;
    const re_infested = Number(r.re_infested) || 0;
    const net_active = Math.max(0, infested_units - eradicated_units);
    const recent = recentRows.map((x) => ({ date: x.filing_date || null, infested: Number(x.infested_dwelling_unit_count) || 0, eradicated: Number(x.eradicated_unit_count) || 0 }));
    return { type: "bedbug", dataset: cfg.label, address: `${hn} ${sn}`, filings: Number(r.filings) || 0, infested_units, eradicated_units, re_infested, net_active, recent };
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
const SYSTEM_WRITE =
  "You are a renter's advocate for NYC. Official records for ONE building have ALREADY been " +
  "gathered (JSON below): housing violations, rodent inspections, bedbug filings. The user ALREADY " +
  "SEES the per-dataset counts as cards, so DO NOT repeat every number.\n\n" +
  "Write ONLY a short bottom-line summary: 2-3 sentences, plain prose, no headings, no bullets. " +
  "Give the overall verdict and the single most useful thing to ask the landlord. Base it strictly " +
  "on the data; no outside knowledge; a clean dataset is good news.";

// ── FAST PATH — no agent loop. Query all three in parallel, then one write. ──
async function fullCheck(anthropic, { address, zip, borough, house_number, street_name }) {
  // Prefer explicit structured fields; fall back to parsing the address string.
  let hn = house_number, sn = street_name;
  if (!hn || !sn) {
    const parsed = parseAddress(address);
    hn = hn || parsed.house_number;
    sn = sn || parsed.street_name;
  }

  const results = await Promise.all(
    FINDING_ORDER.map((dataset) => runQueryBuilding({ dataset, house_number: hn, street_name: sn, zip, borough }))
  );

  // Findings for the UI: clean, error-free, in canonical order.
  const findings = results.filter((r) => r && r.type && !r.error);

  const reply = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 220,
    system: SYSTEM_WRITE,
    messages: [
      {
        role: "user",
        content:
          `Building: ${address || `${hn} ${sn}`}\n\n` +
          `Records (JSON):\n${JSON.stringify(results, null, 2)}\n\n` +
          "Write the renter's report card.",
      },
    ],
  });
  const answer = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { answer, findings };
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
      return { answer, findings: collectFindings() };
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

  return { answer: "I couldn't finish the lookup — try giving a full street address with ZIP.", findings: collectFindings() };
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
