// Vercel serverless function: hands the browser the PUBLIC Mapbox token for
// the 3D map. Only a public token (pk.…) is ever returned; restrict it to this
// site's URLs in the Mapbox dashboard. A secret token (sk.…) is never exposed.
export default function handler(req, res) {
  const token = process.env.MAPBOX_PUBLIC_TOKEN || process.env.MAPBOX_TOKEN || "";
  if (!token.startsWith("pk.")) return res.status(404).json({ error: "No public Mapbox token configured." });
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json({ token });
}
