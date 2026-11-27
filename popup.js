const { MSG, STATE } = globalThis.LIVE_SUBS;
const DIAG = globalThis.LIVE_DIAG;
// The popup's own console dies with the popup, and a clipboard or status error
// showing up here is often the only trace of what the user actually clicked.
DIAG.install();

const DEFAULTS = {
  "overlay.lines": 3,
  "overlay.fontSize": 32,
  "overlay.opacity": 0.45,
  "overlay.showInterim": true,
  "overlay.hotwords": ""
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
  hotwords: document.getElementById("hotwords"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  resetOverlay: document.getElementById("resetOverlay"),
  copyDiagnostics: document.getElementById("copyDiagnostics"),
  statusText: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot")
};

let overlaySaveTimer = null;
let settingsSendTimer = null;
let hotwordsApplyTimer = null;
let userInitiatedStart = false;
let userEditedSettings = false;

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
    hotwords: (els.hotwords?.value || "").trim(),
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
    "overlay.showInterim": config.showInterim,
    "overlay.hotwords": config.hotwords
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

function setStatus(state, detail = "", options = {}) {
  const text = detail || STATUS_LABELS[state] || state;
  const showAsError = state === STATE.ERROR || Boolean(options.isError);
  els.statusDot.dataset.state = state;
  els.statusText.textContent = text;
  els.statusText.title = text;
  els.statusText.classList.toggle("is-error", showAsError);
  els.statusDot.classList.toggle("live", state === STATE.LISTENING);
  els.statusDot.classList.toggle("error", showAsError);
  updateStartState();
}

function reportPopupError(error) {
  const curState = els.statusDot.dataset.state || STATE.IDLE;
  const msg = error?.message || String(error || "Unknown error");
  if (ACTIVE_SESSION_STATES.has(curState)) {
    setStatus(curState, msg, { isError: true });
    return;
  }
  setStatus(STATE.ERROR, msg);
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

function scheduleOverlaySettingsSave() {
  window.clearTimeout(overlaySaveTimer);
  overlaySaveTimer = window.setTimeout(() => {
    overlaySaveTimer = null;
    persistOverlaySettings().catch(reportPopupError);
  }, 200);
}

async function sendApplySettingsToRuntime() {
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

function flushPendingSettingsSave() {
  const hadStoragePending = Boolean(overlaySaveTimer);
  const hadHotwordsPending = Boolean(hotwordsApplyTimer);
  const hadSettingsSend = Boolean(settingsSendTimer);
  if (overlaySaveTimer) {
    window.clearTimeout(overlaySaveTimer);
    overlaySaveTimer = null;
  }
  if (hotwordsApplyTimer) {
    window.clearTimeout(hotwordsApplyTimer);
    hotwordsApplyTimer = null;
  }
  if (settingsSendTimer) {
    window.clearTimeout(settingsSendTimer);
    settingsSendTimer = null;
  }
  if (hadStoragePending || hadHotwordsPending) {
    persistOverlaySettings().catch(() => {});
  }
  if (hadHotwordsPending || hadSettingsSend) {
    sendApplySettingsToRuntime().catch(() => {});
  }
}

function applyOverlaySettingsToTab() {
  updateValueLabels();
  scheduleOverlaySettingsSave();
  window.clearTimeout(settingsSendTimer);
  settingsSendTimer = window.setTimeout(() => {
    settingsSendTimer = null;
    sendApplySettingsToRuntime().catch(() => {});
  }, 60);
}

async function startSession() {
  const config = getSessionConfig();
  flushPendingSettingsSave();
  await persistOverlaySettings();

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

// ─── Diagnostics ────────────────────────────────────────────────────
// One click has to produce something a maintainer can act on without asking a
// follow-up question. That means the report carries decisions, not just the
// last exception: which version, which machine, which backend, which state, the
// decode budget, and the events immediately before the failure.
// The service worker mirrors these before the offscreen document is torn down.
// The popup reads them directly instead of asking the worker, so a worker that
// is asleep, restarted, or broken cannot blank out the post-mortem.
const SESSION_DIAGNOSTIC_KEYS = [
  "sw.state",
  "sw.tabId",
  "sw.bootId",
  "sw.updatedAt",
  "sw.boots",
  "sw.lastError"
];

// Chrome reports 0.0.0 for the build in the user agent since UA reduction. The
// real build is only in the client hints, and the exact build decides which
// WebGPU and ORT bugs apply, so the reduced UA is a fallback, not the answer.
async function probeBrowserVersion() {
  const match = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/);
  const fallback = match ? match[1] : navigator.userAgent;
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues?.(["fullVersionList"]);
    const entry = values?.fullVersionList?.find((brand) => /chrom/i.test(brand.brand));
    if (entry?.version) return `${entry.brand} ${entry.version}`;
  } catch {
    // Client hints are not exposed in every context; the reduced UA still names
    // the major version, which is what most diagnoses actually need.
  }
  return fallback;
}

function describePlatform() {
  const data = navigator.userAgentData;
  const ua = navigator.userAgent || "";
  if (data?.platform) {
    const arch = /x86_64|x64|Win64|WOW64|amd64|x86/i.test(ua)
      ? "x86_64"
      : (/arm64|aarch64/i.test(ua) ? "arm64" : "");
    return `${data.platform} ${arch}`.trim();
  }
  return navigator.platform || "unknown";
}

// The single most useful capability bit: whether this machine has a GPU that
// WebGPU can actually reach. "Has a GPU" and "has a WebGPU adapter" are
// different questions, and only the second one matters at runtime. The timeout
// is not optional: requestAdapter() can hang for seconds on a broken driver,
// and a diagnostic button that hangs is worse than no button.
async function probeWebGpu() {
  if (!navigator.gpu) return "unavailable";
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 800))
    ]);
    if (!adapter) return "no adapter";
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null) || {};
    const label = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ");
    return label ? `adapter: ${label}` : "adapter: available";
  } catch (error) {
    return `error: ${error.message}`;
  }
}

