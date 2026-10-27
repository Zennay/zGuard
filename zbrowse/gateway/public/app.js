"use strict";

const state = {
  sites: [],
  session: null,
  heartbeat: null,
  countdown: null,
  viewerLoadTimeout: null
};

const $ = (id) => document.getElementById(id);
const homeView = $("homeView");
const browserView = $("browserView");
const form = $("browserForm");
const urlInput = $("urlInput");
const startButton = $("startButton");
const message = $("formMessage");

// Match the read-only public readiness byte limits inside the actual TV.
// Even correctly typed HTTP 200 can stream unlimited JSON unless we stop
// reading before parsing. Fetch's abort signal remains active during reads.
// Keep transport cleanup bounded. A hostile upstream can acknowledge neither
// data nor cancellation; a failed TV read must still resolve as offline.
async function cancelQuietly(cancel) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 250); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The same AbortSignal passed to fetch must govern reads *after headers*.
// A fetch adapter may otherwise leave reader.read() pending indefinitely.
function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Gateway read expired."));
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(signal.reason || new Error("Gateway read expired."));
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([reader.read(), deadline]).finally(() =>
    signal.removeEventListener("abort", abort));
}

async function boundedGatewayJson(response, maximumBytes, signal) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    if (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximumBytes)) {
      await cancelQuietly(() => response.body?.cancel?.());
      throw new Error("Invalid gateway response size.");
    }
  }
  if (!response.body?.getReader) throw new Error("Missing gateway response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let decoded = "";
  try {
    for (;;) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid gateway response chunk.");
      received += value.byteLength;
      if (received > maximumBytes) {
        throw new Error("Gateway response too large.");
      }
      decoded += decoder.decode(value, { stream: true });
    }
    decoded += decoder.decode();
  } catch (error) {
    await cancelQuietly(() => reader.cancel());
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* Pending reads are being cancelled. */ }
  }
  return JSON.parse(decoded);
}

async function request(url, options = {}) {
  // Gateway API calls are same-origin contracts, never browser navigation.
  // Fetch follows 301/302/303/307/308 by default, which can turn a rejected
  // operation into a success from an unrelated endpoint or replay POST/DELETE.
  // A redirect must fail before any second HTTP request is dispatched.
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    redirect: "error"
  });
  // Read-only health/catalogue errors never contribute trustworthy UI data.
  // A reverse proxy may send an enormous 502 HTML/JSON error response: do not
  // parse or buffer it just to display the already reviewed offline state.
  if ((url === "/api/health" || url === "/api/sites") && !response.ok) {
    await cancelQuietly(() => response.body?.cancel?.());
    const error = new Error("Gateway read unavailable.");
    error.status = response.status;
    throw error;
  }
  // Session starts and heartbeat renewals never show raw upstream error
  // bodies: their HTTP status is sufficient for reviewed TV guidance / safe
  // lease teardown. Do not parse unbounded HTML/JSON proxy diagnostics.
  if (!response.ok && (url === "/api/session" || url.endsWith("/heartbeat"))) {
    await cancelQuietly(() => response.body?.cancel?.());
    const error = new Error("Gateway operation rejected.");
    error.status = response.status;
    throw error;
  }
  // The gateway confirms a completed browser teardown with 204 No Content.
  // A proxy-generated 200/202/206 is not evidence of Docker cleanup, even
  // when its body looks successful. Keep the old token locked for retry.
  if (options.method === "DELETE" && response.ok && response.status !== 204) {
    await cancelQuietly(() => response.body?.cancel?.());
    throw new Error("Unexpected session release status.");
  }
  // An intermediary's 500/502/503/429 response cannot confirm teardown.
  // Do not read arbitrary, potentially unbounded upstream diagnostics.
  // A gateway JSON 404/410 is the only error that may prove release.
  if (options.method === "DELETE" && !response.ok) {
    const contentType = response.headers?.get?.("content-type") || "";
    if ((response.status !== 404 && response.status !== 410) ||
        !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      await cancelQuietly(() => response.body?.cancel?.());
      const error = new Error("Session release not confirmed.");
      error.status = response.status;
      throw error;
    }
  }
  // These are read-only gateway routes with a 200 JSON contract. A proxy
  // returning 202/203/205/206 must not advertise readiness or populate a
  // trusted site catalogue from a status it cannot authoritatively confirm.
  if ((url === "/api/health" || url === "/api/sites") && response.ok) {
    if (response.status !== 200) {
      await cancelQuietly(() => response.body?.cancel?.());
      throw new Error("Unexpected gateway read status.");
    }
    // A parseable JSON body with a proxy-provided HTML/plain-text label is
    // not an authoritative health or curated-site response. Both actual
    // Express routes send application/json, optionally with a charset.
    const mediaType = response.headers?.get?.("content-type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(mediaType)) {
      await cancelQuietly(() => response.body?.cancel?.());
      throw new Error("Invalid gateway read response format.");
    }
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
      await cancelQuietly(() => response.body?.cancel?.());
      throw new Error("Unexpected heartbeat status.");
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      await cancelQuietly(() => response.body?.cancel?.());
      throw new Error("Invalid heartbeat response format.");
    }
  }
  // Bound *decoded* JSON for every API response, not only readiness GETs.
  // A compressed or chunked session response can expand far beyond its wire
  // Content-Length. Never invoke unbounded Response.json() on a bearer route.
  const maximumBytes = url === "/api/health" ? 4096 :
    url === "/api/sites" ? 65536 :
    url === "/api/session" ? 4096 :
    options.method === "DELETE" ? 512 :
    url.endsWith("/heartbeat") ? 1024 : 0;
  if (!maximumBytes) throw new Error("Unexpected gateway response route.");
  const body = await boundedGatewayJson(response, maximumBytes, options.signal);
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
let siteCatalogueValidatedAt = 0;
const SITE_CATALOGUE_MAX_AGE_MS = 5 * 60_000;
// Offline users can force a fresh read by reloading, but automatic polling
// remains active. Keep the guidance truthful for both TV and desktop users.
const SITE_CATALOGUE_RETRY_MESSAGE = "Site catalogue unavailable. Retrying automatically. Reload to retry now.";

