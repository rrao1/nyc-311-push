// Vercel serverless function — the NEIGHBORHOOD agent (powers index.html).
//
// This is an AGENT LOOP: Claude has a `query_311` tool and can query NYC's live
// 311 data itself, look at the result, and query again — until it can answer.
// (The BUILDING report-card agent lives separately in api/building.js.)

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001";
const SODA_ENDPOINT = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const MAX_STEPS = 6;

const tools = [
  {
    name: "query_311",
    description:
      "Query NYC's live 311 complaint database (last 12 months). Returns real " +
      "aggregated counts. Call this whenever you need numbers you don't already " +
      "have — a monthly trend, a citywide total to compare against, or the top " +
      "complaints for a ZIP.",
    input_schema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "5-digit NYC ZIP to filter to. Omit for CITYWIDE (for comparisons)." },
        complaint_type: { type: "string", description: "Optional keyword filter, e.g. 'noise', 'rodent', 'heat'. Case-insensitive substring." },
        group_by: {
          type: "string",
          enum: ["complaint_type", "month", "borough", "none"],
          description: "'month' → time trend, 'complaint_type' → ranked issues, 'borough' → by borough, 'none' → single total.",
        },
      },
      required: ["group_by"],
    },
  },
];

async function runQuery311({ zip, complaint_type, group_by }) {
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const sinceISO = since.toISOString().slice(0, 10);

  const clauses = [`created_date >= '${sinceISO}'`];
  if (zip && /^\d{5}$/.test(zip)) clauses.push(`incident_zip = '${zip}'`);
  if (complaint_type) {
    const safe = String(complaint_type).replace(/'/g, "").toUpperCase();
    clauses.push(`UPPER(complaint_type) LIKE '%${safe}%'`);
  }

  const dims = {
    month: { select: "date_trunc_ym(created_date) AS month, count(*) AS count", group: "date_trunc_ym(created_date)", order: "month" },
    complaint_type: { select: "complaint_type, count(*) AS count", group: "complaint_type", order: "count DESC" },
    borough: { select: "borough, count(*) AS count", group: "borough", order: "count DESC" },
    none: { select: "count(*) AS count", group: null, order: null },
  };
  const d = dims[group_by] || dims.none;

  const params = new URLSearchParams({ "$select": d.select, "$where": clauses.join(" AND "), "$limit": "50" });
  if (d.group) params.set("$group", d.group);
  if (d.order) params.set("$order", d.order);

  const res = await fetch(`${SODA_ENDPOINT}?${params.toString()}`);
  if (!res.ok) return { error: `NYC Open Data returned ${res.status}` };
  const rows = await res.json();
  return { scope: zip ? `ZIP ${zip}` : "citywide", filter: complaint_type || "all types", rows };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  try {
    const { zip, question } = req.body || {};
    if (!question) return res.status(400).json({ error: "Missing 'question'." });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const messages = [
      { role: "user", content: `The user is currently viewing ZIP ${zip || "(none selected)"}. Question: ${question}` },
    ];

    const system =
      "You are a concise, friendly analyst for NYC 311 complaint data. You have a " +
      "query_311 tool that fetches REAL live counts — use it to get any numbers you " +
      "need rather than guessing, and feel free to call it more than once (e.g. once " +
      "for the ZIP and once citywide to compare). Base every number you state on tool " +
      "results. Keep the final answer to a few sentences. Only discuss NYC 311 data.";

    let steps = 0;
    while (steps++ < MAX_STEPS) {
      const reply = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system, tools, messages });

      if (reply.stop_reason !== "tool_use") {
        const answer = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (process.env.DEBUG_AGENT) console.error(`[step ${steps}] Claude gave its FINAL ANSWER — loop ends.`);
        return res.status(200).json({ answer });
      }

      messages.push({ role: "assistant", content: reply.content });

      const toolResults = [];
      for (const block of reply.content) {
        if (block.type !== "tool_use") continue;
        const result = await runQuery311(block.input);
        if (process.env.DEBUG_AGENT)
          console.error(`[step ${steps}] Claude called query_311(${JSON.stringify(block.input)}) → got ${(result.rows || []).length} rows back`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }

    return res.status(200).json({ answer: "I wasn't able to finish looking that up — try asking something a bit more specific." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown error calling Claude." });
  }
}
