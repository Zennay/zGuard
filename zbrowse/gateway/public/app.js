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
  if (!response.ok) throw new Error(body.error || "Something went wrong.");
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

async function refreshHealth() {
  const status = $("capacityText").parentElement;
  try {
    const health = await request("/api/health");
    const available = health.activeSessions < health.capacity;
    status.className = "status " + (available ? "available" : "busy");
    $("capacityText").textContent = available ? "Ready to browse" : "Browser currently in use";
  } catch {
    status.className = "status";
    $("capacityText").textContent = "Browser engine offline";
  }
}

async function startSession(url) {
  setMessage();
  startButton.disabled = true;
  startButton.textContent = "Starting…";
  try {
    const session = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    state.session = session;
    showBrowser();
  } catch (error) {
    setMessage(error.message);
    await refreshHealth();
  } finally {
    startButton.disabled = false;
    startButton.textContent = "Open";
  }
}

function showBrowser() {
  const session = state.session;
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

async function endSession() {
  if (!state.session) return;
  const token = state.session.token;
  state.session = null;

  window.clearInterval(state.heartbeat);
  window.clearInterval(state.countdown);
  state.heartbeat = null;
  state.countdown = null;

  $("browserFrame").src = "about:blank";
  browserView.hidden = true;
  homeView.hidden = false;

  await request("/api/session/" + token, { method: "DELETE" }).catch(() => {});
  await refreshHealth();
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

window.addEventListener("pagehide", (event) => {
  if (!state.session) return;
  const token = state.session.token;

  if (event.persisted) {
    navigator.sendBeacon(
      "/api/session/" + token + "/heartbeat",
      new Blob(["{}"], { type: "application/json" })
    );
    return;
  }

  fetch("/api/session/" + token, {
    method: "DELETE",
    keepalive: true
  }).catch(() => {});
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

init();