// One probe per source, each independent. A source that fails is recorded and
// skipped; it can never blank out the sections collected from the others. The
// earlier version awaited one combined worker call, so a single failure turned
// five sections into "?" and lost the reason at the same time.
async function probeChannel(name, run) {
  const startedAt = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - startedAt));
  try {
    const data = await run();
    // sendMessage resolves undefined when nothing answered: no exception, so it
    // has to be named explicitly or it reads like an empty success.
    if (data === undefined) {
      const ms = elapsed();
      DIAG.record("popup", "warn", `${name}: no response (${ms}ms)`);
      return { name, ok: false, ms, error: "no response", data: null };
    }
    if (data?.ok === false) {
      const ms = elapsed();
      const error = data.error || "reported failure";
      DIAG.record("popup", "warn", `${name}: ${error} (${ms}ms)`);
      return { name, ok: false, ms, error, data };
    }
    return { name, ok: true, ms: elapsed(), data };
  } catch (error) {
    const ms = elapsed();
    DIAG.record("popup", "error", `${name}: ${error.message} (${ms}ms)`);
    return { name, ok: false, ms, error: error.message, data: null };
  }
}

function channelLine(channel) {
  return channel.ok ? `ok ${channel.ms}ms` : `failed: ${channel.error} (${channel.ms}ms)`;
}

function snapshotRows(snapshot) {
  if (!snapshot?.fields) return [];
  return Object.keys(snapshot.fields)
    .sort()
    .map((key) => [key, snapshot.fields[key]]);
}

function mergeTimings(sources) {
  const rows = [];
  for (const { name, snapshot } of sources) {
    for (const key of Object.keys(snapshot?.timings || {}).sort()) {
      rows.push({ source: name, name: key, ...snapshot.timings[key] });
    }
  }
  return rows;
}

function mergeEvents(sources) {
  const rows = [];
  for (const { name, snapshot } of sources) {
    for (const event of snapshot?.events || []) {
      rows.push({ source: name, ...event });
    }
  }
  return rows;
}

function mergeErrors(sources, stored) {
  // Live snapshots win: they carry the stack and the context that raised the
  // error. The mirrored copy exists only for the case where that context is
  // already gone (the failure path closes the offscreen document), and saying
  // "restored" tells the reader the original was destroyed.
  const live = [];
  for (const { name, snapshot } of sources) {
    if (snapshot?.lastError) live.push({ source: name, ...snapshot.lastError });
  }
  if (live.length) return live;
  return stored?.["sw.lastError"] ? [{ source: "sw (restored)", ...stored["sw.lastError"] }] : [];
}

// What the pipeline last believed it heard. Bounded to three; more than that is
// a transcript, which is not what this report is for.
function mergeTranscript(sources) {
  const rows = [];
  for (const { snapshot } of sources) {
    for (const entry of snapshot?.transcript || []) rows.push(entry);
  }
  return rows.sort((a, b) => a.t - b.t).slice(-3);
}

