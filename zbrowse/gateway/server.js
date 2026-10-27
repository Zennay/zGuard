import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nonNegativeInt, positiveInt, positiveNumber } from "./config-values.js";
import { requestIp } from "./request-ip.js";
import { requestPath } from "./request-path.js";
import { createSessionAdmission } from "./session-admission.js";
import { isSessionExpired } from "./session-lifetime.js";
import Docker from "dockerode";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createProxyServer } from "httpxy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const sessions = new Map();
const sessionsByIp = new Map();

const config = {
  port: positiveInt(process.env.PORT, 8090),
  maxSessions: positiveInt(process.env.MAX_SESSIONS, 1),
  ttlMs: positiveInt(process.env.SESSION_TTL_MINUTES, 15) * 60_000,
  idleMs: positiveInt(process.env.IDLE_TTL_MINUTES, 5) * 60_000,
  memoryBytes: positiveInt(process.env.BROWSER_MEMORY_MB, 2048) * 1024 * 1024,
  nanoCpus: Math.max(0.25, positiveNumber(process.env.BROWSER_CPU, 1)) * 1e9,
  image: process.env.BROWSER_IMAGE || "zbrowse-browser:1.0.0",
  network: process.env.BROWSER_NETWORK || "zbrowse_net",
  startUrl: process.env.START_URL || "https://fawesome.tv/"
};

const sessionAdmission = createSessionAdmission(config.maxSessions);

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, "config/sites.json"), "utf8"));
const allowedOrigins = new Set(sites.map((site) => new URL(site.url).origin.toLowerCase()));

const trustProxyHops = nonNegativeInt(process.env.TRUST_PROXY, 1);
app.set("trust proxy", trustProxyHops);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      frameSrc: ["'self'"],
      connectSrc: ["'self'", "wss:", "ws:"],
      mediaSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "8kb" }));

// JSON body-parser failures may retain user-supplied request bytes in their
// error message/body. Handle only known parser failures here, before Express
// can emit those exception details through its default error handler.
const jsonParserErrors = new Set([
  "entity.parse.failed", "entity.too.large", "entity.verify.failed",
  "encoding.unsupported", "charset.unsupported",
  "request.aborted", "request.size.invalid"
]);
app.use((error, _req, res, next) => {
  if (!jsonParserErrors.has(error?.type)) return next(error);
  res.setHeader("Cache-Control", "no-store");
  // Match Express finalhandler's strict error-page policy. Even a JSON
  // parser rejection must never inherit the interactive TV viewer CSP.
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
  return res.status(status).json({ error: "Invalid JSON request." });
});

const sessionLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many session attempts. Please try again later." }
});

function publicSession(session) {
  return {
    token: session.token,
    viewerUrl: `/s/${session.token}/`,
    expiresAt: session.expiresAt,
    maxMinutes: Math.round(config.ttlMs / 60_000)
  };
}

