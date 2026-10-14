"use strict";

const state = {
  sites: [],
  session: null,
  heartbeat: null,
  countdown: null
};

const $ = (id) => document.getElementById(id);
const homeView = $("homeView");
const browserView = $("browserView");
const form = $("browserForm");
const urlInput = $("urlInput");
const startButton = $("startButton");
const message = $("formMessage");

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  // The gateway confirms a completed browser teardown with 204 No Content.
  // A proxy-generated 200/202/206 is not evidence of Docker cleanup, even
  // when its body looks successful. Keep the old token locked for retry.
  if (options.method === "DELETE" && response.ok && response.status !== 204) {
    throw new Error("Unexpected session release status.");
  }
  // These are read-only gateway routes with a 200 JSON contract. A proxy
  // returning 202/203/205/206 must not advertise readiness or populate a
  // trusted site catalogue from a status it cannot authoritatively confirm.
  if ((url === "/api/health" || url === "/api/sites") &&
      response.ok && response.status !== 200) {
    throw new Error("Unexpected gateway read status.");
  }
  if (response.status === 204) return null;
  // Successful lease renewal must be an actual gateway JSON response,
  // not an HTML/plain-text proxy response that happens to parse as JSON.
  // Other API results have their own schema and cleanup validation.
  if (response.ok && url.endsWith("/heartbeat")) {
    // The Express gateway only acknowledges a renewed lease with HTTP 200.
    // A proxy-generated 202 Accepted, 203 Non-Authoritative Information or
    // 206 Partial Content is not confirmation, even with plausible JSON.
    if (response.status !== 200) {
      throw new Error("Unexpected heartbeat status.");
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new Error("Invalid heartbeat response format.");
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Something went wrong.");
    error.status = response.status;
    // A proxy/router HTML 404 (or an arbitrary 410) does not prove that a
    // browser container was destroyed. Only the gateway's documented JSON
    // not-found contract may clear an uncertain session release.
    // A proxy may serve a lookalike JSON body as plain text or HTML.
    // Only the gateway's declared JSON response is a trustworthy
    // application-level not-found acknowledgement.
    const contentType = response.headers?.get?.("content-type") || "";
    const gatewayJson = /^application\/json(?:\s*;|$)/i.test(contentType);
    error.confirmedSessionGone = gatewayJson && (
      (response.status === 404 && body?.error === "Session not found.") ||
      (response.status === 410 && body?.error === "Session expired.")
    );
    throw error;
  }
  if (url === "/api/session") {
    // A gateway browser start mints a bearer. Only 201 Created (new
    // browser) and 200 OK (documented same-owner reuse) are valid. A proxy's
    // 202/203/205/206 or mislabeled JSON must not mount a bearer iframe.
    // Preserve a syntactically valid token for the existing fail-closed
    // checkedSessionPayload() -> idempotent DELETE recovery path.
    const contentType = response.headers?.get?.("content-type") || "";
    const acceptedStatus = response.status === 200 || response.status === 201;
    if (!acceptedStatus || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return body && typeof body === "object"
        ? { ...body, viewerUrl: null } : {};
    }
  }
  return body;
}

function setMessage(text = "") {
  message.textContent = text;
}

// Error JSON from a reverse proxy is not presentation-safe: it can echo a
// bearer viewer route, URL credentials or other upstream implementation data.
// Map only the HTTP status to reviewed, short TV-facing guidance.
function safeStartFailure(error) {
  switch (error?.status) {
    case 400:
    case 403: return "Browser start rejected.";
    case 409: return "Browser currently in use. Try again shortly.";
    case 429: return "Too many browser requests. Try again later.";
    case 503: return "Browser engine unavailable. Try again shortly.";
    default:
      // Locally generated validation errors are not network error bodies.
      if (error?.status === undefined &&
          error?.message === "Invalid browser session response.") {
        return "Invalid browser session response.";
      }
      return "Could not start browser. Try again.";
  }
}

function renderSuggestions() {
  const datalist = $("siteSuggestions");
  datalist.replaceChildren(...state.sites.map((site) => {
    const option = document.createElement("option");
    option.value = site.url;
    option.label = site.name;
    return option;
  }));
}

let healthRequestSequence = 0;
let gatewayCanStart = false;
let siteCatalogueReady = false;
let siteCatalogueRequest = null;

function syncStartButton() {
  // Capacity may be busy yet reusable for this client; only invalid, offline
  // or draining gateway state must prevent an avoidable start POST.
  startButton.disabled = sessionStarting || sessionEnding || !gatewayCanStart || !siteCatalogueReady;
}

