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
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function setMessage(text = "") {
  message.textContent = text;
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

function syncStartButton() {
  // Capacity may be busy yet reusable for this client; only invalid, offline
  // or draining gateway state must prevent an avoidable start POST.
  startButton.disabled = sessionStarting || sessionEnding || !gatewayCanStart;
}

async function refreshHealth(retryPendingRelease = true) {
  // A failed DELETE must not become a second same-IP POST that reuses the
  // supposedly ended browser. Retry its release on the regular health poll.
  if (retryPendingRelease && pendingReleaseToken) {
    await releasePendingSession();
  }
  const sequence = ++healthRequestSequence;
  const status = $("capacityText").parentElement;
  try {
    const health = await request("/api/health");
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
  if (sessionStarting || sessionEnding || state.session || !gatewayCanStart) return;
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
        : error.message);
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
      body: "{}"
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
    await request("/api/session/" + token, { method: "DELETE", keepalive: true });
    pendingReleaseToken = null;
    sessionEnding = false;
    setMessage();
    return true;
  } catch (error) {
    // A 404 confirms this token is no longer an accessible session. Other
    // failures, including transport errors, leave server teardown unknown.
    if (error.status === 404 || error.status === 410) {
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = urlInput.value.trim();
  if (!value) {
    setMessage("Enter a website URL.");
    urlInput.focus();
    return;
  }
  startSession(value);
});

$("endButton").addEventListener("click", endSession);

$("fullscreenButton").addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await $("browserStage").requestFullscreen().catch(() => {});
  } else {
    await document.exitFullscreen().catch(() => {});
  }
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

async function init() {
  try {
    const data = await request("/api/sites");
    state.sites = data.sites;
    renderSuggestions();
    if (state.sites[0]) urlInput.value = state.sites[0].url;
  } catch (error) {
    setMessage(error.message);
  }

  await refreshHealth();
  window.setInterval(refreshHealth, 20000);
}

syncStartButton();
init();
