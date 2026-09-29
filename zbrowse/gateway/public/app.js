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
const siteGrid = $("siteGrid");

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Er ging iets mis.");
  return body;
}

function setMessage(text = "") {
  message.textContent = text;
}

function renderSites() {
  siteGrid.replaceChildren(...state.sites.map((site) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "site-card";
    button.style.setProperty("--accent", site.accent || "#705cff");
    button.innerHTML = `<span class="site-icon" aria-hidden="true">${site.name.slice(0, 1)}</span><span><strong></strong><small></small></span>`;
    button.querySelector("strong").textContent = site.name;
    button.querySelector("small").textContent = site.description;
    button.addEventListener("click", () => startSession(site.url));
    return button;
  }));
}

async function refreshHealth() {
  try {
    const health = await request("/api/health");
    const available = health.activeSessions < health.capacity;
    $("capacityDot").parentElement.className = `capacity ${available ? "available" : "busy"}`;
    $("capacityText").textContent = available ? "Browser beschikbaar" : "Browser momenteel bezet";
  } catch {
    $("capacityText").textContent = "Browserengine offline";
  }
}

async function startSession(url) {
  setMessage();
  startButton.disabled = true;
  startButton.textContent = "Starten…";
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
    startButton.textContent = "Start browser";
  }
}

function showBrowser() {
  homeView.hidden = true;
  browserView.hidden = false;
  $("browserLoading").hidden = false;
  const frame = $("browserFrame");
  frame.src = state.session.viewerUrl;
  frame.addEventListener("load", () => { $("browserLoading").hidden = true; }, { once: true });

  state.heartbeat = window.setInterval(() => {
    request(`/api/session/${state.session.token}/heartbeat`, { method: "POST", body: "{}" }).catch(endSession);
  }, 30_000);
  state.countdown = window.setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  if (!state.session) return;
  const remaining = Math.max(0, state.session.expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  $("timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  await request(`/api/session/${token}`, { method: "DELETE" }).catch(() => {});
  await refreshHealth();
  startButton.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  startSession(urlInput.value.trim());
});

$("endButton").addEventListener("click", endSession);
$("fullscreenButton").addEventListener("click", async () => {
  if (!document.fullscreenElement) await $("browserStage").requestFullscreen().catch(() => {});
  else await document.exitFullscreen().catch(() => {});
});

window.addEventListener("pagehide", () => {
  if (state.session) navigator.sendBeacon(`/api/session/${state.session.token}/heartbeat`, new Blob(["{}"], { type: "application/json" }));
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
    $("durationText").textContent = `Maximaal ${data.maxSessionMinutes} minuten`;
    if (state.sites[0]) urlInput.value = state.sites[0].url;
    renderSites();
  } catch (error) {
    setMessage(error.message);
  }
  await refreshHealth();
  window.setInterval(refreshHealth, 20_000);
}

init();
