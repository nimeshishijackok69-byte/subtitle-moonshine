(function () {
  const { MSG, OVERLAY_CSS } = globalThis.LIVE_SUBS || {
    MSG: {
      APPLY_SETTINGS: "APPLY_SETTINGS",
      DG_TRANSCRIPT: "DG_TRANSCRIPT",
      CLEAR_INTERIM: "CLEAR_INTERIM",
      CLEAR_ALL: "CLEAR_ALL",
      REMOVE_OVERLAY: "REMOVE_OVERLAY",
      RESET_OVERLAY: "RESET_OVERLAY"
    },
    OVERLAY_CSS: ""
  };

  // The committer's action vocabulary. Falling back to the literal keeps this
  // file working if constants.js failed to load, since the values are the wire
  // strings either way.
  const ACTION = {
    GROW: MSG.TRANSCRIPT_GROW || "GROW",
    REVISE: MSG.TRANSCRIPT_REVISE || "REVISE",
    INTERIM: MSG.TRANSCRIPT_INTERIM || "INTERIM",
    FINAL: MSG.TRANSCRIPT_FINAL || "FINAL"
  };

  // Both keys live on globalThis inside the extension's isolated world. Note:
  // string-keyed window flags (window.__foo) are reachable from the page's
  // DOM — an element like <div id="__dgLiveSubtitleBootstrapped"> makes
  // window named access truthy and could disable the overlay for the whole
  // tab. Symbol.for() keys are unreachable from page markup and preserve
  // state across re-injection.
  const BOOT_KEY = Symbol.for("dg-live-subtitle/bootstrapped");
  const STATE_KEY = Symbol.for("dg-live-subtitle/state");

  if (globalThis[BOOT_KEY]) {
    return;
  }
  globalThis[BOOT_KEY] = true;

  const ROOT_ID = "dg-live-subtitle-overlay";
  const STYLE_ID = "dg-live-subtitle-style";

  const defaults = {
    lines: 3,
    fontSize: 32,
    opacity: 0.45,
    showInterim: true
  };

  const state = globalThis[STATE_KEY] || {
    finalLines: [],
    settings: { ...defaults },
    root: null,
    lineGroup: null,
    finalNodes: [],
    position: null,
    positionEpoch: 0,
    drag: null,
    dragRaf: 0,
    dragPendingX: 0,
    dragPendingY: 0,
    activeLineId: null,
    activeLineText: "",
    interimTail: "",
    finalizedLineId: null,
    finalizedLineIds: new Set(),
    dismissed: false,
    pendingRender: false,
    controlsHideTimer: null,
    boxSize: { width: 0, height: 0, top: 0 },
    resizeObserver: null
  };
  if (!state.finalizedLineIds) state.finalizedLineIds = new Set();
  if (typeof state.positionEpoch !== "number") state.positionEpoch = 0;
  if (!state.boxSize) state.boxSize = { width: 0, height: 0, top: 0 };
  globalThis[STATE_KEY] = state;

  function isValidPosition(pos) {
    return Boolean(
      pos &&
      typeof pos === "object" &&
      Number.isFinite(pos.centerXRatio) &&
      Number.isFinite(pos.bottomPx)
    );
  }

  function loadSavedPosition() {
    const epochAtStart = state.positionEpoch;
    try {
      chrome.storage?.local?.get("overlay.position", (res) => {
        if (chrome.runtime?.lastError) return;
        const pos = res?.["overlay.position"];
        if (state.positionEpoch === epochAtStart && isValidPosition(pos) && !state.position) {
          state.position = { centerXRatio: pos.centerXRatio, bottomPx: pos.bottomPx };
          applyPosition();
        }
      });
    } catch {
      // Ignore storage errors in restricted contexts or unit shims.
    }
  }

  function savePosition(pos) {
    try {
      if (pos) {
        chrome.storage?.local?.set({ "overlay.position": pos });
      } else {
        chrome.storage?.local?.remove("overlay.position");
      }
    } catch {
      // Ignore storage errors in restricted contexts or unit shims.
    }
  }

  const UNRENDERED_FULLSCREEN_TAGS = new Set(["VIDEO", "IFRAME", "IMG", "CANVAS", "OBJECT", "EMBED"]);

  function getFullscreenElement() {
    let el = document.fullscreenElement || document.webkitFullscreenElement || null;
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.fullscreenElement || el.shadowRoot.webkitFullscreenElement;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function getMountInfo() {
    const fs = getFullscreenElement();
    if (fs) {
      if (UNRENDERED_FULLSCREEN_TAGS.has(fs.tagName)) {
        return { parent: document.documentElement || document.body, usePopover: true };
      }
      return { parent: fs, usePopover: false };
    }
    return { parent: document.body || document.documentElement, usePopover: false };
  }

  function ensureStyle() {
    if (!OVERLAY_CSS) return;
    if (state.root && typeof getComputedStyle === "function") {
      try {
        const cs = getComputedStyle(state.root);
        if (cs.getPropertyValue("--dg-styled")?.trim() === "1" && cs.position === "fixed") {
          return;
        }
      } catch {
        // Fall through to inline <style> injection when computed styles are unavailable.
      }
    }

    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      if (existing.textContent !== OVERLAY_CSS) {
        existing.textContent = OVERLAY_CSS;
      }
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = OVERLAY_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function applyFullscreenLayer(usePopover, promoteToTop = false) {
    if (!state.root) return;
    if (usePopover) {
      if (state.root.getAttribute("popover") !== "manual") {
        state.root.setAttribute("popover", "manual");
      }
      try {
        const isOpen = Boolean(state.root.matches?.(":popover-open"));
        if (promoteToTop && isOpen && typeof state.root.hidePopover === "function") {
          state.root.hidePopover();
        }
        if (typeof state.root.showPopover === "function" && (!isOpen || promoteToTop)) {
          state.root.showPopover();
        }
      } catch {
        // Ignore if Popover API is unsupported or blocked in test shims.
      }
      return;
    }
    if (state.root.hasAttribute("popover")) {
      try {
        if (typeof state.root.hidePopover === "function" && state.root.matches?.(":popover-open")) {
          state.root.hidePopover();
        }
      } catch {
        // Ignore.
      }
      state.root.removeAttribute("popover");
    }
  }

  function syncMountTarget() {
    if (!state.root) return;
    const { parent, usePopover } = getMountInfo();
    if (parent && state.root.parentNode !== parent) {
      parent.appendChild(state.root);
    }
    applyFullscreenLayer(usePopover, usePopover);
    applyPosition();
  }

  function attachResizeObserver(root) {
    if (state.resizeObserver) {
      try { state.resizeObserver.disconnect(); } catch {}
      state.resizeObserver = null;
    }
    if (typeof ResizeObserver !== "function" || !root) return;
    const ro = new ResizeObserver((entries) => {
      if (state.root !== root) return;
      const entry = entries[0];
      if (!entry) return;
      const border = entry.borderBoxSize?.[0];
      const w = border ? border.inlineSize : entry.contentRect.width;
      const h = border ? border.blockSize : entry.contentRect.height;
      state.boxSize.width = w;
      state.boxSize.height = h;
      applyPosition();
    });
    ro.observe(root);
    state.resizeObserver = ro;
  }

  function ensureRoot() {
    // A dismissed overlay stays dismissed until the next session starts
    // (CLEAR_ALL) or the user explicitly resets it (RESET_OVERLAY).
    if (state.dismissed) {
      return null;
    }

    const { parent, usePopover } = getMountInfo();
    if (state.root && parent && state.root.parentNode === parent) {
      applyFullscreenLayer(usePopover);
      return state.root;
    }

    if (state.root && document.contains(state.root)) {
      syncMountTarget();
      return state.root;
    }

    // An overlay left behind by a previous injection (extension reload/update
    // while a session was live) has dead listeners. Drop it rather than adopt it.
    document.getElementById(ROOT_ID)?.remove();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "dg-empty";
    root.setAttribute("lang", "ja");
    root.setAttribute("translate", "no");
    state.root = root;
    state.boxSize = { width: 0, height: 0, top: 0 };

    buildToolbar(root);
    parent.appendChild(root);
    ensureStyle();
    applyFullscreenLayer(usePopover);
    attachResizeObserver(root);
    rebuildLineNodes();
    applySettings(state.settings);
    return root;
  }

  function openControls() {
    if (!state.root) return;
    if (state.controlsHideTimer) {
      clearTimeout(state.controlsHideTimer);
      state.controlsHideTimer = null;
    }
    state.root.classList.add("dg-controls-open");
  }

  function scheduleCloseControls() {
    if (state.drag) return;
    if (state.controlsHideTimer) clearTimeout(state.controlsHideTimer);
    state.controlsHideTimer = setTimeout(() => {
      state.controlsHideTimer = null;
      if (state.drag || !state.root) return;
      state.root.classList.remove("dg-controls-open");
    }, 500);
  }

  function buildToolbar(root) {
    const toolbar = document.createElement("div");
    toolbar.className = "dg-toolbar";

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "dg-tool-button dg-drag-handle";
    dragHandle.textContent = "⠿ Move";
    dragHandle.title = "Drag to move (double-click to reset)";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "dg-tool-button";
    closeButton.textContent = "✕";
    closeButton.title = "Hide subtitles";

    toolbar.append(dragHandle, closeButton);
    root.appendChild(toolbar);

    root.addEventListener("pointerenter", openControls);
    root.addEventListener("pointerleave", scheduleCloseControls);
    toolbar.addEventListener("pointerenter", openControls);
    toolbar.addEventListener("pointerleave", scheduleCloseControls);

    // Allow dragging only from the dedicated handle or outer root padding so
    // clicks in the gap between lines still allow text selection / Yomitan lookup.
    root.addEventListener("pointerdown", (event) => {
      if (event.target === root) {
        startDrag(event);
      }
    });
    dragHandle.addEventListener("pointerdown", startDrag);
    dragHandle.addEventListener("dblclick", resetPosition);
    closeButton.addEventListener("click", removeOverlay);
  }

  function rebuildLineNodes() {
    const root = state.root;
    if (!root) return;

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
    renderLines();
  }

  function applySettings(config = {}) {
    const previousLineCount = state.settings.lines;
    state.settings = {
      ...state.settings,
      ...config
    };
    state.settings.lines = Math.max(1, Math.min(5, Number(state.settings.lines) || defaults.lines));
    state.settings.fontSize = Number(state.settings.fontSize) || defaults.fontSize;
    const nextOpacity = Number(state.settings.opacity);
    state.settings.opacity = Number.isFinite(nextOpacity) ? nextOpacity : defaults.opacity;
    state.settings.showInterim = Boolean(state.settings.showInterim);

    if (!state.root) return; // Guard: do not resurrect on settings update if user dismissed

    if (previousLineCount !== state.settings.lines) {
      state.finalLines = state.finalLines.slice(-state.settings.lines);
      rebuildLineNodes();
    }

    state.root.style.fontSize = `${state.settings.fontSize}px`;
    state.root.style.background = `rgba(0, 0, 0, ${state.settings.opacity})`;
    renderLines();
  }

  function hasActiveSelection() {
    if (!state.root || typeof window.getSelection !== "function") return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    return state.root.contains(sel.anchorNode) || state.root.contains(sel.focusNode);
  }

  // Only non-empty rows are shown; empty slots are hidden so the box shrinks to
  // fit active subtitles and collapses completely (click-through) when silent.
  function renderLines() {
    if (!state.root || !state.finalNodes.length) return;
    if (hasActiveSelection() && !state.drag) {
      state.pendingRender = true;
      return;
    }
    state.pendingRender = false;

    const showInterim = state.settings.showInterim;
    const rows = state.finalLines.map((text) => ({ text, tail: "" }));

    if (state.activeLineId && state.activeLineText) {
      rows.push({ text: state.activeLineText, tail: showInterim ? state.interimTail : "" });
    } else if (showInterim && state.interimTail) {
      // Before the first commit of an utterance the whole decode is tail.
      rows.push({ text: "", tail: state.interimTail });
    }

    const visible = rows.slice(-state.settings.lines);
    const isEmpty = visible.length === 0 && !state.drag;
    if (isEmpty && state.root.classList.contains("dg-controls-open")) {
      state.root.classList.remove("dg-controls-open");
    }
    state.root.classList.toggle("dg-empty", isEmpty);

    for (let i = 0; i < state.finalNodes.length; i += 1) {
      const node = state.finalNodes[i];
      const row = visible[i];
      const nextDisplay = row ? "" : "none";
      if (node._dgDisplay !== nextDisplay) {
        node.style.display = nextDisplay;
        node._dgDisplay = nextDisplay;
      }
      setRowContent(node, row);
    }

    if (typeof ResizeObserver !== "function" || state.position) {
      applyPosition();
    }
  }

  // Writes a row as [stable committed text][dimmed tail]. The tail span is
  // created once per row and reused, so a growing tail only touches text nodes.
  function setRowContent(node, row) {
    const text = row ? row.text : "";
    const tail = row ? row.tail : "";
    if (node._dgText === text && node._dgTail === tail && Boolean(node.lastElementChild) === Boolean(tail)) {
      return;
    }
    node._dgText = text;
    node._dgTail = tail;

    if (!tail) {
      // textContent includes the span's text, so a finalized line whose text
      // equals committed+tail would compare equal and keep the span. The element
      // check is what actually removes it.
      if (node.lastElementChild || node.textContent !== text) node.textContent = text;
      return;
    }

    let tailNode = node.lastElementChild;
    if (!tailNode || !tailNode.classList.contains("dg-interim-tail")) {
      node.textContent = "";
      tailNode = document.createElement("span");
      tailNode.className = "dg-interim-tail";
      node.append(document.createTextNode(""), tailNode);
    }

    const stable = node.firstChild;
    if (stable.nodeValue !== text) stable.nodeValue = text;
    if (tailNode.textContent !== tail) tailNode.textContent = tail;
  }

  function commitFinal(text) {
    const cleanText = text.trim();
    if (cleanText) {
      state.finalLines.push(cleanText);
      state.finalLines = state.finalLines.slice(-state.settings.lines);
    }
    renderLines();
  }

  function getCachedBoxSize() {
    if (typeof ResizeObserver === "function" && (state.boxSize.width > 0 || state.boxSize.height > 0)) {
      return state.boxSize;
    }
    const rect = state.root.getBoundingClientRect ? state.root.getBoundingClientRect() : { width: 0, height: 0, top: 0 };
    state.boxSize.width = rect.width || 0;
    state.boxSize.height = rect.height || 0;
    state.boxSize.top = rect.top || 0;
    return state.boxSize;
  }

  function applyPosition() {
    if (!state.root) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const rect = getCachedBoxSize();

    if (!isValidPosition(state.position)) {
      state.position = null;
      state.root.style.left = "";
      state.root.style.top = "";
      state.root.style.bottom = "";
      state.root.style.transform = "";
      const estTop = rect.top || (vh * 0.94 - (rect.height || 0));
      state.root.classList.toggle("dg-toolbar-bottom", rect.height > 0 && estTop >= 0 && estTop < 40);
      return;
    }

    const halfW = (rect.width || 0) / 2;
    const minCenter = Math.min(vw / 2, halfW + 8);
    const maxCenter = Math.max(vw / 2, vw - halfW - 8);
    const centerX = Math.max(minCenter, Math.min(state.position.centerXRatio * vw, maxCenter));
    const maxBottom = Math.max(8, vh - (rect.height || 0) - 8);
    const bottom = Math.max(8, Math.min(state.position.bottomPx, maxBottom));

    state.position.bottomPx = bottom;
    state.root.style.left = `${centerX}px`;
    state.root.style.bottom = `${bottom}px`;
    state.root.style.top = "auto";
    state.root.style.transform = "translateX(-50%)";

    const topEdge = vh - bottom - (rect.height || 0);
    state.root.classList.toggle("dg-toolbar-bottom", topEdge < 40);
  }

  function resetPosition() {
    state.positionEpoch += 1;
    state.position = null;
    savePosition(null);
    applyPosition();
  }

  function flushPendingDragFrame() {
    if (state.dragRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.dragRaf);
    }
    state.dragRaf = 0;
    if (!state.drag) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const nextCenterX = state.drag.centerX + (state.dragPendingX - state.drag.startX);
    const nextBottom = state.drag.bottomPx - (state.dragPendingY - state.drag.startY);
    const maxBottom = Math.max(8, vh - (state.drag.boxHeight || 0) - 8);

    state.positionEpoch += 1;
    state.position = {
      centerXRatio: Math.max(0, Math.min(1, nextCenterX / Math.max(1, vw))),
      bottomPx: Math.max(8, Math.min(nextBottom, maxBottom))
    };
    applyPosition();
  }

  function cancelDrag(persist) {
    if (!state.drag) return;
    if (state.dragRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.dragRaf);
    }
    state.dragRaf = 0;
    const { pointerId, captureTarget } = state.drag;
    try {
      captureTarget?.releasePointerCapture?.(pointerId);
    } catch {
      // Ignore if capture was already released.
    }
    state.drag = null;
    state.root?.classList.remove("dg-dragging");
    window.removeEventListener("pointermove", dragOverlay, true);
    window.removeEventListener("pointerup", stopDrag, true);
    window.removeEventListener("pointercancel", stopDrag, true);
    window.removeEventListener("blur", cancelActiveDrag);
    if (persist && isValidPosition(state.position)) {
      savePosition(state.position);
    }
  }

  function cancelActiveDrag() {
    if (!state.drag) return;
    cancelDrag(true);
    scheduleCloseControls();
    renderLines();
  }

  function startDrag(event) {
    if (!state.root || state.drag) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    openControls();

    const rect = state.root.getBoundingClientRect();
    state.boxSize.width = rect.width || 0;
    state.boxSize.height = rect.height || 0;
    state.boxSize.top = rect.top || 0;
    const vh = window.innerHeight || 720;
    const captureTarget = event.currentTarget || state.root;
    try {
      captureTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore synthetic events in tests without active pointer IDs.
    }

    state.drag = {
      pointerId: event.pointerId,
      captureTarget,
      startX: event.clientX,
      startY: event.clientY,
      centerX: rect.left + rect.width / 2,
      bottomPx: vh - rect.bottom,
      boxHeight: rect.height || 0
    };
    state.dragPendingX = event.clientX;
    state.dragPendingY = event.clientY;
    state.root.classList.add("dg-dragging");
    state.root.classList.remove("dg-empty");

    window.addEventListener("pointermove", dragOverlay, true);
    window.addEventListener("pointerup", stopDrag, true);
    window.addEventListener("pointercancel", stopDrag, true);
    window.addEventListener("blur", cancelActiveDrag);
  }

  function dragOverlay(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    state.dragPendingX = event.clientX;
    state.dragPendingY = event.clientY;
    if (typeof requestAnimationFrame === "function") {
      if (!state.dragRaf) {
        state.dragRaf = requestAnimationFrame(flushPendingDragFrame);
      }
    } else {
      flushPendingDragFrame();
    }
  }

  function stopDrag(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    flushPendingDragFrame();
    cancelDrag(true);
    scheduleCloseControls();
    renderLines();
  }

  function removeOverlay() {
    cancelDrag(false);
    if (state.resizeObserver) {
      try { state.resizeObserver.disconnect(); } catch {}
      state.resizeObserver = null;
    }
    if (state.controlsHideTimer) {
      clearTimeout(state.controlsHideTimer);
      state.controlsHideTimer = null;
    }
    if (state.root?.hasAttribute?.("popover")) {
      try {
        state.root.hidePopover?.();
      } catch {
        // Ignore.
      }
    }
    state.root?.remove();
    state.root = null;
    state.lineGroup = null;
    state.finalNodes = [];
    state.activeLineId = null;
    state.activeLineText = "";
    state.interimTail = "";
    state.dismissed = true;
  }

  document.addEventListener("fullscreenchange", syncMountTarget);
  document.addEventListener("webkitfullscreenchange", syncMountTarget);
  window.addEventListener("resize", () => {
    state.boxSize = { width: 0, height: 0, top: 0 };
    applyPosition();
  });
  window.addEventListener("blur", () => {
    if (state.pendingRender) {
      renderLines();
    }
  });
  document.addEventListener("selectionchange", () => {
    if (state.pendingRender && !hasActiveSelection()) {
      renderLines();
    }
  });

  // ─── High-Precision Telemetry Store & Analysis Harness ──────────────
  function sanitizeCsvCell(val) {
    const str = String(val ?? "");
    const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  const TELEMETRY_CAP = 1000;
  const telemetry = {
    buf: new Array(TELEMETRY_CAP),
    head: 0,
    count: 0,
    nextId: 1,
    add(record) {
      record.id = this.nextId;
      this.nextId += 1;
      const idx = (this.head + this.count) % TELEMETRY_CAP;
      if (this.count < TELEMETRY_CAP) {
        this.count += 1;
      } else {
        this.head = (this.head + 1) % TELEMETRY_CAP;
      }
      this.buf[idx] = record;
    },
    reset() {
      this.buf = new Array(TELEMETRY_CAP);
      this.head = 0;
      this.count = 0;
      this.nextId = 1;
    },
    getLogs() {
      const out = new Array(this.count);
      for (let i = 0; i < this.count; i += 1) {
        out[i] = this.buf[(this.head + i) % TELEMETRY_CAP];
      }
      return out;
    },
    getStats() {
      const records = this.getLogs();
      if (!records.length) return { message: "No telemetry records captured yet." };
      const finals = records.filter((r) => r.isFinal);
      const num = (arr) => arr.filter((n) => typeof n === "number").sort((a, b) => a - b);
      const p = (arr, q) => arr[Math.floor(arr.length * q)] ?? 0;
      const bucket = (arr) => ({
        p50: p(arr, 0.5),
        p90: p(arr, 0.9),
        p99: p(arr, 0.99),
        avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0
      });
      return {
        totalFinalLines: finals.length,
        asrComputeMs: bucket(num(finals.map((r) => r.asrDurationMs))),
        endToEndLatencyMs: bucket(num(finals.map((r) => r.e2eLatencyMs))),
        audioLagMs: bucket(num(finals.map((r) => r.audioLagMs))),
        soundToSubtitleMs: bucket(num(finals.map((r) => r.soundToSubtitleMs)))
      };
    },
    exportCsv() {
      const records = this.getLogs();
      if (!records.length) return "";
      const headers = [
        "Index", "WallClock", "Text", "Action", "IsFinal", "AudioSeconds",
        "AsrDurationMs", "E2ELatencyMs", "AudioLagMs", "SoundToSubtitleMs"
      ];
      const rows = records.map((r) => [
        r.id,
        sanitizeCsvCell(r.wallClock),
        sanitizeCsvCell(r.text || ""),
        sanitizeCsvCell(r.action),
        r.isFinal,
        r.audioSeconds,
        r.asrDurationMs,
        r.e2eLatencyMs,
        r.audioLagMs,
        r.soundToSubtitleMs
      ]);
      return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    },
    downloadCsv(filename = "subtitle_live_telemetry.csv") {
      const csv = this.exportCsv();
      if (!csv) {
        console.warn("[Telemetry] No records to export.");
        return;
      }
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      console.log(`[Telemetry] Exported ${this.count} records to ${filename}`);
    }
  };
  Object.defineProperty(window, "__dgTelemetry", {
    value: telemetry,
    writable: false,
    configurable: true,
    enumerable: true
  });
  // No page-main-world bridge on purpose: an inline page script exposing
  // getStats/downloadCsv is readable by every page script, so it would hand
  // pages a page-triggered download capability into the user's Downloads
  // folder. Inspect the isolated world ("JavaScript context: Extension")
  // in DevTools for stats; nothing here is exposed page-side.

  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) return;

    if (message.type === MSG.REMOVE_OVERLAY) {
      removeOverlay();
      return;
    }

    if (message.type === MSG.RESET_OVERLAY) {
      cancelDrag(false);
      state.dismissed = false;
      state.positionEpoch += 1;
      state.position = null;
      savePosition(null);
      ensureRoot();
      applySettings(state.settings);
      return;
    }

    if (message.type === MSG.APPLY_SETTINGS) {
      applySettings(message.config);
      return;
    }

    if (message.type === MSG.CLEAR_INTERIM) {
      state.interimTail = "";
      state.activeLineId = null;
      state.activeLineText = "";
      renderLines();
      return;
    }

    if (message.type === MSG.CLEAR_ALL) {
      cancelDrag(false);
      if (hasActiveSelection()) {
        try {
          window.getSelection?.()?.removeAllRanges?.();
        } catch {
          // Ignore.
        }
      }
      state.finalLines = [];
      state.activeLineId = null;
      state.activeLineText = "";
      state.interimTail = "";
      state.finalizedLineId = null;
      state.finalizedLineIds.clear();
      state.dismissed = false;
      telemetry.reset();
      ensureRoot();
      if (message.config) {
        applySettings(message.config);
      } else {
        renderLines();
      }
      return;
    }

    if (message.type === MSG.DG_TRANSCRIPT) {
      ensureRoot();
      const text = message.text || "";
      const action = message.action || (message.isFinal ? ACTION.FINAL : ACTION.INTERIM);
      const lineId = message.lineId || "legacy";

      // A tick's INTERIM can still be in flight when the flush's FINAL lands,
      // because the ASR lock orders decodes but not the sends that follow them.
      // Once a line is final, nothing from that line may touch the overlay again.
      if (message.lineId &&
          (state.finalizedLineId === message.lineId || state.finalizedLineIds.has(message.lineId)) &&
          action !== ACTION.FINAL) {
        return;
      }

      // 1. Anchored In-Place Committer Model
      if (action === ACTION.GROW || action === ACTION.REVISE) {
        state.activeLineId = lineId;
        state.activeLineText = text;
        // If atomic tail is supplied, update committed prefix and interim tail together in one paint
        state.interimTail = state.settings.showInterim && message.tail != null ? message.tail : "";
        renderLines();
      } else if (action === ACTION.INTERIM) {
        if (message.lineId && state.activeLineId !== lineId) {
          state.activeLineId = lineId;
          state.activeLineText = "";
        }
        state.interimTail = state.settings.showInterim ? (message.tail != null ? message.tail : text) : "";
        renderLines();
      } else if (action === ACTION.FINAL) {
        if (message.lineId) {
          state.finalizedLineId = message.lineId;
          state.finalizedLineIds.add(message.lineId);
          if (state.finalizedLineIds.size > 32) {
            const oldest = state.finalizedLineIds.values().next().value;
            state.finalizedLineIds.delete(oldest);
          }
        }
        if (!state.activeLineId || !message.lineId || state.activeLineId === lineId) {
          state.activeLineId = null;
          state.activeLineText = "";
          state.interimTail = "";
        }
        commitFinal(text);
      } else {
        console.warn("[Overlay] unknown transcript action:", action);
      }

      // 2. Latency decomposition against the real audio clock.
      //    streamStartEpoch is the wall-clock instant that audio position 0 was
      //    captured, so `audioSeconds` is directly convertible to a wall-clock
      //    time: streamStartEpoch + audioSeconds*1000 is when that sound played.
      const nowEpoch = Date.now();
      const t = message.telemetry || {};
      const capturedAt = t.capturedAt ?? null;
      const streamStartEpoch = t.streamStartEpoch ?? null;
      const audioSeconds = t.audioSeconds ?? null;

      // ASR start -> overlay paint (transport + decode tail).
      const e2eLatencyMs = capturedAt != null ? Math.max(0, nowEpoch - capturedAt) : null;

      // How far behind real time the audio being decoded was when decoding
      // began. Anything above ~0 is pipeline backlog the user hears as lag.
      const audioLagMs =
        capturedAt != null && streamStartEpoch != null && audioSeconds != null
          ? Math.round(capturedAt - streamStartEpoch - audioSeconds * 1000)
          : null;

      // Sound uttered -> subtitle shown. The number the user actually feels.
      const soundToSubtitleMs =
        streamStartEpoch != null && audioSeconds != null
          ? Math.round(nowEpoch - streamStartEpoch - audioSeconds * 1000)
          : null;

      const record = {
        wallClock: t.wallClock || new Date().toLocaleTimeString(),
        text,
        action,
        isFinal: Boolean(message.isFinal),
        audioSeconds,
        asrDurationMs: t.asrDurationMs ?? null,
        e2eLatencyMs,
        audioLagMs,
        soundToSubtitleMs
      };
      telemetry.add(record);

      if (action === ACTION.FINAL) {
        // Text goes through %s as an argument, not the format string: ASR
        // output can contain %c/%s/%O and would consume the style arguments.
        console.log(
          "%c[ASR Final]%c \"%s\" %c| ASR: %sms | Sound→Subtitle: %sms (audio lag %sms) | Audio: %ss",
          "color: #00e676; font-weight: bold",
          "color: #ffffff; font-weight: 500",
          text,
          "color: #90caf9",
          record.asrDurationMs,
          record.soundToSubtitleMs,
          record.audioLagMs,
          record.audioSeconds
        );
      }
      return;
    }
  });

  ensureRoot();
  loadSavedPosition();
})();