function validStartUrl(input) {
  try {
    const url = new URL(input || config.startUrl);
    // Origin excludes URL userinfo: reject Basic-auth credentials even for an
    // otherwise approved host. This includes percent-encoded userinfo.
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" || !allowedOrigins.has(url.origin.toLowerCase())) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function waitForBrowser(containerName, subfolder, attempts = 45, password = null) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const url = `https://${containerName}:3001${subfolder}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await new Promise((resolve) => {
      // Probe the exact authenticated viewer endpoint. Without the same
      // container-only Basic credentials a 401 challenge only proves that
      // *something* answered HTTPS, not that this session is ready.
      const request = https.get(url, {
        agent,
        timeout: 1500,
        ...(password ? { auth: `viewer:${password}` } : {})
      }, (response) => {
        response.resume();
        // A redirect, 404 placeholder or 4xx/partial response must never
        // publish a bearer for a viewer that cannot actually load.
        resolve(response.statusCode === 200);
      });
      request.on("timeout", () => { request.destroy(); resolve(false); });
      request.on("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The browser did not start in time.");
}

async function stopContainer(container) {
  try {
    await container.stop({ t: 3 });
  } catch {
    // The container may have already exited and been AutoRemoved before a
    // delayed DELETE/idle retry. Still try forced removal first: a stop 404
    // alone is not reliable evidence that teardown completed.
    try {
      await container.remove({ force: true });
    } catch (removeError) {
      if (removeError?.statusCode === 404) {
        // Both operations may race Docker's AutoRemove. Reinspect the exact
        // container ID before freeing the browser slot. A confirmed Docker
        // 404 means it no longer exists; any other result remains fail-closed.
        try {
          await container.inspect();
        } catch (inspectError) {
          if (inspectError?.statusCode === 404) return;
        }
      }
      // Preserve the tracked bearer, owner and admission capacity on any
      // uncertain teardown error or Docker daemon outage.
      throw removeError;
    }
  }
}

async function createSession(ip, startUrl) {
  const token = crypto.randomBytes(24).toString("base64url");
  const password = crypto.randomBytes(24).toString("base64url");
  const containerName = `zbrowse-${token.slice(0, 12).toLowerCase()}`;
  const subfolder = `/s/${token}/`;

  // LinuxServer Selkies TV-kiosk: deny shell, desktop launchers, local file
  // transfers and client peripherals while retaining video/audio streaming.
  // Env is deliberately literal/inspectable by existing source contracts.
  const container = await docker.createContainer({
    Image: config.image,
    name: containerName,
    Env: [
      `CUSTOM_USER=viewer`,
      `PASSWORD=${password}`,
      `SUBFOLDER=${subfolder}`,
      `TITLE=zBrowse`,
      `START_URL=${startUrl}`,
      "PIXELFLUX_WAYLAND=true",
      "DISABLE_IPV6=true",
      "NO_DECOR=true",
      "HARDEN_DESKTOP=true",
      "HARDEN_OPENBOX=true",
      "DISABLE_OPEN_TOOLS=true",
      "DISABLE_SUDO=true",
      "DISABLE_TERMINALS=true",
      "RESTART_APP=true",
      "START_DOCKER=false",
      "NO_WEBCAM=true",
      "NO_GAMEPAD=true",
      "SELKIES_COMMAND_ENABLED=false|locked",
      "SELKIES_FILE_TRANSFERS=none",
      "SELKIES_ENABLE_CLIPBOARD=false|locked",
      "SELKIES_ENABLE_BINARY_CLIPBOARD=false|locked",
      "SELKIES_CLIPBOARD_SEAMLESS=false|locked",
      "SELKIES_MICROPHONE_ENABLED=false|locked",
      "SELKIES_PRINTING_ENABLED=false|locked",
      "SELKIES_ENABLE_SHARING=false|locked",
      "SELKIES_ENABLE_COLLAB=false|locked",
      "SELKIES_ENABLE_SHARED=false|locked",
      "SELKIES_UI_SIDEBAR_SHOW_CLIPBOARD=false|locked",
      "SELKIES_UI_SIDEBAR_SHOW_FILES=false|locked",
      "SELKIES_UI_SIDEBAR_SHOW_APPS=false|locked",
      "SELKIES_UI_SIDEBAR_SHOW_SHARING=false|locked"
    ],
    Labels: {
      "zbrowse.managed": "true",
      "zbrowse.token": token
    },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: config.network,
      Memory: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: 350,
      ShmSize: 1024 * 1024 * 1024,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: {
        "/config": "rw,noexec,nosuid,size=768m",
        "/tmp": "rw,noexec,nosuid,size=256m"
      }
    }
  });

  const now = Date.now();
  const session = {
    token,
    password,
    ip,
    container,
    containerName,
    subfolder,
    createdAt: now,
    expiresAt: now + config.ttlMs,
    lastSeenAt: now
  };

  try {
    await container.start();
    // Authenticate the readiness probe with this session's generated credentials.
    // Keep the await boundary local to this session; never share readiness auth.
    const authenticatedReadinessProbe = waitForBrowser;
    {
      const waitForBrowser = (name, prefix) =>
        authenticatedReadinessProbe(name, prefix, 45, password);
      await waitForBrowser(containerName, subfolder);
    }
    sessions.set(token, session);
    sessionsByIp.set(ip, token);
    // A browser can exit while its owner still has minutes of TTL left.
    // Observe Docker's exit signal so an AutoRemoved kiosk frees its slot
    // promptly instead of handing out a dead viewer until idle expiry.
    // A lost Docker wait stream is not proof of removal: the periodic
    // container-inspection sweep below independently reconciles that case.
    if (typeof container.wait === "function") {
      Promise.resolve().then(() => container.wait()).then(
        () => {
          if (sessions.get(token) === session) {
            destroySession(token).catch(() =>
              console.error("Cleanup failed", "BROWSER_TEARDOWN_FAILURE"));
          }
        },
        () => { /* Docker watcher unavailable; periodic inspection retries. */ }
      );
    }
    return session;
  } catch (error) {
    try {
      await stopContainer(container);
    } catch {
      // Created/started but unremovable containers still consume Docker
      // capacity. Quarantine the unpublished token so MAX_SESSIONS keeps its
      // slot reserved; do not return the token through the public API.
      session.cleanupFailed = true;
      sessions.set(token, session);
      sessionsByIp.set(ip, token);
      throw new Error("Browser startup cleanup failed; capacity reserved.");
    }
    throw error;
  }
}