async function ensureSiteCatalogue() {
  if (siteCatalogueReady) return true;
  // A slow /api/sites reply can overlap multiple health ticks and BFCache
  // restores. Share one in-flight operation to preserve reviewed results.
  if (siteCatalogueRequest) return siteCatalogueRequest;
  const attempt = (async () => {
    try {
      const data = await request("/api/sites", { cache: "no-store", signal: AbortSignal.timeout(7000) });
      if (!reviewedSiteCatalogue(data)) throw new Error("Invalid site catalogue");
      state.sites = data.sites;
      renderSuggestions();
      if (!urlInput.value.trim()) urlInput.value = state.sites[0].url;
      siteCatalogueReady = true;
      setMessage();
      return true;
    } catch {
      siteCatalogueReady = false;
      state.sites = [];
      renderSuggestions();
      setMessage("Site catalogue unavailable. Reload to retry.");
      return false;
    } finally {
      syncStartButton();
    }
  })();
  siteCatalogueRequest = attempt;
  try {
    return await attempt;
  } finally {
    if (siteCatalogueRequest === attempt) siteCatalogueRequest = null;
  }
}

async function refreshHealth(retryPendingRelease = true) {
  // A temporarily missing catalogue can recover during the regular health
  // cycle; TV users should not need to reload the kiosk to unlock Open.
  if (!siteCatalogueReady) await ensureSiteCatalogue();
  // A failed DELETE must not become a second same-IP POST that reuses the
  // supposedly ended browser. Retry its release on the regular health poll.
  if (retryPendingRelease && pendingReleaseToken) {
    await releasePendingSession();
  }
  const sequence = ++healthRequestSequence;
  const status = $("capacityText").parentElement;
  try {
    // Readiness controls session admission, so do not reuse a previous 200
    // from the browser HTTP cache even if a proxy misconfigures max-age.
    // Server/CDN no-store remains an independent requirement (#293).
    const health = await request("/api/health", { cache: "no-store", signal: AbortSignal.timeout(7000) });
    // A slower earlier poll cannot overwrite a newer capacity observation.
    if (sequence !== healthRequestSequence) return;
    // A gateway in shutdown/drain mode must never be shown as available,
    // even if no browser containers are currently running.
    if (health?.status === "draining") {
      gatewayCanStart = false;
      syncStartButton();
      status.className = "status";
      $("capacityText").textContent = "Browser temporarily unavailable";
      return;
    }
    // Fail closed on malformed or untrusted capacity information. JS numeric
    // coercion ("0" + 0) and absent status fields can otherwise claim Ready
    // for an unhealthy or inconsistent gateway.
    if (
      health?.status !== "ok" ||
      !Number.isSafeInteger(health.activeSessions) ||
      !Number.isSafeInteger(health.startingSessions) ||
      !Number.isSafeInteger(health.capacity) ||
      health.activeSessions < 0 ||
      health.startingSessions < 0 ||
      health.capacity < 1 ||
      health.startingSessions > health.capacity ||
      health.activeSessions > health.capacity - health.startingSessions
    ) {
      throw new Error("Invalid gateway health response.");
    }
    gatewayCanStart = true;
    syncStartButton();
    if (!siteCatalogueReady) {
      status.className = "status";
      $("capacityText").textContent = "Site catalogue unavailable";
      return;
    }
    if (pendingReleaseToken) {
      status.className = "status";
      $("capacityText").textContent = "Finishing previous browser session";
      return;
    }
    const available = health.activeSessions + health.startingSessions < health.capacity;
    status.className = "status " + (available ? "available" : "busy");
    $("capacityText").textContent = available ? "Ready to browse" : "Browser currently in use";
  } catch {
    if (sequence !== healthRequestSequence) return;
    gatewayCanStart = false;
    syncStartButton();
    status.className = "status";
    $("capacityText").textContent = "Browser engine offline";
  }
}

function checkedSessionPayload(payload) {
  // Only mount the exact same-origin viewer route minted by this gateway.
  // The gateway creates a 24-byte random base64url token (32 characters).
  const token = payload?.token;
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/.test(token) ||
    payload.viewerUrl !== "/s/" + token + "/" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= 0 ||
    !Number.isSafeInteger(payload.maxMinutes) ||
    payload.maxMinutes < 1
  ) {
    throw new Error("Invalid browser session response.");
  }
  return payload;
}

let sessionStarting = false;
let sessionEnding = false;
let pendingReleaseToken = null;
let releaseAttemptInFlight = false;
let pageExitGeneration = 0;
let pageActive = true;

