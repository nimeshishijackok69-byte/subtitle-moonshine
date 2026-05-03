const { MSG, STATE } = globalThis.HIANIME;

const DEFAULTS = {
  groqApiKey: "",
  "overlay.lines": 3,
  "overlay.fontSize": 32,
  "overlay.opacity": 0.45,
  "overlay.showInterim": true
};

const STATUS_LABELS = {
  [STATE.IDLE]: "Idle",
  [STATE.CREATING_OFFSCREEN]: "Preparing audio engine",
  [STATE.LOADING_VAD]: "Loading neural voice detector...",
  [STATE.LOADING_MODEL]: "Loading Moonshine model on GPU...",
  [STATE.AWAITING_CAPTURE_PERMISSION]: "Waiting for tab selection",
  [STATE.CAPTURING]: "Capturing audio",
  [STATE.CONNECTING_DEEPGRAM]: "Connecting...",
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
  STATE.CONNECTING_DEEPGRAM,
  STATE.LISTENING,
  STATE.STOPPING
]);

const els = {
  apiKey: document.getElementById("apiKey"),
  saveKey: document.getElementById("saveKey"),
  clearKey: document.getElementById("clearKey"),
  keyHint: document.getElementById("keyHint"),
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

function storageRemove(keys) {
  return chrome.storage.local.remove(keys);
}

function getOverlayConfig() {
  return {
    lines: 3,
    fontSize: Number(els.fontSize.value),
    opacity: Number(els.opacity.value),
    showInterim: els.showInterim.checked,
    chunkMs: 25,
    vadHangoverMs: 150,
    vadPreRollMs: 120
  };
}

function getApiKey() {
  return els.apiKey.value.trim();
}

function getSessionConfig() {
  return {
    ...getOverlayConfig(),
    apiKey: getApiKey(),
    language: "ja",
    model: "whisper-large-v3"
  };
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
  const key = getApiKey();
  const hasValidApiKey = key.length === 0 || isApiKeyUsable(key);
  const isBusy = ACTIVE_SESSION_STATES.has(els.statusDot.dataset.state || STATE.IDLE);
  els.start.disabled = isBusy;
  els.stop.disabled = !isBusy;
  els.apiKey.classList.toggle("invalid", key.length > 0 && !isApiKeyUsable(key));
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

function isApiKeyUsable(key) {
  return key.length > 0 && (key.startsWith("gsk_") || key.length >= 20);
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

async function persistApiKey() {
  const apiKey = getApiKey();
  if (apiKey && !isApiKeyUsable(apiKey)) {
    els.keyHint.textContent = "That key does not look like a Groq API key.";
    updateStartState();
    return;
  }

  await storageSet({ groqApiKey: apiKey });
  els.keyHint.textContent = apiKey ? "Saved locally." : "Enter a Groq API key to start.";
  els.saveKey.classList.add("saved");
  window.setTimeout(() => els.saveKey.classList.remove("saved"), 900);
  updateStartState();
}

async function persistAllSettings() {
  const apiKey = getApiKey();
  if (apiKey && !isApiKeyUsable(apiKey)) {
    els.keyHint.textContent = "That key does not look like a Groq API key.";
    updateStartState();
    return false;
  }

  await storageSet({
    groqApiKey: apiKey,
    ...getPersistedOverlaySettings()
  });
  els.keyHint.textContent = apiKey ? "Saved locally." : "Enter a Groq API key to start.";
  updateStartState();
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

  if (config.apiKey && !isApiKeyUsable(config.apiKey)) {
    setStatus(STATE.ERROR, "API key format looks wrong");
    return;
  }

  const saved = await persistAllSettings();
  if (!saved) {
    return;
  }

  const tabId = await getActiveTabId();
  setStatus(STATE.CREATING_OFFSCREEN);

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
  values["overlay.lines"] = 3;

  els.apiKey.value = values.groqApiKey || "";
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

els.saveKey.addEventListener("click", () => {
  persistApiKey().catch((error) => setStatus(STATE.ERROR, error.message));
});

els.clearKey.addEventListener("click", async () => {
  els.apiKey.value = "";
  window.clearTimeout(overlaySaveTimer);
  await storageRemove(["groqApiKey"]);
  els.keyHint.textContent = "Key cleared.";
  updateStartState();
});

els.apiKey.addEventListener("input", () => {
  els.keyHint.textContent = getApiKey() ? "Unsaved API key changes." : "Enter a Groq API key to start.";
  updateStartState();
});

for (const input of [els.lines, els.fontSize, els.opacity, els.showInterim]) {
  input.addEventListener("input", () => {
    applyOverlaySettingsToTab().catch((error) => setStatus(STATE.ERROR, error.message));
  });
}

els.start.addEventListener("click", () => {
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