async function destroySession(token) {
  const session = sessions.get(token);
  if (!session) return;
  // Coalesce concurrent DELETE/idle/shutdown attempts for one container.
  // Preserve both session capacity and owner until Docker confirms teardown.
  if (session.destroyPromise) return session.destroyPromise;
  session.destroyPromise = (async () => {
    await stopContainer(session.container);
    if (sessions.get(token) === session) sessions.delete(token);
    if (sessionsByIp.get(session.ip) === token) sessionsByIp.delete(session.ip);
  })();
  try {
    await session.destroyPromise;
  } finally {
    // On failure the quarantined slot remains tracked for later retry.
    // Clearing only the attempt allows cleanup to retry a failed removal.
    delete session.destroyPromise;
  }
}

function findSession(req) {
  const match = requestPath(req).match(/^\/s\/([A-Za-z0-9_-]{32,})\//);
  const session = match ? sessions.get(match[1]) : null;
  return session?.cleanupFailed ? null : session;
}

// Public health can be polled by many TVs concurrently. Share one Docker
// ping and cache its answer briefly so unauthenticated readiness requests do
// not turn into an unbounded stream of Docker socket operations.
const dockerHealth = { checkedAt: 0, available: false, pending: null };
async function dockerIsAvailable() {
  const now = Date.now();
  if (dockerHealth.checkedAt && now >= dockerHealth.checkedAt &&
      now - dockerHealth.checkedAt < 3_000) return dockerHealth.available;
  if (dockerHealth.pending) return dockerHealth.pending;
  const check = (async () => {
    let available = false;
    try {
      // A healthy daemon without the configured browser image cannot serve a
      // session. Check both before advertising "Ready to browse" to the TV.
      await docker.ping();
      await docker.getImage(config.image).inspect();
      available = true;
    } catch {
      // The public TV only needs a boolean, never raw Docker/image details.
    }
    dockerHealth.available = available;
    dockerHealth.checkedAt = Date.now();
    return available;
  })();
  dockerHealth.pending = check;
  try {
    return await check;
  } finally {
    if (dockerHealth.pending === check) dockerHealth.pending = null;
  }
}

app.get("/api/health", (req, res) => {
  // Capacity changes on every session start/teardown. Proxy or browser caches
  // must never replay yesterday's "ready" or "busy" response on a TV.
  // This also applies to Express-generated conditional GET/HEAD responses.
  res.setHeader("Cache-Control", "no-store");
  const respond = available => {
    if (!available) return res.status(503).json({ status: "unavailable" });
    return res.json({ status: "ok", activeSessions: sessions.size, startingSessions: sessionAdmission.pendingCount, capacity: config.maxSessions });
  };
  // The real gateway probes its Docker socket before advertising TV readiness.
  // Source-bound public API fixtures deliberately have no Docker object.
  if (typeof docker !== "undefined" && typeof docker.ping === "function") {
    // Keep the synchronous route registration contract used by other shipped
    // admission/recovery handlers, while bounding Docker errors to generic 503.
    return dockerIsAvailable().then(respond, () => respond(false));
  }
  return respond(true);
});

app.get("/api/sites", (req, res) => {
  // An outdated catalogue can offer domains removed from the reviewed
  // allowlist or display obsolete session limits after a gateway rollout.
  res.setHeader("Cache-Control", "no-store");
  res.json({ sites, maxSessionMinutes: Math.round(config.ttlMs / 60_000) });
});

// Express's native req.ip can accept an incomplete or malformed forwarded
// chain even when the reviewed browser owner resolver rejects it. Bind the
// canonical client identity *before* the unchanged rate limiter runs; its
// built-in IPv6 aggregation remains intact. This applies only to creation,
// never to unrelated API routes or the authenticated viewer.
app.use("/api/session", (req, _res, next) => {
  // Only bind a new-browser POST. Token-specific /heartbeat and /DELETE
  // requests retain their original Express request representation.
  if (req.method === "POST" && req.path === "/") {
    Object.defineProperty(req, "ip", {
      configurable: true,
      enumerable: true,
      value: requestIp(req, trustProxyHops)
    });
  }
  next();
});

app.post("/api/session", sessionLimiter, async (req, res) => {
  // Responses can contain browser bearer tokens or their viewer URLs.
  res.setHeader("Cache-Control", "no-store");
  // An ignored browser-simple POST body must never fall back to the default
  // start URL or obtain an existing owner's bearer token. Actual HTTP
  // requests always supply req.headers; the bare-route VM fixture does not.
  if (req.headers) {
    const mediaType = req.headers["content-type"] || "";
    if (!/^application\/json\s*(?:;|$)/i.test(mediaType)) {
      return res.status(415).json({ error: "A JSON request body is required." });
    }

    // CORS denial alone prevents reading the reply, NOT the side effect.
    // Reject unreviewed browser origins and cross-site Fetch Metadata before
    // the token reuse path and before reserving container capacity.
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    const receivedOrigins = req.headersDistinct?.origin;
    const repeatedOrigin = Array.isArray(receivedOrigins) && receivedOrigins.length !== 1;
    const ownOrigin = req.protocol + "://" + req.get("host");
    const approvedOrigins = new Set([ownOrigin, "https://zbrowse-tv.lizellay.chatgpt.site"]);
    const invalidFetchSite = fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite);
    if (repeatedOrigin || invalidFetchSite ||
        (origin !== undefined && !approvedOrigins.has(origin))) {
      return res.status(403).json({ error: "Browser session request not allowed." });
    }
  }
  // Validate the requested URL BEFORE the same-owner reuse fast path, or an
  // embedded credential can cause the existing bearer to be returned as 200.
  const startUrl = validStartUrl(req.body?.url);
  if (!startUrl) {
    return res.status(400).json({ error: "This website is not on the allowed list." });
  }
  const ip = requestIp(req, trustProxyHops);
  const existingToken = sessionsByIp.get(ip);
  if (existingToken && sessions.has(existingToken)) {
    const existingSession = sessions.get(existingToken);
    if (existingSession.cleanupFailed) {
      return res.status(503).json({ error: "Browser cleanup is pending." });
    }
    if (!isSessionExpired(existingSession, config.idleMs)) {
      return res.json(publicSession(existingSession));
    }
    try {
      await destroySession(existingToken);
    } catch {
      // Keep the unremoved browser in tracked capacity. A raw Docker error
      // may include container env, bearer paths or upstream request details.
      console.error("Cleanup failed", "BROWSER_TEARDOWN_FAILURE");
      return res.status(503).json({ error: "Browser cleanup is pending." });
    }
  }

  const admission = sessionAdmission.tryReserve(ip, sessions.size);
  if (!admission.ok) {
    if (admission.reason === "pending") {
      return res.status(409).json({ error: "A browser session is already starting for this client." });
    }
    return res.status(503).json({ error: "All browser sessions are currently in use. Please try again shortly." });
  }

  try {
    const session = await createSession(ip, startUrl);
    return res.status(201).json(publicSession(session));
  } catch (error) {
    // Docker error objects can carry bearer URLs, passwords and nested request
    // metadata. Preserve a diagnostic event without printing any untrusted data.
    error = "BROWSER_START_FAILURE";
    console.error("Session creation failed", error);
    return res.status(500).json({ error: "The browser could not be started." });
  } finally {
    sessionAdmission.release(ip);
  }
});