async function startSession(url) {
  // A disabled button does not prevent a second form submit or scripted event.
  // Never allocate two gateway sessions for the same portal while one is starting.
  if (sessionStarting || sessionEnding || state.session || !gatewayCanStart || !siteCatalogueReady) return;
  const requestGeneration = pageExitGeneration;
  sessionStarting = true;
  setMessage();
  syncStartButton();
  startButton.textContent = "Starting…";
  try {
    const payload = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    let session;
    try {
      session = checkedSessionPayload(payload);
    } catch (error) {
      // Reject a malformed viewer response *without* abandoning a browser
      // whose valid token was already minted by this same-origin gateway.
      // Only a well-formed bearer token is eligible for an idempotent DELETE;
      // invalid/absent token values never enter the URL.
      if (typeof payload?.token === "string" &&
          /^[A-Za-z0-9_-]{32}$/.test(payload.token)) {
        pendingReleaseToken = payload.token;
        sessionEnding = true;
        syncStartButton();
        $("capacityText").parentElement.className = "status";
        $("capacityText").textContent = "Finishing previous browser session";
        await releasePendingSession();
      }
      throw error;
    }
    // A start may finish after pagehide, when no token existed for the
    // pagehide handler to release. Do not mount a browser on an abandoned
    // page; use keepalive DELETE if the response still arrives.
    if (pageExitGeneration !== requestGeneration) {
      // Navigation may finish before an in-flight POST returns its token.
      // A failed late DELETE must be reconciled just like an ordinary End;
      // otherwise BFCache restoration could start/reuse that still-live token.
      pendingReleaseToken = session.token;
      sessionEnding = true;
      syncStartButton();
      $("capacityText").parentElement.className = "status";
      $("capacityText").textContent = "Finishing previous browser session";
      await releasePendingSession();
      if (pageActive && !pendingReleaseToken) await refreshHealth(false);
      return;
    }
    state.session = session;
    showBrowser();
  } catch (error) {
    if (pageExitGeneration === requestGeneration) {
      setMessage(pendingReleaseToken
        ? "Could not confirm browser shutdown. Retrying automatically."
        : safeStartFailure(error));
      // Do not immediately issue a second DELETE as part of error reporting:
      // failed releases remain locked until the normal health retry.
      await refreshHealth(false);
    }
  } finally {
    sessionStarting = false;
    syncStartButton();
    startButton.textContent = "Open";
  }
}

function showBrowser() {
  const session = state.session;
  // Preflight the gateway's absolute expiry before assigning iframe.src.
  // The previous flow briefly navigated to an already-expired bearer URL
  // and only then called endSession() from the countdown tick.
  if (session.expiresAt <= Date.now()) {
    endSession();
    return;
  }
  homeView.hidden = true;
  browserView.hidden = false;
  $("browserLoading").hidden = false;

  const frame = $("browserFrame");
  frame.src = session.viewerUrl;
  frame.addEventListener("load", () => {
    if (state.session?.token === session.token) {
      $("browserLoading").hidden = true;
    }
  }, { once: true });

  state.heartbeat = window.setInterval(() => {
    request("/api/session/" + session.token + "/heartbeat", {
      method: "POST",
      body: "{}", signal: AbortSignal.timeout(10000)
    }).then((ack) => {
      // HTTP success is not proof of a renewed lease: proxies can return
      // empty 204 responses or malformed/negative JSON while the browser
      // is no longer valid. Require the gateway's explicit acknowledgement.
      if (ack?.ok !== true || !Number.isSafeInteger(ack.expiresAt) ||
          ack.expiresAt <= Date.now()) {
        throw new Error("Invalid heartbeat acknowledgement.");
      }
      // A gateway may shorten a session's permitted lifetime. Keep the
      // original expiry as the upper bound, but immediately enforce a
      // stricter lease instead of displaying time the browser no longer has.
      if (state.session?.token === session.token &&
          ack.expiresAt < session.expiresAt) {
        session.expiresAt = ack.expiresAt;
        updateTimer();
      }
    }).catch(() => {
      if (state.session?.token === session.token) endSession();
    });
  }, 30000);

  state.countdown = window.setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  if (!state.session) return;
  const remaining = Math.max(0, state.session.expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  $("timer").textContent = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  if (remaining <= 0) endSession();
}

async function releasePendingSession() {
  if (!pendingReleaseToken || releaseAttemptInFlight) return false;
  const token = pendingReleaseToken;
  releaseAttemptInFlight = true;
  try {
    await request("/api/session/" + token, {
      method: "DELETE", keepalive: true, signal: AbortSignal.timeout(7000)
    });
    pendingReleaseToken = null;
    sessionEnding = false;
    setMessage();
    return true;
  } catch (error) {
    // Status alone is insufficient: an ingress 404/410 can come from a
    // missing route while the old gateway session is still running.
    // Require the gateway's specific not-found response before unlocking.
    if (error.confirmedSessionGone === true) {
      pendingReleaseToken = null;
      sessionEnding = false;
      setMessage();
      return true;
    }
    setMessage("Could not confirm browser shutdown. Retrying automatically.");
    return false;
  } finally {
    releaseAttemptInFlight = false;
    syncStartButton();
  }
}

async function endSession() {
  if (!state.session || sessionEnding) return;
  // Never unlock a fresh start if the old same-owner browser might still be
  // alive. The next health poll retries an unsuccessful DELETE.
  sessionEnding = true;
  pendingReleaseToken = state.session.token;
  syncStartButton();
  // A previously green health poll is not a teardown acknowledgment.
  // Show a neutral, explicit in-progress state immediately (not just after
  // the next 20-second poll), including for a stalled DELETE.
  $("capacityText").parentElement.className = "status";
  $("capacityText").textContent = "Finishing previous browser session";
  state.session = null;

  // End remains available in fullscreen and must return to a normal document
  // before hiding the viewer and releasing its bearer session.
  if (document.fullscreenElement === browserView) {
    document.exitFullscreen().catch(() => {});
  }
  window.clearInterval(state.heartbeat);
  window.clearInterval(state.countdown);
  state.heartbeat = null;
  state.countdown = null;

  $("browserFrame").src = "about:blank";
  browserView.hidden = true;
  homeView.hidden = false;

  await releasePendingSession();
  await refreshHealth(false);
  urlInput.focus();
}

function isReviewedStartUrl(value) {
  // Mirror the gateway's scheme, credential and reviewed-origin boundary.
  // This is early UX validation, not a replacement for server authorization.
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      state.sites.some((site) => new URL(site.url).origin === url.origin);
  } catch {
    return false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!siteCatalogueReady) {
    setMessage("Site catalogue unavailable. Reload to retry.");
    return;
  }
  const value = urlInput.value.trim();
  if (!value) {
    setMessage("Enter a website URL.");
    urlInput.focus();
    return;
  }
  if (!isReviewedStartUrl(value)) {
    setMessage("Choose an approved HTTPS website without credentials.");
    urlInput.focus();
    return;
  }
  startSession(value);
});

