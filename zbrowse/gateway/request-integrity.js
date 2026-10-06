function headerValue(req, name) {
  if (typeof req.get === "function") return req.get(name);
  return req.headers?.[name.toLowerCase()];
}

export function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  return /^application\/json(?:\s*;|$)/i.test(value.trim());
}

export function blockCrossSiteWrite(req, res, next) {
  const fetchSite = headerValue(req, "sec-fetch-site");
  if (typeof fetchSite === "string" && fetchSite.trim().toLowerCase() === "cross-site") {
    return res.status(403).json({ error: "Cross-site API requests are not allowed." });
  }
  return next();
}

export function requireJsonBody(req, res, next) {
  if (!isJsonContentType(headerValue(req, "content-type"))) {
    return res.status(415).json({ error: "Content-Type must be application/json." });
  }
  return next();
}