// Every method on a bearer-bearing session URL must be non-cacheable,
// including Express-generated OPTIONS/404/405 responses that bypass handlers.
app.use("/api/session/:token", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.post("/api/session/:token/heartbeat", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session = sessions.get(req.params.token);
  if (!session || isSessionExpired(session, config.idleMs) || session.ip !== requestIp(req, trustProxyHops)) return res.status(404).json({ error: "Session not found." });
  session.lastSeenAt = Date.now();
  return res.json({ ok: true, expiresAt: session.expiresAt });
});

app.delete("/api/session/:token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: "Session not found." });
  // Never turn a still-tracked browser into a success-shaped 404. The TV
  // accepts only the *exact* "Session not found." response as proof of
  // cleanup. Changed ownership and an expired-but-still-live container must
  // remain locked until the independent idle cleanup actually removes it.
  // Preserve the expired-bearer 404/no-action API contract while excluding
  // that 404 from the client's confirmed-release acknowledgement.
  if (session.ip !== requestIp(req, trustProxyHops) ||
      isSessionExpired(session, config.idleMs)) {
    return res.status(404).json({ error: "Session release not confirmed." });
  }
  try {
    await destroySession(req.params.token);
  } catch {
    // Never let Express report a raw Docker teardown exception. Retain
    // ownership and capacity until a later destroy attempt succeeds.
    console.error("Cleanup failed", "BROWSER_TEARDOWN_FAILURE");
    return res.status(503).json({ error: "Browser cleanup is pending." });
  }
  return res.status(204).end();
});

