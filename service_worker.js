import "./constants.js";
import "./diagnostics.js";

const { MSG, STATE, OVERLAY_CSS } = globalThis.LIVE_SUBS;
const DIAG = globalThis.LIVE_DIAG;
DIAG.install();
const OFFSCREEN_DOCUMENT = "offscreen.html";
const OFFSCREEN_TEARDOWN_ALARM = "offscreen-teardown";

// ─── Diagnostics state mirror ───────────────────────────────────────
// MV3 terminates this worker after ~30 s idle, and currentState/activeTabId
// live in module memory. Mirroring to storage.session keeps the state, target
// tab, overlay settings, and last error alive across worker restarts.
let workerBoots = 0;
const bootCountReady = chrome.storage.session
  .get("sw.boots")
  .then((stored) => {
    workerBoots = Number(stored["sw.boots"] || 0) + 1;
    return chrome.storage.session.set({ "sw.boots": workerBoots });
  })
  .catch(() => {});

function mirrorState() {
  return chrome.storage.session
    .set({
      "sw.state": currentState,
      "sw.tabId": activeTabId,
      "sw.overlayConfig": lastOverlayConfig,
      "sw.bootId": DIAG.bootId,
      "sw.updatedAt": Date.now()
    })
    .catch(() => {});
}

function mirrorError(error) {
  if (!error) {
    return chrome.storage.session.remove("sw.lastError").catch(() => {});
  }
  return chrome.storage.session.set({ "sw.lastError": error }).catch(() => {});
}

let offscreenMutex = Promise.resolve();
let creatingOffscreen = false;
let activeTabId = null;
let currentState = STATE.IDLE;
let lastOverlayConfig = null;
let lastTabMessageError = "";
let reportedOverlayAccessTab = null;
let startingSession = false;
let startEpoch = 0;
const OFFSCREEN_KEEP_WARM_MS = 5 * 60 * 1000;
let offscreenTeardownTimer = null;

function withOffscreenLock(task) {
  const run = offscreenMutex.then(task, task);
  offscreenMutex = run.then(() => {}, () => {});
  return run;
}

async function hydrateState() {
  try {
    const stored = await chrome.storage.session.get([
      "sw.state",
      "sw.tabId",
      "sw.overlayConfig"
    ]);
    if (stored["sw.overlayConfig"] && !lastOverlayConfig) {
      lastOverlayConfig = stored["sw.overlayConfig"];
    }
    if (currentState !== STATE.IDLE) return;

    const savedState = stored["sw.state"];
    const savedTabId = stored["sw.tabId"] ?? null;
    if (savedState && savedState !== STATE.IDLE) {
      if (await hasOffscreenDocument()) {
        activeTabId = savedTabId;
        currentState = savedState;
      } else if (savedState === STATE.ERROR) {
        currentState = STATE.ERROR;
        activeTabId = null;
      } else {
        currentState = STATE.IDLE;
        activeTabId = null;
        mirrorState();
      }
    }
  } catch {
    // Ignore storage failures during worker boot.
  }
}

const stateReady = hydrateState();

function scheduleOffscreenTeardown() {
  cancelOffscreenTeardown();
  if (chrome.alarms?.create) {
    chrome.alarms.create(OFFSCREEN_TEARDOWN_ALARM, {
      delayInMinutes: Math.max(1, OFFSCREEN_KEEP_WARM_MS / 60000)
    });
    return;
  }
  offscreenTeardownTimer = setTimeout(async () => {
    try {
      await stateReady;
      const live = await getLiveOffscreenStatus();
      if ((!live || (!live.hasSession && !live.starting && live.state === STATE.IDLE)) &&
          currentState === STATE.IDLE && !startingSession) {
        await closeOffscreenDocumentIfPresent({ onlyIfIdle: true });
      }
    } catch (err) {
      console.warn("[Offscreen] deferred teardown failed:", err);
    } finally {
      offscreenTeardownTimer = null;
    }
  }, OFFSCREEN_KEEP_WARM_MS);
}

function cancelOffscreenTeardown() {
  chrome.alarms?.clear?.(OFFSCREEN_TEARDOWN_ALARM)?.catch?.(() => {});
  if (offscreenTeardownTimer) {
    clearTimeout(offscreenTeardownTimer);
    offscreenTeardownTimer = null;
  }
}

