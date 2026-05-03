(function () {
  const { MSG } = globalThis.HIANIME || {
    MSG: {
      APPLY_SETTINGS: "APPLY_SETTINGS",
      DG_TRANSCRIPT: "DG_TRANSCRIPT",
      CLEAR_INTERIM: "CLEAR_INTERIM",
      CLEAR_ALL: "CLEAR_ALL",
      REMOVE_OVERLAY: "REMOVE_OVERLAY"
    }
  };

  if (window.__dgLiveSubtitleBootstrapped) {
    return;
  }
  window.__dgLiveSubtitleBootstrapped = true;

  const ROOT_ID = "dg-live-subtitle-overlay";
  const STYLE_ID = "dg-live-subtitle-style";

  const defaults = {
    lines: 3,
    fontSize: 32,
    opacity: 0.45,
    showInterim: true
  };

  const state = window.__dgLiveSubtitleState || {
    finalLines: [],
    settings: { ...defaults },
    root: null,
    lineGroup: null,
    finalNodes: [],
    interimNode: null,
    position: null,
    drag: null
  };
  window.__dgLiveSubtitleState = state;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 50%;
        bottom: 6%;
        transform: translateX(-50%);
        z-index: 2147483647;
        width: min(80vw, 760px);
        max-width: min(80vw, 980px);
        pointer-events: auto !important;
        -webkit-user-select: text !important;
        user-select: text !important;
        color: #ffffff;
        text-align: center;
        line-height: 1.35;
        white-space: pre-wrap;
        font-family: "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
        padding: 10px 16px;
        border-radius: 8px;
        box-sizing: border-box;
      }

      #${ROOT_ID}:hover .dg-toolbar,
      #${ROOT_ID} .dg-toolbar:focus-within {
        opacity: 1;
      }

      #${ROOT_ID} .dg-toolbar {
        position: absolute;
        top: -26px;
        right: 0;
        display: flex;
        gap: 4px;
        opacity: 0.18;
        transition: opacity 120ms ease;
      }

      #${ROOT_ID} .dg-tool-button {
        width: 22px;
        height: 22px;
        border: 0;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.62);
        color: #ffffff;
        cursor: pointer;
        font: 700 12px/1 "Segoe UI", Arial, sans-serif;
        -webkit-user-select: none !important;
        user-select: none !important;
      }

      #${ROOT_ID} .dg-drag-handle {
        cursor: move;
      }

      #${ROOT_ID} .dg-final-line,
      #${ROOT_ID} .dg-interim-line {
        min-height: 1.35em;
        overflow-wrap: anywhere;
        pointer-events: auto !important;
        -webkit-user-select: text !important;
        user-select: text !important;
        cursor: text;
      }

      #${ROOT_ID} .dg-final-line {
        opacity: 0.98;
        font-weight: 650;
      }

      #${ROOT_ID} .dg-interim-line {
        opacity: 0.72;
        font-style: italic;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureRoot() {
    ensureStyle();

    if (state.root?.isConnected) {
      return state.root;
    }

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-live", "polite");
      root.setAttribute("lang", "ja");
      root.setAttribute("translate", "no");
      (document.body || document.documentElement).appendChild(root);
    }

    state.root = root;
    attachOverlayControls(root);
    rebuildLineNodes();
    applySettings(state.settings);
    return root;
  }

  function attachOverlayControls(root) {
    if (root.querySelector(".dg-toolbar")) {
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "dg-toolbar";

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "dg-tool-button dg-drag-handle";
    dragHandle.textContent = "::";
    dragHandle.title = "Move subtitles";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "dg-tool-button";
    closeButton.textContent = "x";
    closeButton.title = "Remove subtitles";

    toolbar.append(dragHandle, closeButton);
    root.appendChild(toolbar);

    dragHandle.addEventListener("pointerdown", startDrag);
    closeButton.addEventListener("click", removeOverlay);
  }

  function rebuildLineNodes() {
    const root = state.root;
    if (!root) {
      return;
    }

    root.querySelectorAll(".dg-line-group").forEach((node) => node.remove());
    state.finalNodes = [];

    const lineGroup = document.createElement("div");
    lineGroup.className = "dg-line-group";
    lineGroup.setAttribute("lang", "ja");
    lineGroup.setAttribute("translate", "no");
    root.appendChild(lineGroup);
    state.lineGroup = lineGroup;

    for (let i = 0; i < state.settings.lines; i += 1) {
      const line = document.createElement("div");
      line.className = "dg-final-line";
      lineGroup.appendChild(line);
      state.finalNodes.push(line);
    }

    const interim = document.createElement("div");
    interim.className = "dg-interim-line";
    lineGroup.appendChild(interim);
    state.interimNode = interim;
    renderFinalLines();
  }

  function applySettings(config = {}) {
    ensureRoot();
    const previousLineCount = state.settings.lines;
    state.settings = {
      ...state.settings,
      ...config
    };
    state.settings.lines = 3;
    state.settings.fontSize = Number(state.settings.fontSize) || defaults.fontSize;
    state.settings.opacity = Number(state.settings.opacity) || defaults.opacity;
    state.settings.showInterim = Boolean(state.settings.showInterim);

    if (previousLineCount !== state.settings.lines) {
      state.finalLines = state.finalLines.slice(-state.settings.lines);
      rebuildLineNodes();
    }

    state.root.style.fontSize = `${state.settings.fontSize}px`;
    state.root.style.background = `rgba(0, 0, 0, ${state.settings.opacity})`;
    state.interimNode.style.display = state.settings.showInterim ? "block" : "none";
    applyPosition();
    renderFinalLines();
  }

  function renderFinalLines() {
    ensureRoot();
    const visible = state.finalLines.slice(-state.settings.lines);
    const blankCount = state.settings.lines - visible.length;

    for (let i = 0; i < state.finalNodes.length; i += 1) {
      const nextText = visible[i - blankCount] || "";
      if (state.finalNodes[i].textContent !== nextText) {
        state.finalNodes[i].textContent = nextText;
      }
    }
  }

  function commitFinal(text) {
    const cleanText = text.trim();
    if (!cleanText || state.finalLines[state.finalLines.length - 1] === cleanText) {
      return;
    }

    state.finalLines.push(cleanText);
    state.finalLines = state.finalLines.slice(-state.settings.lines);
    state.interimNode.textContent = "";
    renderFinalLines();
  }

  function renderInterim(text) {
    ensureRoot();
    const nextText = state.settings.showInterim ? text.trim() : "";
    if (state.interimNode.textContent !== nextText) {
      state.interimNode.textContent = nextText;
    }
  }

  function applyPosition() {
    if (!state.root || !state.position) {
      return;
    }

    state.root.style.left = `${state.position.left}px`;
    state.root.style.top = `${state.position.top}px`;
    state.root.style.bottom = "auto";
    state.root.style.transform = "none";
  }

  function startDrag(event) {
    ensureRoot();
    event.preventDefault();
    event.stopPropagation();

    const rect = state.root.getBoundingClientRect();
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };

    window.addEventListener("pointermove", dragOverlay, true);
    window.addEventListener("pointerup", stopDrag, true);
    window.addEventListener("pointercancel", stopDrag, true);
  }

  function dragOverlay(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) {
      return;
    }

    const nextLeft = state.drag.left + event.clientX - state.drag.startX;
    const nextTop = state.drag.top + event.clientY - state.drag.startY;
    const maxLeft = Math.max(0, window.innerWidth - state.drag.width);
    const maxTop = Math.max(0, window.innerHeight - state.drag.height);

    state.position = {
      left: Math.min(maxLeft, Math.max(0, nextLeft)),
      top: Math.min(maxTop, Math.max(0, nextTop))
    };
    applyPosition();
  }

  function stopDrag(event) {
    if (state.drag && event.pointerId !== state.drag.pointerId) {
      return;
    }

    state.drag = null;
    window.removeEventListener("pointermove", dragOverlay, true);
    window.removeEventListener("pointerup", stopDrag, true);
    window.removeEventListener("pointercancel", stopDrag, true);
  }

  function removeOverlay() {
    state.root?.remove();
    state.root = null;
    state.lineGroup = null;
    state.finalNodes = [];
    state.interimNode = null;
    state.finalLines = [];
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) {
      return;
    }

    ensureRoot();

    if (message.type === MSG.APPLY_SETTINGS) {
      applySettings(message.config);
      return;
    }

    if (message.type === MSG.DG_TRANSCRIPT) {
      if (message.isFinal) {
        commitFinal(message.text || "");
      } else {
        renderInterim(message.text || "");
      }
      return;
    }

    if (message.type === MSG.CLEAR_INTERIM) {
      state.interimNode.textContent = "";
      return;
    }

    if (message.type === MSG.CLEAR_ALL) {
      state.finalLines = [];
      state.interimNode.textContent = "";
      renderFinalLines();
      return;
    }

    if (message.type === MSG.REMOVE_OVERLAY) {
      removeOverlay();
    }
  });

  ensureRoot();
})();