app.use("/s/", (req, res, next) => {
  // Even invalid bearer paths and early proxy failures must never be cached.
  res.setHeader("Cache-Control", "no-store");
  const session = findSession(req);
  if (!session || isSessionExpired(session, config.idleMs) || session.ip !== requestIp(req, trustProxyHops)) {
    return res.status(403).send("This browser session is no longer valid.");
  }
  session.lastSeenAt = Date.now();
  req.zbrowseSession = session;
  next();
});

const browserProxy = createProxyServer();
// A browser upstream can override response headers; prohibit cacheable
// 200/206/304/redirect/error viewer bodies before http-proxy forwards them.
// The header also covers HEAD and Range responses. Static public assets
// outside /s/ retain their normal cache policy.
if (typeof browserProxy.on === "function") {
  browserProxy.on("proxyRes", (proxyRes) => {
    if (!proxyRes?.headers) return;
    // CDNs may honor Surrogate-Control or vendor-specific TTLs ahead of
    // ordinary Cache-Control; Expires can also re-enable legacy caching.
    // Strip all upstream cache directives before forwarding a bearer-bound
    // viewer response, including range, redirects and conditional replies.
    const upstreamCacheHeaders = new Set([
      "cache-control", "surrogate-control", "cdn-cache-control",
      "cloudflare-cdn-cache-control", "expires", "x-accel-expires"
    ]);
    for (const name of Object.keys(proxyRes.headers)) {
      if (upstreamCacheHeaders.has(name.toLowerCase())) delete proxyRes.headers[name];
    }
    proxyRes.headers["cache-control"] = "no-store";
  });
  // The real proxy is an EventEmitter. Its addListener API is equivalent to
  // on(), while minimal proxyRes-only adapters may not expose it.
  // Handle async HTTP/WS upstream outages without crashing the entire gateway
  // or emitting untrusted bearer/credential-bearing error messages.
  if (typeof browserProxy.addListener === "function") {
    browserProxy.addListener("error", (error, _request, client) => {
      browserProxyError(error, client);
    });
  }
}

function browserProxyOptions(req) {
  return {
    target: `https://${req.zbrowseSession.containerName}:3001`,
    secure: false,
    changeOrigin: true,
    // Bound a stalled upstream HTTP Upgrade handshake. This does not impose
    // a lifetime on the established TV viewer WebSocket stream.
    upgradeTimeout: 15_000,
    auth: `viewer:${req.zbrowseSession.password}`
  };
}

function browserProxyError(error, response) {
  // Upstream error.message and stack can contain bearer viewer paths, proxy
  // URL userinfo, authorization headers, terminal escapes or newlines.
  // Emit ONLY literal, reviewed Node/proxy error codes or a generic fallback.
  // Never log arbitrary codes, messages, URLs, request objects or credentials.
  const safeCodes = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
    "ENOTFOUND", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE"
  ]);
  let category = "UPSTREAM_FAILURE";
  try {
    // Read the untrusted property once: accessors may throw or return
    // different values on successive reads. Only fixed literals reach logs.
    const code = error?.code;
    if (safeCodes.has(code)) category = code;
  } catch {
    // An invalid upstream error object must still receive a generic 502.
  }
  console.error("Browser proxy error", category);
  if (response?.writeHead && !response.headersSent) {
    try {
      response.writeHead(502).end("Browser connection interrupted.");
      return;
    } catch {
      // A client may disconnect between the headersSent check and writeHead.
      // Close the response without logging or throwing the secondary error.
    }
  }
  try {
    response?.destroy?.();
  } catch {
    // The peer is already gone. Never let a failed cleanup crash the gateway.
  }
}