async function buildDiagnosticReport() {
  // Four independent probes, run concurrently: the popup never depends on one
  // context being alive to produce a usable report. The offscreen document is
  // addressed directly because it answers its own listener, so a wedged service
  // worker no longer costs us the engine section.
  const [browser, gpu, worker, offscreen, session] = await Promise.all([
    probeBrowserVersion(),
    probeWebGpu(),
    probeChannel("worker", () => chrome.runtime.sendMessage({ type: MSG.GET_DIAGNOSTICS })),
    probeChannel("offscreen", () =>
      chrome.runtime.sendMessage({ type: MSG.GET_DIAGNOSTICS, target: "offscreen" })
    ),
    probeChannel("session keys", () => chrome.storage.session.get(SESSION_DIAGNOSTIC_KEYS))
  ]);

  const self = DIAG.snapshot();
  const swSnapshot = worker.data?.serviceWorker || null;
  const offSnapshot = offscreen.data?.snapshot || worker.data?.offscreen || null;
  const stored = (session.ok && session.data) || worker.data?.stored || {};
  const mirrorKeys = Object.keys(stored).length;

  const sources = [
    { name: "popup", snapshot: self },
    { name: "sw", snapshot: swSnapshot },
    { name: "offscreen", snapshot: offSnapshot }
  ];

  const header = [
    ["extension", chrome.runtime.getManifest().version],
    ["chrome", browser],
    ["platform", describePlatform()],
    ["locale", navigator.language],
    ["popup state", els.statusDot.dataset.state || STATE.IDLE]
  ];

  const capabilityRows = [
    ["crossOriginIsolated", String(Boolean(globalThis.crossOriginIsolated))],
    ["hardwareConcurrency", String(navigator.hardwareConcurrency || "?")],
    ["deviceMemory GB", String(navigator.deviceMemory || "?")],
    ["sharedArrayBuffer", typeof SharedArrayBuffer],
    ["webgpu", gpu],
    ["offscreen document", offscreen.ok ? "answering" : "not answering"]
  ];

  // Which channel failed, in what way, and how long it took. This block is what
  // turns "query failed" into an answerable question.
  const queryRows = [
    ["worker", channelLine(worker)],
    ["offscreen", channelLine(offscreen)],
    ["session keys", channelLine(session)]
  ];

  // "Unknown message type." from the worker plus no mirrored keys is the
  // signature of a worker still running an older build than the pages: pages are
  // re-read from disk every time they open, the worker only re-registers on an
  // extension reload. It has cost two real reports, so name the remedy here
  // rather than leaving the reader to infer it from three question marks.
  const staleWorker = !worker.ok && /unknown message type/i.test(worker.error || "") && mirrorKeys === 0;
  if (staleWorker) {
    queryRows.push(["", "stale worker build: reload the extension (chrome://extensions)"]);
  }

  const workerRows = [
    ["state (mirrored)", stored["sw.state"] ?? "?"],
    ["tabId (mirrored)", stored["sw.tabId"] ?? "?"],
    ["mirrored at", stored["sw.updatedAt"] ? new Date(stored["sw.updatedAt"]).toISOString() : "?"],
    ["boots (total)", String(worker.data?.workerBoots ?? stored["sw.boots"] ?? "?")],
    ["sw boot (live)", swSnapshot?.bootId ?? "not read"],
    ["sw boot (mirrored)", stored["sw.bootId"] ?? "?"],
    ["popup boot", self.bootId],
    ["mirror keys", mirrorKeys ? `${mirrorKeys} present` : "none written"]
  ];

  return DIAG.formatReport({
    header,
    blocks: [
      { title: "capabilities", rows: capabilityRows },
      { title: "queries", rows: queryRows },
      { title: "service worker", rows: workerRows },
      { title: "engine", rows: snapshotRows(offSnapshot) },
      { title: "service worker fields", rows: snapshotRows(swSnapshot) }
    ],
    timings: mergeTimings(sources),
    events: mergeEvents(sources),
    errors: mergeErrors(sources, stored),
    transcript: mergeTranscript(sources)
  });
}

async function copyDiagnostics() {
  const reportPromise = buildDiagnosticReport();
  // Prefer ClipboardItem synchronously in the click turn so Chrome keeps user
  // activation alive while awaiting async diagnostic probes.
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      let resolvedLen = 0;
      const item = new ClipboardItem({
        "text/plain": reportPromise.then((text) => {
          resolvedLen = text.length;
          return new Blob([text], { type: "text/plain" });
        })
      });
      await navigator.clipboard.write([item]);
      if (resolvedLen > 0) return resolvedLen;
    } catch {
      // Fall through to resolved writeText / execCommand fallback.
    }
  }
  const report = await reportPromise;
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    const area = document.createElement("textarea");
    area.value = report;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    if (!copied) throw new Error("Clipboard is unavailable. Open the popup, then retry.");
  }
  return report.length;
}