function syncStartButton() {
  // Capacity may be busy yet reusable for this client; only invalid, offline
  // or draining gateway state must prevent an avoidable start POST.
  // The form is hidden while a viewer is active. Keep its historical enabled
  // state for TV focus restoration/assistive clients; startSession() still
  // rejects any scripted submit while state.session exists, independently of
  // button state. Pending teardown must still lock the control visibly.
  startButton.disabled = sessionStarting || sessionEnding || !!pendingReleaseToken ||
    !gatewayCanStart || !siteCatalogueReady || !pageActive;
}

async function ensureSiteCatalogue() {
  // A cached in-memory allowlist can outlive a gateway rollout even though
  // /api/sites itself is no-store. Revalidate periodically so the TV cannot
  // keep offering origins removed from the reviewed gateway configuration.
  // A slow /api/sites reply can overlap multiple health ticks and BFCache
  // restores. Share one in-flight operation to preserve reviewed results.
  if (siteCatalogueRequest) return siteCatalogueRequest;
  const catalogueAge = Date.now() - siteCatalogueValidatedAt;
  // Wall clocks can move backward after a TV sleep/resume or NTP correction.
  // A negative age must not preserve a revoked allowlist indefinitely.
  if (siteCatalogueReady && catalogueAge >= 0 &&
      catalogueAge < SITE_CATALOGUE_MAX_AGE_MS) return true;
  // Never let a stale catalogue authorize a new session while revalidating.
  siteCatalogueReady = false;
  syncStartButton();
  const attempt = (async () => {
    try {
      const data = await request("/api/sites", { cache: "no-store", signal: AbortSignal.timeout(7000) });
      if (!reviewedSiteCatalogue(data)) throw new Error("Invalid site catalogue");
      // Replace a preselected site only if that former reviewed suggestion
      // has actually been revoked. Never overwrite a custom URL being typed.
      const previousSuggestion = state.sites.some(
        (site) => site.url === urlInput.value.trim()
      );
      state.sites = data.sites;
      renderSuggestions();
      if (!urlInput.value.trim() ||
          (previousSuggestion && !isReviewedStartUrl(urlInput.value.trim()))) {
        urlInput.value = state.sites[0].url;
      }
      siteCatalogueReady = true;
      siteCatalogueValidatedAt = Date.now();
      // A successful catalogue refresh must not erase a stronger warning
      // about a browser whose DELETE has not yet been acknowledged.
      // A catalogue recovery may clear only its own earlier outage notice.
      // Preserve a more useful start/teardown error while the TV retries.
      if (!pendingReleaseToken &&
          message.textContent === SITE_CATALOGUE_RETRY_MESSAGE) {
        setMessage();
      }
      return true;
    } catch {
      siteCatalogueReady = false;
      siteCatalogueValidatedAt = 0;
      state.sites = [];
      renderSuggestions();
      // Catalogue discovery is secondary to confirmed browser teardown.
      // Keep the safety-critical release guidance visible during outages.
      // A catalogue outage must not erase a more actionable browser-start or
      // viewer failure. Capacity already reports the catalogue as unavailable;
      // only replace an empty/previous catalogue notice. Teardown warnings
      // remain highest priority while a browser bearer may still be live.
      if (pendingReleaseToken || !message.textContent ||
          message.textContent === SITE_CATALOGUE_RETRY_MESSAGE) {
        setMessage(pendingReleaseToken
          ? "Could not confirm browser shutdown. Retrying automatically."
          : SITE_CATALOGUE_RETRY_MESSAGE);
      }
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
  // Frozen / abandoned pages may not trust old readiness or dispatch a new
  // capacity poll. pageshow / online / visibility recovery performs a fresh
  // bounded check before admitting another browser.
  if (!pageActive) return;
  // A failed DELETE retains browser capacity and the old bearer. Retry that
  // teardown *before* catalogue discovery, whose 7-second timeout must not
  // delay releasing an existing browser or hold its recovery behind an outage.
  if (retryPendingRelease && pendingReleaseToken) {
    await releasePendingSession();
  }
  // The first TV bootstrap must validate its catalogue before polling
  // capacity. That keeps startup deterministic, with one bounded read at a
  // time. After a valid catalogue has been observed, later revalidation and
  // Docker health are independent: begin both without serial timeout delays.
  // In either mode Open still requires BOTH valid, current responses.
  const catalogueRefresh = siteCatalogueValidatedAt > 0
    ? ensureSiteCatalogue() : null;
  if (!catalogueRefresh) await ensureSiteCatalogue();
  const sequence = ++healthRequestSequence;
  const status = $("capacityText").parentElement;
  try {
    // Readiness controls session admission, so do not reuse a previous 200
    // from the browser HTTP cache even if a proxy misconfigures max-age.
    // Server/CDN no-store remains an independent requirement (#293).
    const health = await request("/api/health", { cache: "no-store", signal: AbortSignal.timeout(7000) });
    // A slower earlier poll cannot overwrite a newer capacity observation.
    if (sequence !== healthRequestSequence) return;
    // A healthy gateway alone cannot authorize browser creation until the
    // curated HTTPS catalogue has completed its independent validation.
    if (catalogueRefresh) {
      await catalogueRefresh;
      if (sequence !== healthRequestSequence) return;
    }
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
    payload.maxMinutes < 1 ||
    // The gateway issues expiresAt = creation time + maxMinutes minutes.
    // Allow two minutes for TV/gateway clock drift and start-up latency, but
    // never trust a proxy's 1-year lease labelled as a 15-minute session.
    // Bound multiplication to safe integer milliseconds before comparing.
    payload.maxMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60000) ||
    payload.expiresAt > Date.now() + payload.maxMinutes * 60000 + 120000
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
  if (sessionStarting || sessionEnding || pendingReleaseToken || state.session ||
      !gatewayCanStart || !siteCatalogueReady || !pageActive) return;
  const requestGeneration = pageExitGeneration;
  sessionStarting = true;
  setMessage();
  syncStartButton();
  startButton.textContent = "Starting…";
  try {
    // Gateway readiness can legitimately include a slow kiosk boot, but a
    // proxy that never completes headers or JSON must not pin the TV in
    // "Starting" forever. This deadline also covers the response stream.
    // A timed-out request can still create a server-side browser: gateway
    // admission, TTL and orphan reconciliation remain independent controls.
    const payload = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(150000)
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
  // The previous Open button is now inside a hidden landmark. Move keyboard
  // and TV-remote focus to a visible, operable viewer control immediately.
  // End session remains the next Tab stop and restores focus to URL input.
  $("fullscreenButton").focus();
  $("browserLoading").hidden = false;

  const frame = $("browserFrame");
  // The initial iframe load may never finish if the upstream viewer stalls.
  // Register the event listener *before* navigation, and close the browser
  // through the normal fail-closed teardown path when 30s elapse.
  frame.addEventListener("load", () => {
    if (state.session === session) {
      window.clearTimeout(state.viewerLoadTimeout);
      state.viewerLoadTimeout = null;
      $("browserLoading").hidden = true;
    }
  }, { once: true });
  const loadTimeoutId = window.setTimeout(() => {
    // clearTimeout() cannot retract a callback already queued for dispatch.
    // Compare the timer identity as well as the exact session object so a
    // late callback cannot close an already loaded or newer viewer.
    if (state.viewerLoadTimeout !== loadTimeoutId || state.session !== session) return;
    endSession().then(() => {
      // A release failure has its own stronger warning and retains admission
      // lock. Never overwrite that or a subsequent successful viewer.
      if (!state.session && !pendingReleaseToken && !sessionStarting) {
        setMessage("Browser stream did not load. Try again.");
      }
    });
  }, 30000);
  state.viewerLoadTimeout = loadTimeoutId;
  frame.src = session.viewerUrl;

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
  window.clearTimeout(state.viewerLoadTimeout);
  state.heartbeat = null;
  state.countdown = null;
  state.viewerLoadTimeout = null;

  $("browserFrame").src = "about:blank";
  browserView.hidden = true;
  homeView.hidden = false;
  // Network teardown, catalogue recovery and health can each stall for
  // seconds. Put the TV remote back on the now-visible input immediately;
  // sessionEnding/pendingReleaseToken still prevent any premature start.
  urlInput.focus();

  await releasePendingSession();
  await refreshHealth(false);
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
  // TV remotes and scripted Enter submissions can fire even while Open is
  // disabled. A pending teardown takes priority over URL validation messages.
  if (pendingReleaseToken || sessionEnding) {
    setMessage("Could not confirm browser shutdown. Retrying automatically.");
    return;
  }
  if (!siteCatalogueReady) {
    setMessage(SITE_CATALOGUE_RETRY_MESSAGE);
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

window.addEventListener("pagehide", (event) => {
  // Some embedded viewers and the real-Chrome acceptance dispatch an untrusted
  // pagehide without navigating or hiding the document. They still must
  // release a pending bearer, but must not freeze an otherwise active TV page.
  // Only a real browser lifecycle transition invalidates readiness until
  // pageshow revalidates it.
  const syntheticVisibleExit = event?.isTrusted === false &&
    document.visibilityState === "visible";
  if (!syntheticVisibleExit) {
    pageActive = false;
    // BFCache can freeze a TV between a health request and its response.
    // Invalidate that response and revoke stale readiness even without a token.
    healthRequestSequence++;
    gatewayCanStart = false;
    syncStartButton();
  }
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

// TV sleep/resume or a recovered network may not coincide with the 20s
// background interval. Recheck promptly, while keeping stale or frozen pages
// unable to authorize a new browser before the refreshed health response.
window.addEventListener("online", () => {
  if (pageActive) refreshHealth();
});
document.addEventListener("visibilitychange", () => {
  if (pageActive && document.visibilityState === "visible") refreshHealth();
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
  const visibleNames = new Set();
  return data.sites.every((site) => {
    if (!site || typeof site.name !== "string" || !site.name.trim() ||
        site.name.length > 96 ||
        // Include C1 controls, Arabic Letter Mark, LRM/RLM and Unicode
        // paragraph separators, zero-width format controls and byte-order marks.
        /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(site.name) ||
        typeof site.url !== "string" || site.url.length > 2048) return false;
    try {
      const url = new URL(site.url);
      // Two URLs advertised under visually equivalent names are ambiguous
      // on the TV. NFKC catches full-width compatibility glyphs and the
      // lower-case key prevents mixed-case copies from masquerading as distinct.
      const visibleName = site.name.normalize("NFKC").trim().toLowerCase();
      if (!visibleName || visibleNames.has(visibleName) ||
          url.protocol !== "https:" || url.username || url.password ||
          url.href !== site.url || urls.has(site.url)) return false;
      urls.add(site.url);
      visibleNames.add(visibleName);
      return true;
    } catch {
      return false;
    }
  });
}

async function init() {
  // Show the actual gateway/catalogue state after the first bounded refresh.
  // An unavailable catalogue may be a transient rollout failure; retry once
  // immediately *after* that first status is rendered, not before it. This
  // retains the bootstrap recovery attempt without making the TV wait through
  // two catalogue timeouts just to see the first offline indicator.
  await refreshHealth();
  if (!siteCatalogueReady && pageActive) await refreshHealth();
  window.setInterval(refreshHealth, 20000);
}

syncStartButton();
init();