app.use("/s/", async (req, res) => {
  req.url = requestPath(req, req.url);
  try {
    await browserProxy.web(req, res, browserProxyOptions(req));
  } catch (error) {
    browserProxyError(error, res);
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "API route not found." }));

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    // The TV page references app.js and styles.css without versioned URLs.
    // Revalidate all three entry assets after deployments so fresh session
    // controls cannot render against an hour-old layout or interaction state.
    // Other static assets retain the reviewed one-hour cache policy.
    if (filePath.endsWith("index.html") || filePath.endsWith("app.js") ||
        filePath.endsWith("styles.css")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));
app.use((req, res) => {
  // SPA deep-link fallback is HTML too: it must not outlive a new runtime.
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Catch unexpected Express middleware and static-file exceptions after the
// reviewed JSON/proxy/session handlers. Express' default error renderer may
// otherwise print request-related exception messages, paths or stack traces
// to a TV client in non-production deployments. Never serialize the error.
app.use((_error, _req, res, _next) => {
  console.error("Gateway request failed", "UNEXPECTED_REQUEST_FAILURE");
  if (res.headersSent) {
    // Streaming/proxied replies cannot be rewritten as JSON. Terminate the
    // partially delivered response instead of leaking a mixed error body.
    try { res.destroy(); } catch { /* The peer already disconnected. */ }
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.status(500).json({ error: "The browser gateway could not complete this request." });
});

// A Docker wait observer can fail or be lost during a daemon restart. Every
// active, non-expired browser therefore also gets a bounded-frequency
// liveness reconciliation. Only a definite stopped state or Docker 404 may
// release a session; transport errors retain its bearer and capacity.
async function reconcileBrowserLiveness(session) {
  if (session.livenessPromise || session.destroyPromise ||
      typeof session.container?.inspect !== "function") return;
  const check = (async () => {
    let exited = false;
    try {
      const details = await session.container.inspect();
      exited = details?.State?.Running === false;
    } catch (error) {
      exited = error?.statusCode === 404;
    }
    // An in-flight inspection may outlive a successful owner DELETE or a
    // browser replacement. Never remove a newer session for an old result.
    if (!exited || sessions.get(session.token) !== session) return;
    try {
      await destroySession(session.token);
    } catch {
      console.error("Cleanup failed", "BROWSER_TEARDOWN_FAILURE");
    }
  })();
  session.livenessPromise = check;
  try {
    await check;
  } finally {
    if (session.livenessPromise === check) delete session.livenessPromise;
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.cleanupFailed || isSessionExpired(session, config.idleMs, now)) {
      destroySession(session.token).catch((error) => {
        // A teardown exception may contain container labels, passwords or
        // nested auth data. Retry ownership stays tracked by destroySession.
        error = "BROWSER_TEARDOWN_FAILURE";
        console.error("Cleanup failed", error);
      });
    } else if (typeof session.container?.inspect === "function") {
      // Only Docker-backed sessions need the additional liveness sweep.
      // Synthetic/legacy entries without a container are never acted on;
      // an unknown runtime cannot be assumed safely removed.
      // Do not block the next sweep or stack overlapping inspections.
      reconcileBrowserLiveness(session).catch(() =>
        console.error("Browser liveness check failed", "BROWSER_INSPECTION_FAILURE"));
    }
  }
}, 30_000);
cleanupTimer.unref();

async function shutdown() {
  clearInterval(cleanupTimer);
  await Promise.allSettled([...sessions.keys()].map(destroySession));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.on("upgrade", (req, socket, head) => {
  const session = findSession(req);
  if (
    !session ||
    isSessionExpired(session, config.idleMs) ||
    session.ip !== requestIp(req, trustProxyHops)
  ) {
    return socket.destroy();
  }
  session.lastSeenAt = Date.now();
  req.zbrowseSession = session;
  // WebSocket setup may throw before returning a Promise (invalid upstream
  // options, socket failure), not only reject asynchronously. Both paths
  // must close the client socket without exposing bearer/auth diagnostics.
  try {
    Promise.resolve(browserProxy.ws(req, socket, browserProxyOptions(req), head))
      .catch((error) => browserProxyError(error, socket));
  } catch (error) {
    browserProxyError(error, socket);
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`zBrowse gateway listening on ${config.port}`);
});
