# NYC 311 Neighborhood Dashboard

Type a NYC ZIP code and see the top **311 complaint types** reported in that area
over the last 12 months — with a **Claude-powered Q&A** grounded in the numbers.

Built as a portfolio piece: a real AI feature (an LLM wired to live open data with
guardrails) rather than a bare chatbot.

## How it's put together

| Piece | What it does | Needs a key? |
|-------|--------------|--------------|
| `index.html` / `styles.css` / `app.js` | The dashboard UI + chart | ❌ No |
| NYC Socrata Open Data API | Aggregates 311 counts server-side | ❌ No |
| `api/chat.js` (Vercel function) | Proxies questions to Claude | ✅ Yes (server-side only) |

The dashboard queries NYC's API directly, so **the counting happens on NYC's
servers** — the browser only downloads ~12 summarized rows, never millions.
The Claude key lives *only* in the serverless function's environment, never in the
browser.

## Run it locally

**Just the dashboard** (no key needed) — open `index.html` in a browser, or:
```bash
npx serve .
```

**With the AI chat** — needs the Vercel CLI so the `/api` function runs:
```bash
npm install
npm install -g vercel
cp .env.example .env      # then paste your real key into .env
vercel dev                # serves the site + /api/chat at localhost:3000
```
Get a Claude API key at <https://console.anthropic.com/settings/keys>.

## Deploy to Vercel

1. Create a free account at <https://vercel.com> (sign in with GitHub).
2. Push this folder to a GitHub repo.
3. In Vercel: **Add New → Project → import the repo.**
4. Under **Settings → Environment Variables**, add:
   `ANTHROPIC_API_KEY = sk-ant-…`
5. Deploy. Your site is live at `https://your-project.vercel.app`.

Every future `git push` redeploys automatically.

## Ideas for v2

- Compare a ZIP against the citywide average ("noisier than average?").
- Let Claude translate a free-text question into the Socrata query (text-to-query).
- Time trends: is a complaint type rising or falling?
- Map view of a single complaint type.

## Data

[NYC 311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9)
via the Socrata Open Data API (dataset `erm2-nwe9`).
