import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";

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
  nanoCpus: Math.max(0.25, Number(process.env.BROWSER_CPU || 1)) * 1e9,
  image: process.env.BROWSER_IMAGE || "zbrowse-browser:1.0.0",
  network: process.env.BROWSER_NETWORK || "zbrowse_net",
  startUrl: process.env.START_URL || "https://fawesome.tv/"
};

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, "config/sites.json"), "utf8"));
const allowedHosts = new Set(sites.map((site) => new URL(site.url).hostname.toLowerCase()));

app.set("trust proxy", positiveInt(process.env.TRUST_PROXY, 1));
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

const sessionLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many session attempts. Please try again later." }
});

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function waitForBrowser(containerName, subfolder, attempts = 45) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const url = `https://${containerName}:3001${subfolder}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await new Promise((resolve) => {
      const request = https.get(url, { agent, timeout: 1500 }, (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 500);
      });
      request.on("timeout", () => { request.destroy(); resolve(false); });
      request.on("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The browser did not start in time.");
}

async function createSession(ip, startUrl) {
  const token = crypto.randomBytes(24).toString("base64url");
  const password = crypto.randomBytes(24).toString("base64url");
  const containerName = `zbrowse-${token.slice(0, 12).toLowerCase()}`;
  const subfolder = `/s/${token}/`;

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
      "SELKIES_ENABLE_FILE_TRANSFER=false",
      "SELKIES_ENABLE_CLIPBOARD=false"
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

  sessions.set(token, session);
  sessionsByIp.set(ip, token);
  try {
    await container.start();
    await waitForBrowser(containerName, subfolder);
    return session;
  } catch (error) {
    await destroySession(token);
    throw error;
  }
}

async function destroySession(token) {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  if (sessionsByIp.get(session.ip) === token) sessionsByIp.delete(session.ip);
  try {
    await session.container.stop({ t: 3 });
  } catch {
    try { await session.container.remove({ force: true }); } catch {}
  }
}

function findSession(req) {
  const requestUrl = req.originalUrl || req.url || "";
  const match = requestUrl.match(/^\/s\/([A-Za-z0-9_-]{32,})\//);
  return match ? sessions.get(match[1]) : null;
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", activeSessions: sessions.size, capacity: config.maxSessions });
});

app.get("/api/sites", (req, res) => {
  res.json({ sites, maxSessionMinutes: Math.round(config.ttlMs / 60_000) });
});

app.post("/api/session", sessionLimiter, async (req, res) => {
  const ip = req.ip;
  const existingToken = sessionsByIp.get(ip);
  if (existingToken && sessions.has(existingToken)) {
    return res.json(publicSession(sessions.get(existingToken)));
  }
  if (sessions.size >= config.maxSessions) {
    return res.status(503).json({ error: "All browser sessions are currently in use. Please try again shortly." });
  }
  const startUrl = validStartUrl(req.body?.url);
  if (!startUrl) {
    return res.status(400).json({ error: "This website is not on the allowed list." });
  }
  try {
    const session = await createSession(ip, startUrl);
    return res.status(201).json(publicSession(session));
  } catch (error) {
    console.error("Session creation failed", error);
    return res.status(500).json({ error: "The browser could not be started." });
  }
});

app.post("/api/session/:token/heartbeat", (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session || session.ip !== req.ip) return res.status(404).json({ error: "Session not found." });
  session.lastSeenAt = Date.now();
  return res.json({ ok: true, expiresAt: session.expiresAt });
});

app.delete("/api/session/:token", async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session || session.ip !== req.ip) return res.status(404).json({ error: "Session not found." });
  await destroySession(req.params.token);
  return res.status(204).end();
});

app.use("/s/", (req, res, next) => {
  const session = findSession(req);
  if (!session || session.expiresAt < Date.now() || session.ip !== req.ip) {
    return res.status(403).send("This browser session is no longer valid.");
  }
  session.lastSeenAt = Date.now();
  req.zbrowseSession = session;
  next();
});

const browserProxy = createProxyMiddleware({
  ws: true,
  secure: false,
  changeOrigin: true,
  router: (req) => `https://${req.zbrowseSession.containerName}:3001`,
  pathRewrite: (pathValue, req) => req.originalUrl,
  on: {
    proxyReq: (proxyReq, req) => {
      const value = Buffer.from(`viewer:${req.zbrowseSession.password}`).toString("base64");
      proxyReq.setHeader("authorization", `Basic ${value}`);
    },
    proxyReqWs: (proxyReq, req) => {
      const value = Buffer.from(`viewer:${req.zbrowseSession.password}`).toString("base64");
      proxyReq.setHeader("authorization", `Basic ${value}`);
    },
    error: (error, req, res) => {
      console.error("Browser proxy error", error.message);
      if (res.writeHead) res.writeHead(502).end("Browser connection interrupted.");
    }
  }
});
app.use("/s/", browserProxy);

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
  }
}));
app.use((req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.expiresAt <= now || session.lastSeenAt + config.idleMs <= now) {
      destroySession(session.token).catch((error) => console.error("Cleanup failed", error));
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
  if (!session || session.expiresAt < Date.now()) return socket.destroy();
  req.zbrowseSession = session;
  browserProxy.upgrade(req, socket, head);
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`zBrowse gateway listening on ${config.port}`);
});