chrome.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm?.name !== OFFSCREEN_TEARDOWN_ALARM) return;
  try {
    await stateReady;
    const live = await getLiveOffscreenStatus();
    if ((!live || (!live.hasSession && !live.starting && live.state === STATE.IDLE)) &&
        currentState === STATE.IDLE && !startingSession) {
      await closeOffscreenDocumentIfPresent({ onlyIfIdle: true });
    }
  } catch (err) {
    console.warn("[Offscreen] deferred teardown failed:", err);
  }
});

async function getOffscreenContexts() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  return chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
}

async function hasOffscreenDocument() {
  const existingContexts = await getOffscreenContexts();
  return existingContexts.length > 0;
}

function ensureOffscreenDocument() {
  return withOffscreenLock(async () => {
    const existingContexts = await getOffscreenContexts();
    if (existingContexts.length > 0) {
      return;
    }
    creatingOffscreen = true;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
        justification: "Capture shared tab audio and stream it to live transcription."
      });
    } finally {
      creatingOffscreen = false;
    }
  });
}

function closeOffscreenDocumentIfPresent(options = {}) {
  return withOffscreenLock(async () => {
    if (options.onlyIfIdle && (currentState !== STATE.IDLE || startingSession)) {
      return;
    }
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  });
}

async function getLiveOffscreenStatus() {
  if (!(await hasOffscreenDocument())) {
    if (!startingSession && !creatingOffscreen &&
        currentState !== STATE.IDLE && currentState !== STATE.ERROR &&
        currentState !== STATE.CREATING_OFFSCREEN) {
      currentState = STATE.IDLE;
      activeTabId = null;
      await mirrorState();
    }
    return null;
  }

  try {
    const status = await chrome.runtime.sendMessage({
      type: MSG.GET_STATUS,
      target: "offscreen"
    });

    if (!status?.ok) {
      return null;
    }

    currentState = status.state || currentState;
    activeTabId = status.tabId || activeTabId;
    if (!status.hasSession && !status.starting && currentState === STATE.IDLE) {
      activeTabId = null;
    }
    mirrorState();
    return status;
  } catch {
    return null;
  }
}

function getOverlayConfig(config) {
  return {
    lines: config.lines,
    fontSize: config.fontSize,
    opacity: config.opacity,
    showInterim: config.showInterim
  };
}

async function injectContentScript(tabId) {
  try {
    await Promise.all([
      OVERLAY_CSS
        ? chrome.scripting.insertCSS({ target: { tabId }, css: OVERLAY_CSS }).catch(() => {})
        : Promise.resolve(),
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["constants.js", "contentScript.js"]
      })
    ]);
  } catch (error) {
    throw new Error(`Unable to inject subtitle overlay: ${error.message}`);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    lastTabMessageError = "";
    return true;
  } catch (error) {
    lastTabMessageError = error.message;
    return false;
  }
}

async function ensureOverlayAndSend(tabId, message) {
  let delivered = await sendToTab(tabId, message);
  if (delivered) {
    return;
  }

  await injectContentScript(tabId);
  if (lastOverlayConfig) {
    await sendToTab(tabId, {
      type: MSG.APPLY_SETTINGS,
      config: lastOverlayConfig
    });
  }
  delivered = await sendToTab(tabId, message);

  if (!delivered) {
    const suffix = lastTabMessageError ? ` ${lastTabMessageError}` : "";
    throw new Error(`Subtitle overlay is unavailable in the target tab.${suffix}`);
  }
}