$("endButton").addEventListener("click", endSession);

function syncFullscreenButton() {
  const active = document.fullscreenElement === browserView;
  const button = $("fullscreenButton");
  button.textContent = active ? "Exit fullscreen" : "Fullscreen";
  button.setAttribute("aria-pressed", String(active));
}

document.addEventListener("fullscreenchange", syncFullscreenButton);
syncFullscreenButton();

$("fullscreenButton").addEventListener("click", async () => {
  // Fullscreen the entire viewer, not only the iframe stage: the TV toolbar,
  // its exit control and End session must remain visible and focusable.
  if (!document.fullscreenElement) {
    await browserView.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement === browserView) {
    await document.exitFullscreen().catch(() => {});
  }
  // Some browsers update the fullscreen element before dispatching the
  // fullscreenchange event; reflect the completed action immediately too.
  syncFullscreenButton();
});

window.addEventListener("pagehide", () => {
  pageActive = false;
  pageExitGeneration++;
  const token = state.session?.token || pendingReleaseToken;
  if (token) {
    // The previous release may have failed or remained in-flight. Dispatch a
    // last idempotent keepalive attempt on page exit without granting start.
    request("/api/session/" + token, {
      method: "DELETE",
      keepalive: true
    }).catch(() => {});
  }
});

window.addEventListener("pageshow", (event) => {
  pageActive = true;
  if (!event.persisted) return;
  // A BFCache restore brings back JavaScript and iframe state from before
  // pagehide, but pagehide already attempted to destroy that browser token.
  // Never resurrect a possibly revoked bearer iframe or its heartbeat timer.
  if (state.session) {
    endSession(); // retry DELETE if unload's keepalive send was lost
  } else {
    refreshHealth();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !browserView.hidden && !document.fullscreenElement) {
    $("endButton").focus();
  }
});

function reviewedSiteCatalogue(data) {
  // A proxy must not be able to inflate a short curated list into thousands
  // of DOM option nodes or use control/bidi characters to mislabel choices.
  // Bounds are applied before constructing suggestions or normalizing URLs.
  if (!Array.isArray(data?.sites) || data.sites.length === 0 ||
      data.sites.length > 32) return false;
  const urls = new Set();
  return data.sites.every((site) => {
    if (!site || typeof site.name !== "string" || !site.name.trim() ||
        site.name.length > 96 ||
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(site.name) ||
        typeof site.url !== "string" || site.url.length > 2048) return false;
    try {
      const url = new URL(site.url);
      if (url.protocol !== "https:" || url.username || url.password ||
          url.href !== site.url || urls.has(site.url)) return false;
      urls.add(site.url);
      return true;
    } catch {
      return false;
    }
  });
}

async function init() {
  await ensureSiteCatalogue();
  await refreshHealth();
  window.setInterval(refreshHealth, 20000);
}

syncStartButton();
init();
