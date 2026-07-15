// Vercel serverless function — the safe home for your Claude API key.
//
// This is the "foundation" piece: the browser never sees ANTHROPIC_API_KEY.
// The frontend POSTs the current ZIP's complaint data + a question here; this
// function calls Claude with that data as grounding and returns plain text.
//
// Set ANTHROPIC_API_KEY in the Vercel dashboard (Settings → Environment Variables)
// or in a local .env file when running `vercel dev`.

import Anthropic from "@anthropic-ai/sdk";

// Haiku is fast + cheap and plenty for grounded data Q&A.
// Upgrade to "claude-sonnet-5" for richer analysis if you want.
const MODEL = "claude-haiku-4-5-20251001";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your environment variables." });
  }

  try {
    const { zip, complaints = [], total = 0, question } = req.body || {};
    if (!question) return res.status(400).json({ error: "Missing 'question'." });

    // Turn the aggregated numbers into a compact, model-readable summary.
    const dataSummary = complaints
      .map((c, i) => `${i + 1}. ${c.type}: ${c.count}`)
      .join("\n");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system:
        "You are a concise, friendly data analyst for NYC 311 complaint data. " +
        "Answer ONLY using the complaint counts provided in the user's message — " +
        "do not invent numbers or cite data you weren't given. If the question " +
        "can't be answered from the data, say so plainly. Keep answers to a few " +
        "sentences and reference specific numbers when relevant.",
      messages: [
        {
          role: "user",
          content:
            `ZIP code: ${zip}\n` +
            `Total complaints (last 12 months): ${total}\n` +
            `Top complaint types (type: count):\n${dataSummary}\n\n` +
            `Question: ${question}`,
        },
      ],
    });

    const answer = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return res.status(200).json({ answer });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown error calling Claude." });
  }
}
