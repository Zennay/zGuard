export function requestPath(req, fallback = '') {
  return req?.originalUrl || req?.url || fallback;
}