async function load() {
  const values = {
    ...DEFAULTS,
    ...(await storageGet(Object.keys(DEFAULTS)))
  };
  if (!userEditedSettings) {
    els.lines.value = values["overlay.lines"];
    els.fontSize.value = values["overlay.fontSize"];
    els.opacity.value = values["overlay.opacity"];
    els.showInterim.checked = Boolean(values["overlay.showInterim"]);
    if (els.hotwords) els.hotwords.value = values["overlay.hotwords"] || "";
    updateValueLabels();
  }
  if (!userInitiatedStart) {
    setStatus(STATE.IDLE);
  }

  const status = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  if (userInitiatedStart) return;
  if (status?.ok) {
    const state = status.state || STATE.IDLE;
    if (state === STATE.ERROR) {
      let lastError = status.lastError || null;
      if (!lastError) {
        const stored = await chrome.storage.session.get("sw.lastError").catch(() => ({}));
        lastError = stored["sw.lastError"] || null;
      }
      const detail = lastError
        ? (lastError.code ? `[${lastError.code}] ${lastError.message}` : lastError.message)
        : "";
      setStatus(STATE.ERROR, detail);
    } else {
      setStatus(state);
    }
  }
}

for (const input of [els.lines, els.fontSize, els.opacity, els.showInterim]) {
  input.addEventListener("input", () => {
    userEditedSettings = true;
    applyOverlaySettingsToTab();
  });
}

if (els.hotwords) {
  els.hotwords.addEventListener("input", () => {
    userEditedSettings = true;
    scheduleOverlaySettingsSave();
    window.clearTimeout(hotwordsApplyTimer);
    hotwordsApplyTimer = window.setTimeout(() => {
      hotwordsApplyTimer = null;
      sendApplySettingsToRuntime().catch(reportPopupError);
    }, 300);
  });
}

window.addEventListener("pagehide", flushPendingSettingsSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSettingsSave();
});

if (els.resetOverlay) {
  els.resetOverlay.dataset.defaultLabel = els.resetOverlay.textContent;
  els.resetOverlay.addEventListener("click", async () => {
    try {
      const tabId = await getActiveTabId();
      const res = await chrome.runtime.sendMessage({ type: MSG.RESET_OVERLAY, tabId });
      if (res && res.ok === false) {
        throw new Error(res.error || "Unable to reset overlay.");
      }
      els.resetOverlay.textContent = "Reset ✓";
      els.resetOverlay.classList.add("saved");
      window.setTimeout(() => {
        els.resetOverlay.textContent = els.resetOverlay.dataset.defaultLabel;
        els.resetOverlay.classList.remove("saved");
      }, 1200);
    } catch (error) {
      reportPopupError(error);
    }
  });
}

els.start.addEventListener("click", () => {
  // Disable synchronously in the gesture turn: the rest of the click flow
  // awaits storage/tab IPC calls before the first status update, leaving a
  // double-click window that would race two concurrent sessions.
  userInitiatedStart = true;
  els.start.disabled = true;
  startSession().catch(async (error) => {
    userInitiatedStart = false;
    const live = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS }).catch(() => null);
    if (live?.ok && ACTIVE_SESSION_STATES.has(live.state)) {
      setStatus(live.state, error.message, { isError: true });
      return;
    }
    setStatus(STATE.ERROR, error.message);
  });
});

els.stop.addEventListener("click", () => {
  stopSession().catch(reportPopupError);
});

els.copyDiagnostics.dataset.defaultLabel = els.copyDiagnostics.textContent;
els.copyDiagnostics.addEventListener("click", async () => {
  const button = els.copyDiagnostics;
  button.disabled = true;
  try {
    const chars = await copyDiagnostics();
    button.textContent = `Copied ${Math.max(1, Math.round(chars / 1024))} KB`;
    button.classList.add("copied");
  } catch (error) {
    button.textContent = "Copy failed";
    reportPopupError(error);
  }
  window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel;
    button.classList.remove("copied");
    button.disabled = false;
  }, 1800);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE) {
    if (message.state === STATE.IDLE || message.state === STATE.ERROR) {
      userInitiatedStart = false;
    }
    setStatus(message.state);
  }

  if (message?.type === MSG.ERROR) {
    userInitiatedStart = false;
    const detail = message.code ? `[${message.code}] ${message.message}` : message.message;
    setStatus(STATE.ERROR, detail);
  }
});

load().catch(reportPopupError);
