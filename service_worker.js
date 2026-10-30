import "./constants.js";

const { MSG, STATE } = globalThis.HIANIME;
const OFFSCREEN_DOCUMENT = "offscreen.html";

let creatingOffscreen = null;
let activeTabId = null;
let currentState = STATE.IDLE;
let lastOverlayConfig = null;
let lastTabMessageError = "";
const OFFSCREEN_KEEP_WARM_MS = 5 * 60 * 1000;
let offscreenTeardownTimer = null;

function scheduleOffscreenTeardown() {
  cancelOffscreenTeardown();
  offscreenTeardownTimer = setTimeout(async () => {
    try {
      if (currentState === STATE.IDLE) {
        await closeOffscreenDocumentIfPresent();
      }
    } catch (err) {
      // The ERROR path may have closed the document between the existence check
      // and closeDocument(). Do not leave an unhandled rejection in the worker.
      console.warn("[Offscreen] deferred teardown failed:", err);
    } finally {
      offscreenTeardownTimer = null;
    }
  }, OFFSCREEN_KEEP_WARM_MS);
}

function cancelOffscreenTeardown() {
  if (offscreenTeardownTimer) {
    clearTimeout(offscreenTeardownTimer);
    offscreenTeardownTimer = null;
  }
}

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

async function ensureOffscreenDocument() {
  const existingContexts = await getOffscreenContexts();
  if (existingContexts.length > 0) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: "Capture shared tab audio and stream it to live transcription."
    });
  }

  // Stale-promise guard: if createDocument() rejects, `creatingOffscreen` must
  // be cleared or every later start re-awaits the rejected promise instead of
  // retrying, until the service worker itself is terminated. The identity
  // check keeps concurrent callers sharing one creation promise to null it
  // exactly once (the winner, so a later set by a renewed caller survives).
  const creation = creatingOffscreen;
  try {
    await creation;
  } finally {
    if (creatingOffscreen === creation) {
      creatingOffscreen = null;
    }
  }
}

async function closeOffscreenDocumentIfPresent() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function getLiveOffscreenStatus() {
  if (!(await hasOffscreenDocument())) {
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
    if (!status.hasSession && currentState === STATE.IDLE) {
      activeTabId = null;
    }
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["constants.js", "contentScript.js"]
    });
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
  cancelOffscreenTeardown();
  const liveStatus = await getLiveOffscreenStatus();
  if (liveStatus?.hasSession && liveStatus.state !== STATE.IDLE && liveStatus.state !== STATE.ERROR) {
    return {
      ok: false,
      error: "A session is already running. Click Stop, then start again."
    };
  }

  // Only close if corrupted in error state; keep warm document alive
  if (currentState === STATE.ERROR || liveStatus?.state === STATE.ERROR) {
    await closeOffscreenDocumentIfPresent();
    activeTabId = null;
    currentState = STATE.IDLE;
  }

  if (currentState !== STATE.IDLE) {
    return {
      ok: false,
      error: "A session is already running. Click Stop, then start again."
    };
  }

  const overlayConfig = getOverlayConfig(config);

  activeTabId = tabId;
  lastOverlayConfig = overlayConfig;
  currentState = STATE.CREATING_OFFSCREEN;

  try {
    await ensureOverlayAndSend(tabId, {
      type: MSG.CLEAR_ALL
    });
    await ensureOverlayAndSend(tabId, {
      type: MSG.APPLY_SETTINGS,
      config: overlayConfig
    });
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: MSG.START,
      target: "offscreen",
      tabId,
      config
    });
  } catch (error) {
    // Without this reset the state stays CREATING_OFFSCREEN after a failed
    // injection or offscreen creation, and every later Start is refused as
    // "already running" — with no offscreen document to even stop. The popup
    // still receives the error through the run().catch response path.
    currentState = STATE.IDLE;
    activeTabId = null;
    throw error;
  }

  return { ok: true };
}

async function stopSession() {
  if (!(await hasOffscreenDocument())) {
    currentState = STATE.IDLE;
    activeTabId = null;
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

async function applySettings({ tabId, config }) {
  lastOverlayConfig = config;
  // A running session owns the overlay. The popup's tab is only the fallback
  // before a session starts; preferring it would inject an idle overlay into
  // whatever tab the popup happens to be on and leave the transcribed tab stale.
  const targetTabId = activeTabId || tabId;

  if (targetTabId) {
    await ensureOverlayAndSend(targetTabId, {
      type: MSG.APPLY_SETTINGS,
      config
    });
  }

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") {
    return false;
  }

  const run = async () => {
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

      case MSG.GET_STATUS:
        await getLiveOffscreenStatus();
        return {
          ok: true,
          state: currentState,
          tabId: activeTabId
        };

      case MSG.OFFSCREEN_STATE:
        currentState = message.state;
        if (message.state === STATE.IDLE) {
          activeTabId = null;
          scheduleOffscreenTeardown();
        } else {
          cancelOffscreenTeardown();
        }
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: message.state
        }).catch(() => {});
        if (message.state === STATE.ERROR) {
          await closeOffscreenDocumentIfPresent();
        }
        return { ok: true };

      case MSG.OFFSCREEN_ERROR:
        cancelOffscreenTeardown();
        currentState = STATE.ERROR;
        activeTabId = null;
        chrome.runtime.sendMessage({
          type: MSG.STATE,
          state: STATE.ERROR
        }).catch(() => {});
        chrome.runtime.sendMessage({
          type: MSG.ERROR,
          code: message.code,
          message: message.message
        }).catch(() => {});
        await closeOffscreenDocumentIfPresent();
        return { ok: true };

      case MSG.OFFSCREEN_TRANSCRIPT:
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
        return { ok: true };

      case MSG.OFFSCREEN_CLEAR_INTERIM:
        if (message.tabId) {
          await ensureOverlayAndSend(message.tabId, {
            type: MSG.CLEAR_INTERIM
          });
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId || changeInfo.status !== "complete" || currentState === STATE.IDLE) {
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