async function startSession({ tabId, config }) {
  await stateReady;
  cancelOffscreenTeardown();
  if (startingSession) {
    return {
      ok: false,
      error: "A start is already in progress. Click Stop, then start again."
    };
  }
  startingSession = true;
  const myStartEpoch = ++startEpoch;

  try {
    const liveStatus = await getLiveOffscreenStatus();
    if (startEpoch !== myStartEpoch) {
      return { ok: false, error: "Session start was cancelled." };
    }
    if (liveStatus?.hasSession && liveStatus.state !== STATE.IDLE && liveStatus.state !== STATE.ERROR) {
      return {
        ok: false,
        error: "A session is already running. Click Stop, then start again."
      };
    }

    // Only close if corrupted in error state; keep warm document alive
    if (currentState === STATE.ERROR || liveStatus?.state === STATE.ERROR) {
      await closeOffscreenDocumentIfPresent();
      if (startEpoch !== myStartEpoch) {
        return { ok: false, error: "Session start was cancelled." };
      }
      activeTabId = null;
      currentState = STATE.IDLE;
      await mirrorState();
    }

    if (currentState !== STATE.IDLE) {
      return {
        ok: false,
        error: "A session is already running. Click Stop, then start again."
      };
    }

    const overlayConfig = getOverlayConfig(config);

    await mirrorError(null);
    reportedOverlayAccessTab = null;
    activeTabId = tabId;
    lastOverlayConfig = overlayConfig;
    currentState = STATE.CREATING_OFFSCREEN;
    await mirrorState();

    try {
      await Promise.all([
        ensureOverlayAndSend(tabId, {
          type: MSG.CLEAR_ALL,
          config: overlayConfig
        }),
        ensureOffscreenDocument()
      ]);

      if (startEpoch !== myStartEpoch) {
        if (currentState === STATE.CREATING_OFFSCREEN) {
          currentState = STATE.IDLE;
          activeTabId = null;
          await mirrorState();
          if (await hasOffscreenDocument().catch(() => false)) {
            scheduleOffscreenTeardown();
          }
        }
        return { ok: false, error: "Session start was cancelled." };
      }

      const startResp = await chrome.runtime.sendMessage({
        type: MSG.START,
        target: "offscreen",
        tabId,
        config
      });
      if (startResp && startResp.ok === false) {
        throw new Error(startResp.error || "Offscreen worker rejected start.");
      }
    } catch (error) {
      if (currentState === STATE.CREATING_OFFSCREEN) {
        currentState = STATE.IDLE;
        activeTabId = null;
        await mirrorState();
        if (await hasOffscreenDocument().catch(() => false)) {
          scheduleOffscreenTeardown();
        }
      }
      throw error;
    }

    return { ok: true };
  } finally {
    startingSession = false;
  }
}

async function stopSession() {
  startEpoch += 1;
  if (!(await hasOffscreenDocument())) {
    currentState = STATE.IDLE;
    activeTabId = null;
    await mirrorState();
    chrome.runtime.sendMessage({
      type: MSG.STATE,
      state: STATE.IDLE
    }).catch(() => {});
    return { ok: true };
  }

  await chrome.runtime.sendMessage({
    type: MSG.STOP,
    target: "offscreen"
  });
  return { ok: true };
}

// Collects the report from every context that still exists. The offscreen
// document is queried live but may already be gone (the error path closes it),
// so the mirrored copy in storage.session is what makes a post-mortem possible.
//
// Every step is isolated. A failing getContexts() or storage read must degrade
// one section, not reject the whole response, because the caller has no way to
// tell "the worker is broken" from "there is nothing to report".
async function collectDiagnostics() {
  await bootCountReady;

  let hasOffscreen = false;
  try {
    hasOffscreen = await hasOffscreenDocument();
  } catch (error) {
    DIAG.record("sw", "warn", `getContexts failed: ${error.message}`);
  }

  let offscreen = null;
  if (hasOffscreen) {
    try {
      offscreen = await chrome.runtime.sendMessage({
        type: MSG.GET_DIAGNOSTICS,
        target: "offscreen"
      });
    } catch (error) {
      DIAG.record("sw", "warn", `offscreen diagnostics unavailable: ${error.message}`);
    }
  }

  const stored = await chrome.storage.session
    .get(["sw.state", "sw.tabId", "sw.bootId", "sw.updatedAt", "sw.boots", "sw.lastError"])
    .catch((error) => {
      DIAG.record("sw", "warn", `session storage read failed: ${error.message}`);
      return {};
    });

  return {
    ok: true,
    serviceWorker: DIAG.snapshot(),
    offscreen: offscreen?.snapshot || null,
    offscreenStatus: offscreen?.status || null,
    hasOffscreen: Boolean(offscreen),
    stored: stored || {},
    workerBoots
  };
}

