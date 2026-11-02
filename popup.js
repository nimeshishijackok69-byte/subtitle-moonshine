const { MSG, STATE } = globalThis.LIVE_SUBS;
const DIAG = globalThis.LIVE_DIAG;
// The popup's own console dies with the popup, and a clipboard or status error
// showing up here is often the only trace of what the user actually clicked.
DIAG.install();

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
  copyDiagnostics: document.getElementById("copyDiagnostics"),
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
  if (data?.platform) {
    return `${data.platform} ${navigator.userAgent.includes("x86") ? "x86_64" : ""}`.trim();
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
  const report = await buildDiagnosticReport();
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    // writeText rejects when the document lost focus between click and copy;
    // the textarea path still works because it runs inside the same turn.
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

els.copyDiagnostics.addEventListener("click", async () => {
  const button = els.copyDiagnostics;
  const label = button.textContent;
  button.disabled = true;
  try {
    const chars = await copyDiagnostics();
    button.textContent = `Copied ${Math.max(1, Math.round(chars / 1024))} KB`;
    button.classList.add("copied");
  } catch (error) {
    button.textContent = "Copy failed";
    setStatus(STATE.ERROR, error.message);
  }
  window.setTimeout(() => {
    button.textContent = label;
    button.classList.remove("copied");
    button.disabled = false;
  }, 1800);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE) {
    setStatus(message.state);
  }

  if (message?.type === MSG.ERROR) {
    // The code is the stable, searchable token; the message is free text that
    // changes between Chrome versions. Lead with the code.
    const detail = message.code ? `[${message.code}] ${message.message}` : message.message;
    setStatus(STATE.ERROR, detail);
  }
});

load().catch((error) => setStatus(STATE.ERROR, error.message));
