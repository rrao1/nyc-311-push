// Vercel serverless function — LAZY per-category drill-down for the report card.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ────────────────────────────────────────────────────────────────────────────
// The main /api/building check is deliberately fast (~6s): three parallel
// lookups + one model call. It ships only a small "recent records" preview per
// dataset. But "recent" hides the very thing a renter needs — an OLD item that
// is still OPEN (e.g. a years-old failed rat inspection buried under recent
// passes). So when — and ONLY when — the user EXPANDS a category card, the
// frontend calls THIS endpoint, which:
//   (1) runs a FLAGGED-records query (the status-driving records, any age) and
//   (2) a RECENT-records query, IN PARALLEL, then
//   (3) makes ONE small Haiku call to summarize that category in plain language,
//       grounded ONLY in the records it just pulled.
// Returns { flagged, recent, summary }. The main check is never slowed down.
// ────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { MODEL, DATASETS, normalizeStreet, parseAddress, truncate, socrata } from "./building.js";

// Rebuild the SAME address WHERE clause the building agent uses, so the drill-
// down queries the identical building. Accepts structured fields or a raw
// address string (reusing the agent's parse + normalize).
function resolveWhere(cfg, body) {
  let hn = body.house_number, sn = body.street_name;
  if (!hn || !sn) {
    const parsed = parseAddress(body.address);
    hn = hn || parsed.house_number;
    sn = sn || parsed.street_name;
  }
  hn = String(hn || "").replace(/'/g, "").trim();
  sn = normalizeStreet(sn);

  const clauses = [`${cfg.hn}='${hn}'`, `upper(${cfg.st}) like '%${sn}%'`];
  if (body.zip && cfg.zip) clauses.push(`${cfg.zip}='${String(body.zip).replace(/'/g, "").trim()}'`);
  if (body.borough && cfg.borough) clauses.push(`upper(${cfg.borough})=upper('${String(body.borough).replace(/'/g, "")}')`);
  return { where: clauses.join(" AND "), hn, sn };
}

// ── Per-type queries: a FLAGGED set (needs-attention, any age) + a RECENT set ─
async function fetchViolations(cfg, where) {
  const flaggedP = socrata(cfg.id, new URLSearchParams({
    "$select": "novissueddate, inspectiondate, class, violationstatus, novdescription",
    // "not closed" == open, ANY class, regardless of age — this is the fix.
    "$where": `${where} AND upper(violationstatus) like 'OPEN%'`,
    "$order": "novissueddate DESC", "$limit": "20",
  }));
  const recentP = socrata(cfg.id, new URLSearchParams({
    "$select": "novissueddate, inspectiondate, class, violationstatus, novdescription",
    "$where": where, "$order": "novissueddate DESC", "$limit": "8",
  }));
  const [flaggedRows, recentRows] = await Promise.all([flaggedP, recentP]);
  const map = (r) => ({
    date: r.novissueddate || r.inspectiondate || null,
    class: r.class || "",
    status: r.violationstatus || "",
    desc: truncate(r.novdescription, 140),
  });
  return { flagged: flaggedRows.map(map), recent: recentRows.map(map) };
}

async function fetchRodent(cfg, where) {
  const flaggedP = socrata(cfg.id, new URLSearchParams({
    "$select": "inspection_date, result",
    // Failed / active rat signs, ANY age — surfaces the old open item.
    "$where": `${where} AND (upper(result) like '%FAIL%' OR upper(result) like '%RAT ACTIVITY%' OR upper(result) like '%ACTIVE%')`,
    "$order": "inspection_date DESC", "$limit": "20",
  }));
  const recentP = socrata(cfg.id, new URLSearchParams({
    "$select": "inspection_date, result",
    "$where": where, "$order": "inspection_date DESC", "$limit": "8",
  }));
  const [flaggedRows, recentRows] = await Promise.all([flaggedP, recentP]);
  const map = (r) => ({ date: r.inspection_date || null, result: r.result || "" });
  return { flagged: flaggedRows.map(map), recent: recentRows.map(map) };
}

async function fetchBedbug(cfg, where) {
  const flaggedP = socrata(cfg.id, new URLSearchParams({
    "$select": "filing_date, infested_dwelling_unit_count, eradicated_unit_count, re_infested_dwelling_unit",
    // Unresolved (more infested than eradicated) OR a recurrence — any age.
    "$where": `${where} AND (infested_dwelling_unit_count > eradicated_unit_count OR re_infested_dwelling_unit > 0)`,
    "$order": "filing_date DESC", "$limit": "20",
  }));
  const recentP = socrata(cfg.id, new URLSearchParams({
    "$select": "filing_date, infested_dwelling_unit_count, eradicated_unit_count",
    "$where": where, "$order": "filing_date DESC", "$limit": "8",
  }));
  const [flaggedRows, recentRows] = await Promise.all([flaggedP, recentP]);
  const map = (r) => ({
    date: r.filing_date || null,
    infested: Number(r.infested_dwelling_unit_count) || 0,
    eradicated: Number(r.eradicated_unit_count) || 0,
  });
  return { flagged: flaggedRows.map(map), recent: recentRows.map(map) };
}

const FETCHERS = { violations: fetchViolations, rodent: fetchRodent, bedbug: fetchBedbug };

const SUMMARY_LABEL = {
  violations: "HPD housing code violations",
  rodent: "DOHMH rodent inspection results",
  bedbug: "HPD bedbug filings",
};

const SYSTEM_DETAIL =
  "You summarize official NYC records for ONE building, for a renter, in plain language.\n" +
  "You are given the records for a SINGLE category as JSON: a 'flagged' list (records that need " +
  "attention, of any age) and a 'recent' list (the newest records overall).\n\n" +
  "RULES:\n" +
  "- Base EVERY word ONLY on the records shown. Never invent numbers, dates, or facts.\n" +
  "- Write 1 to 3 short sentences, plain and calm.\n" +
  "- If the 'flagged' list has items, lead with them (what and roughly when) — these are what matter.\n" +
  "- If there is nothing flagged, say plainly that this category looks clean; note briefly if there was resolved history.\n" +
  "- No preamble, no headings, no bullet points — just the sentences.";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET")
    return res.status(405).json({ error: "Use POST or GET." });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const type = String(body.type || "").trim();
  const cfg = DATASETS[type];
  if (!cfg) return res.status(400).json({ error: "type must be one of: violations, rodent, bedbug." });

  try {
    const { where } = resolveWhere(cfg, body);
    const { flagged, recent } = await FETCHERS[type](cfg, where);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let summary = "";
    try {
      const reply = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 180,
        system: SYSTEM_DETAIL,
        messages: [
          {
            role: "user",
            content:
              `Category: ${SUMMARY_LABEL[type]}\n\n` +
              `Records (JSON):\n${JSON.stringify({ flagged, recent }, null, 2)}\n\n` +
              "Write the plain-language summary.",
          },
        ],
      });
      summary = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    } catch {
      // The records are the source of truth; the summary is a nicety. If the
      // model call fails, still return the receipts rather than erroring out.
      summary = flagged.length
        ? `${flagged.length} record${flagged.length > 1 ? "s" : ""} need attention.`
        : recent.length
          ? "No items currently need attention in this category."
          : "No records on file for this category.";
    }

    return res.status(200).json({ flagged, recent, summary });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Detail lookup failed." });
  }
}
