const BACKEND = process.env.BACKEND_URL || "http://16.176.144.172:3001";

export default async function handler(req, res) {
  const { path } = req.query;
  const target = Array.isArray(path) ? path.join("/") : path;
  const qs = new URL(req.url, `http://${req.headers.host}`).search || "";
  const url = `${BACKEND}/${target}${qs}`;

  try {
    const headers = { "Content-Type": "application/json" };
    const opts = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, opts);
    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = await upstream.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", contentType);
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: "Backend unreachable", detail: err.message });
  }
}
