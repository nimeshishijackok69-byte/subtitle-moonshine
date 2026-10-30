const { MSG, STATE } = globalThis.LIVE_SUBS;

const DEFAULTS = {
  "overlay.lines": 3,
  "overlay.fontSize": 32,
  "overlay.opacity": 0.45,
  "overlay.showInterim": true
};

const STATUS_LABELS = {
  [STATE.IDLE]: "Idle",
  [STATE.CREATING_OFFSCREEN]: "Preparing audio engine",
  [STATE.LOADING_VAD]: "Loading neural voice detector...",
  [STATE.LOADING_MODEL]: "Loading local speech model...",
  [STATE.AWAITING_CAPTURE_PERMISSION]: "Waiting for tab selection",
  [STATE.CAPTURING]: "Capturing audio",
  [STATE.LISTENING]: "Listening (local AI + VAD)",
  [STATE.STOPPING]: "Stopping",
  [STATE.ERROR]: "Error"
};

const ACTIVE_SESSION_STATES = new Set([
  STATE.CREATING_OFFSCREEN,
  STATE.LOADING_VAD,
  STATE.LOADING_MODEL,
  STATE.AWAITING_CAPTURE_PERMISSION,
  STATE.CAPTURING,
  STATE.LISTENING,
  STATE.STOPPING
]);

const els = {
  lines: document.getElementById("lines"),
  linesValue: document.getElementById("linesValue"),
  fontSize: document.getElementById("fontSize"),
  fontSizeValue: document.getElementById("fontSizeValue"),
  opacity: document.getElementById("opacity"),
  opacityValue: document.getElementById("opacityValue"),
  showInterim: document.getElementById("showInterim"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  statusText: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot")
};

let overlaySaveTimer = null;

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function getOverlayConfig() {
  return {
    lines: Number(els.lines.value),
    fontSize: Number(els.fontSize.value),
    opacity: Number(els.opacity.value),
    showInterim: els.showInterim.checked,
    chunkMs: 25
  };
}

function getSessionConfig() {
  return getOverlayConfig();
}

function getPersistedOverlaySettings() {
  const config = getOverlayConfig();
  return {
    "overlay.lines": config.lines,
    "overlay.fontSize": config.fontSize,
    "overlay.opacity": config.opacity,
    "overlay.showInterim": config.showInterim
  };
}

function updateValueLabels() {
  els.linesValue.textContent = els.lines.value;
  els.fontSizeValue.textContent = `${els.fontSize.value}px`;
  els.opacityValue.textContent = `${Math.round(Number(els.opacity.value) * 100)}%`;
}

function updateStartState() {
  const isBusy = ACTIVE_SESSION_STATES.has(els.statusDot.dataset.state || STATE.IDLE);
  els.start.disabled = isBusy;
  els.stop.disabled = !isBusy;
}

function setStatus(state, detail = "") {
  const text = detail || STATUS_LABELS[state] || state;
  els.statusDot.dataset.state = state;
  els.statusText.textContent = text;
  els.statusText.title = text;
  els.statusDot.classList.toggle("live", state === STATE.LISTENING);
  els.statusDot.classList.toggle("error", state === STATE.ERROR);
  updateStartState();
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  return tab.id;
}

async function persistOverlaySettings() {
  await storageSet(getPersistedOverlaySettings());
}

async function persistAllSettings() {
  await storageSet(getPersistedOverlaySettings());
  return true;
}

function scheduleOverlaySettingsSave() {
  window.clearTimeout(overlaySaveTimer);
  overlaySaveTimer = window.setTimeout(() => {
    persistOverlaySettings().catch((error) => setStatus(STATE.ERROR, error.message));
  }, 200);
}

async function applyOverlaySettingsToTab() {
  updateValueLabels();
  scheduleOverlaySettingsSave();

  try {
    const tabId = await getActiveTabId();
    await chrome.runtime.sendMessage({
      type: MSG.APPLY_SETTINGS,
      tabId,
      config: getOverlayConfig()
    });
  } catch {
    // The overlay may not be present before the first session.
  }
}

async function startSession() {
  const config = getSessionConfig();
  const saved = await persistAllSettings();
  if (!saved) {
    return;
  }

  const tabId = await getActiveTabId();
  setStatus(STATE.CREATING_OFFSCREEN);

  // NOTE: no chrome.permissions.request here on purpose. Chrome MV3's user
  // gesture ends at this handler's first await, so permissions.request called
  // after the storage/tab lookups above always rejects with "This function
  // must be called during a user gesture" — it would be dead code with a
  // silently swallowed rejection. Injection therefore relies on the
  // activeTab grant from this popup click. If subtitles should survive
  // cross-origin navigation, grant the site manually (address-bar padlock
  // icon > Site settings, or chrome://settings/content/all): the manifest
  // declares optional_host_permissions for exactly that.
  const response = await chrome.runtime.sendMessage({
    type: MSG.START_SESSION,
    tabId,
    config
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to start session.");
  }
}

async function stopSession() {
  setStatus(STATE.STOPPING);
  const response = await chrome.runtime.sendMessage({
    type: MSG.STOP_SESSION
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to stop session.");
  }
}

async function load() {
  const values = {
    ...DEFAULTS,
    ...(await storageGet(Object.keys(DEFAULTS)))
  };
  els.lines.value = values["overlay.lines"];
  els.fontSize.value = values["overlay.fontSize"];
  els.opacity.value = values["overlay.opacity"];
  els.showInterim.checked = Boolean(values["overlay.showInterim"]);

  updateValueLabels();
  setStatus(STATE.IDLE);

  const status = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  if (status?.ok) {
    setStatus(status.state || STATE.IDLE);
  }

}

for (const input of [els.lines, els.fontSize, els.opacity, els.showInterim]) {
  input.addEventListener("input", () => {
    applyOverlaySettingsToTab().catch((error) => setStatus(STATE.ERROR, error.message));
  });
}

els.start.addEventListener("click", () => {
  // Disable synchronously in the gesture turn: the rest of the click flow
  // awaits storage/tab IPC calls before the first status update, leaving a
  // double-click window that would race two concurrent sessions.
  els.start.disabled = true;
  startSession().catch((error) => setStatus(STATE.ERROR, error.message));
});

els.stop.addEventListener("click", () => {
  stopSession().catch((error) => setStatus(STATE.ERROR, error.message));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE) {
    setStatus(message.state);
  }

  if (message?.type === MSG.ERROR) {
    setStatus(STATE.ERROR, message.message);
  }
});

load().catch((error) => setStatus(STATE.ERROR, error.message));