async function applySettings({ tabId, config }) {
  await stateReady;
  lastOverlayConfig = getOverlayConfig(config);
  mirrorState();

  const hasOffscreen = await hasOffscreenDocument().catch(() => false);
  if (hasOffscreen) {
    chrome.runtime.sendMessage({
      type: MSG.APPLY_SETTINGS,
      target: "offscreen",
      config
    }).catch(() => {});
  }

  // A running session owns the overlay. Before a session starts, update any
  // already-mounted overlay without forcing script injection or failing on hotword edits.
  if (activeTabId) {
    try {
      await ensureOverlayAndSend(activeTabId, {
        type: MSG.APPLY_SETTINGS,
        config: lastOverlayConfig
      });
    } catch (error) {
      if (!hasOffscreen) throw error;
    }
  } else if (tabId) {
    await sendToTab(tabId, {
      type: MSG.APPLY_SETTINGS,
      config: lastOverlayConfig
    });
  }

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") {
    return false;
  }

  const run = async () => {
    await stateReady;
    switch (message.type) {
      case MSG.ENSURE_OFFSCREEN:
        return {
          ok: true,
          exists: await hasOffscreenDocument()
        };

      case MSG.START_SESSION:
        return startSession(message);

      case MSG.STOP_SESSION:
        return stopSession();

      case MSG.APPLY_SETTINGS:
        return applySettings(message);

      case MSG.RESET_OVERLAY: {
        const targetTabId = activeTabId || message.tabId;
        if (targetTabId) {
          await ensureOverlayAndSend(targetTabId, { type: MSG.RESET_OVERLAY });
        }
        return { ok: true };
      }

      case MSG.GET_STATUS: {
        await getLiveOffscreenStatus();
        let lastError = null;
        if (currentState === STATE.ERROR) {
          const stored = await chrome.storage.session.get("sw.lastError").catch(() => ({}));
          lastError = stored["sw.lastError"] || null;
        }
        return {
          ok: true,
          state: currentState,
          tabId: activeTabId,
          lastError
        };
      }

      case MSG.GET_DIAGNOSTICS:
        return collectDiagnostics();

      case MSG.OFFSCREEN_STATE:
        // Never allow a late STOPPING state transition to overwrite ERROR.
        if (currentState === STATE.ERROR && message.state === STATE.STOPPING) {
          return { ok: true };
        }
        currentState = message.state;
        if (message.state === STATE.IDLE) {
          activeTabId = null;
          scheduleOffscreenTeardown();
        } else {
          cancelOffscreenTeardown();
        }
        await mirrorState();
        if (message.state === STATE.ERROR) {
          await closeOffscreenDocumentIfPresent();
        }
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: message.state
        }).catch(() => {});
        return { ok: true };

      case MSG.OFFSCREEN_ERROR: {
        cancelOffscreenTeardown();
        currentState = STATE.ERROR;
        activeTabId = null;
        // Mirror error/state and close offscreen BEFORE broadcasting ERROR to
        // popup so a quick user retry sees the closed document cleanly.
        const failure = {
          code: message.code || "UNKNOWN",
          message: message.message || "",
          t: Date.now()
        };
        DIAG.attachError(failure.code, failure.message);
        await mirrorError(failure);
        await mirrorState();
        await closeOffscreenDocumentIfPresent();
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: STATE.ERROR
        }).catch(() => {});
        chrome.runtime.sendMessage({
          type: MSG.ERROR,
          code: message.code,
          message: message.message
        }).catch(() => {});
        return { ok: true };
      }

      case MSG.OFFSCREEN_TRANSCRIPT:
        if (!message.tabId) return { ok: false, error: "No target tab." };
        try {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.DG_TRANSCRIPT,
            action: message.event.action,
            lineId: message.event.lineId,
            isFinal: message.event.isFinal,
            text: message.event.text,
            tail: message.event.tail,
            ts: message.event.ts,
            telemetry: message.event.telemetry
          });
          reportedOverlayAccessTab = null;
        } catch (error) {
          if (reportedOverlayAccessTab !== message.tabId) {
            reportedOverlayAccessTab = message.tabId;
            DIAG.record("sw", "warn", `overlay delivery failed for tab ${message.tabId}: ${error.message}`);
          }
          return { ok: false, error: error.message };
        }
        return { ok: true };

      case MSG.OFFSCREEN_CLEAR_INTERIM:
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.CLEAR_INTERIM
          }).catch(() => {});
        }
        return { ok: true };

      case MSG.OFFSCREEN_CLEAR_ALL:
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.CLEAR_ALL
          });
        }
        return { ok: true };

      default:
        return { ok: false, error: "Unknown message type." };
    }
  };

  run()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  await stateReady;
  if (tabId !== activeTabId || currentState === STATE.IDLE || currentState === STATE.ERROR) {
    return;
  }

  injectContentScript(tabId)
    .then(() => {
      if (!lastOverlayConfig) {
        return null;
      }
      return sendToTab(tabId, {
        type: MSG.APPLY_SETTINGS,
        config: lastOverlayConfig
      });
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateReady;
  if (tabId === activeTabId) {
    activeTabId = null;
    await mirrorState();
  }
});
