(function () {
  const { MSG } = globalThis.LIVE_SUBS || {
    MSG: {
      APPLY_SETTINGS: "APPLY_SETTINGS",
      DG_TRANSCRIPT: "DG_TRANSCRIPT",
      CLEAR_INTERIM: "CLEAR_INTERIM",
      CLEAR_ALL: "CLEAR_ALL",
      REMOVE_OVERLAY: "REMOVE_OVERLAY"
    }
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
    drag: null,
    activeLineId: null,
    activeLineText: "",
    interimTail: "",
    finalizedLineId: null,
    dismissed: false
  };
  globalThis[STATE_KEY] = state;

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
        pointer-events: none;
        user-select: text;
        font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
        text-shadow:
          -2px -2px 0 #000,
           2px -2px 0 #000,
          -2px  2px 0 #000,
           2px  2px 0 #000,
           0   -2px 0 #000,
           0    2px 0 #000,
          -2px  0   0 #000,
           2px  0   0 #000,
           0    3px 6px rgba(0, 0, 0, 0.85);
        color: #ffffff;
        text-align: center;
        padding: 10px 16px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.45);
        max-width: min(92vw, 1100px);
        min-width: 240px;
        line-height: 1.35;
        letter-spacing: 0.03em;
        white-space: pre-wrap;
        box-sizing: border-box;
      }

      #${ROOT_ID} .dg-toolbar {
        position: absolute;
        top: -30px;
        right: 0;
        display: none;
        gap: 6px;
        pointer-events: auto;
        /* Extends the toolbar's own hit area down to the root's top edge.
           Without it there is an 8px dead band between them: the pointer leaves
           #ROOT, :hover drops, the toolbar hides, and the X becomes unhittable. */
        padding-bottom: 12px;
      }

      #${ROOT_ID}:hover .dg-toolbar {
        display: flex;
      }

      #${ROOT_ID} .dg-tool-button {
        border: none;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.7);
        color: #ffffff;
        font-size: 12px;
        padding: 4px 8px;
        cursor: pointer;
      }

      #${ROOT_ID} .dg-drag-handle {
        cursor: move;
      }

      #${ROOT_ID} .dg-line-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      #${ROOT_ID} .dg-final-line {
        min-height: 1.35em;
        pointer-events: auto;
      }

      #${ROOT_ID} .dg-interim-tail {
        color: #ffd54f;
        opacity: 0.95;
        font-style: italic;
      }
    `;

    document.head.appendChild(style);
  }

  function ensureRoot() {
    // A dismissed overlay stays dismissed until the next session starts
    // (CLEAR_ALL). Without this, every incoming transcript resurrects it.
    if (state.dismissed) {
      return null;
    }

    if (state.root && document.body.contains(state.root)) {
      return state.root;
    }

    // An overlay left behind by a previous injection (extension reload/update
    // while a session was live) has dead listeners. Drop it rather than adopt it,
    // otherwise two nodes share the id and one of them can never be closed.
    document.getElementById(ROOT_ID)?.remove();

    ensureStyle();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("lang", "ja");
    root.setAttribute("translate", "no");
    state.root = root;

    buildToolbar(root);
    document.body.appendChild(root);
    rebuildLineNodes();
    applySettings(state.settings);
    return root;
  }

  function buildToolbar(root) {
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
    state.settings.opacity = Number(state.settings.opacity) || defaults.opacity;
    state.settings.showInterim = Boolean(state.settings.showInterim);

    if (!state.root) return; // Guard: do not resurrect on settings update if user dismissed

    if (previousLineCount !== state.settings.lines) {
      state.finalLines = state.finalLines.slice(-state.settings.lines);
      rebuildLineNodes();
    }

    state.root.style.fontSize = `${state.settings.fontSize}px`;
    state.root.style.background = `rgba(0, 0, 0, ${state.settings.opacity})`;
    applyPosition();
    renderLines();
  }

  // The overlay is exactly `settings.lines` rows at all times. The active
  // utterance occupies the last row and carries its unstable tail inline, so a
  // sentence never straddles two rows and the box never gains or loses a row
  // mid-session. (A long row can still wrap to a second visual line.)
  function renderLines() {
    if (!state.root || !state.finalNodes.length) return;

    const showInterim = state.settings.showInterim;
    const rows = state.finalLines.map((text) => ({ text, tail: "" }));

    if (state.activeLineId && state.activeLineText) {
      rows.push({ text: state.activeLineText, tail: showInterim ? state.interimTail : "" });
    } else if (showInterim && state.interimTail) {
      // Before the first commit of an utterance the whole decode is tail.
      rows.push({ text: "", tail: state.interimTail });
    }

    const visible = rows.slice(-state.settings.lines);
    const blankCount = state.settings.lines - visible.length;

    for (let i = 0; i < state.finalNodes.length; i += 1) {
      setRowContent(state.finalNodes[i], visible[i - blankCount]);
    }
  }

  // Writes a row as [stable committed text][dimmed tail]. The tail span is
  // created once per row and reused, so a growing tail only touches text nodes.
  function setRowContent(node, row) {
    const text = row ? row.text : "";
    const tail = row ? row.tail : "";

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
    if (!cleanText) return;

    state.finalLines.push(cleanText);
    state.finalLines = state.finalLines.slice(-state.settings.lines);
    state.interimTail = "";
    renderLines();
  }

  function applyPosition() {
    if (!state.root || !state.position) return;
    state.root.style.left = `${state.position.left}px`;
    state.root.style.top = `${state.position.top}px`;
    state.root.style.bottom = "auto";
    state.root.style.transform = "none";
  }

  function startDrag(event) {
    if (!state.root) return;
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
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;

    const nextLeft = state.drag.left + event.clientX - state.drag.startX;
    const nextTop = state.drag.top + event.clientY - state.drag.startY;
    const maxLeft = window.innerWidth - state.drag.width - 8;
    const maxTop = window.innerHeight - state.drag.height - 8;

    state.position = {
      left: Math.max(8, Math.min(nextLeft, maxLeft)),
      top: Math.max(8, Math.min(nextTop, maxTop))
    };
    applyPosition();
  }

  function stopDrag(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
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
    state.activeLineId = null;
    state.activeLineText = "";
    state.dismissed = true;
  }

  // ─── High-Precision Telemetry Store & Analysis Harness ──────────────
  const telemetry = {
    records: [],
    maxRecords: 1000,
    nextId: 1,
    add(record) {
      record.id = this.nextId;
      this.nextId += 1;
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records.shift();
      }
    },
    reset() {
      this.records = [];
      this.nextId = 1;
    },
    getLogs() {
      return this.records;
    },
    getStats() {
      if (!this.records.length) return { message: "No telemetry records captured yet." };
      const finals = this.records.filter(r => r.isFinal);
      const num = (arr) => arr.filter(n => typeof n === "number").sort((a, b) => a - b);
      const p = (arr, q) => arr[Math.floor(arr.length * q)] ?? 0;
      const bucket = (arr) => ({
        p50: p(arr, 0.5),
        p90: p(arr, 0.9),
        p99: p(arr, 0.99),
        avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0
      });
      return {
        totalFinalLines: finals.length,
        asrComputeMs: bucket(num(finals.map(r => r.asrDurationMs))),
        // ASR start -> paint. Excludes how far behind real time the audio was.
        endToEndLatencyMs: bucket(num(finals.map(r => r.e2eLatencyMs))),
        // Backlog of the audio pipeline at decode time.
        audioLagMs: bucket(num(finals.map(r => r.audioLagMs))),
        // Sound uttered -> subtitle shown. The honest figure.
        soundToSubtitleMs: bucket(num(finals.map(r => r.soundToSubtitleMs)))
      };
    },
    exportCsv() {
      if (!this.records.length) return "";
      const headers = [
        "Index", "WallClock", "Text", "Action", "IsFinal", "AudioSeconds",
        "AsrDurationMs", "E2ELatencyMs", "AudioLagMs", "SoundToSubtitleMs"
      ];
      const rows = this.records.map(r => [
        r.id,
        `"${r.wallClock}"`,
        `"${(r.text || "").replace(/"/g, '""')}"`,
        r.action,
        r.isFinal,
        r.audioSeconds,
        r.asrDurationMs,
        r.e2eLatencyMs,
        r.audioLagMs,
        r.soundToSubtitleMs
      ]);
      return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
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
      URL.revokeObjectURL(url);
      console.log(`[Telemetry] Exported ${this.records.length} records to ${filename}`);
    }
  };
  window.__dgTelemetry = telemetry;
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
      state.finalLines = [];
      state.activeLineId = null;
      state.activeLineText = "";
      state.interimTail = "";
      state.finalizedLineId = null;
      state.dismissed = false;
      telemetry.reset();
      ensureRoot();
      renderLines();
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
      if (message.lineId && state.finalizedLineId === message.lineId && action !== ACTION.FINAL) {
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
        state.interimTail = state.settings.showInterim ? (message.tail != null ? message.tail : text) : "";
        renderLines();
      } else if (action === ACTION.FINAL) {
        if (message.lineId) state.finalizedLineId = message.lineId;
        state.activeLineId = null;
        state.activeLineText = "";
        state.interimTail = "";
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
})();
