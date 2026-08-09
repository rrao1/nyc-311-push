// Vercel serverless proxy for address autocomplete.
//
// Calls the Mapbox Geocoding API, keeping MAPBOX_TOKEN server-side — never in
// the browser or the repo (same pattern as ANTHROPIC_API_KEY). It reshapes
// Mapbox's response into the SAME GeoJSON shape the old GeoSearch returned, so
// the frontend autocomplete code didn't have to change.

const NYC_BBOX = "-74.2709,40.4774,-73.7002,40.9176"; // rough NYC bounds
const NYC_PROX = "-73.9857,40.7484";                    // bias results toward Manhattan
const BOROUGHS = new Set(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "The Bronx"]);

export default async function handler(req, res) {
  const text = (req.query && (req.query.text || req.query.q)) || "";
  if (!text || String(text).trim().length < 3) return res.status(200).json({ features: [] });

  const token = process.env.MAPBOX_TOKEN;
  if (!token) return res.status(500).json({ error: "Server is missing MAPBOX_TOKEN." });

  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json` +
      `?access_token=${token}&autocomplete=true&country=us&limit=5&types=address` +
      `&bbox=${NYC_BBOX}&proximity=${NYC_PROX}`;

    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `Mapbox ${r.status}` });
    const data = await r.json();

    const features = (data.features || []).map((f) => {
      const ctx = f.context || [];
      const postalcode = (ctx.find((c) => (c.id || "").startsWith("postcode")) || {}).text || "";
      const borough = (ctx.find((c) => BOROUGHS.has(c.text)) || {}).text || "";
      const label = String(f.place_name || "").replace(/,\s*United States$/, "");
      return {
        geometry: { coordinates: f.center || [] }, // [lng, lat]
        properties: {
          label,
          housenumber: f.address || "",
          street: f.text || "", // e.g. "East 10th Street"; the building agent normalizes it
          borough,
          postalcode,
        },
      };
    });

    // Cache identical queries at Vercel's edge for a day (autocomplete repeats a lot).
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    return res.status(200).json({ features });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Geocode error." });
  }
}
