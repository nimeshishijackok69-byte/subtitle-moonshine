(function () {
  const MSG = Object.freeze({
    ENSURE_OFFSCREEN: "ENSURE_OFFSCREEN",
    START_SESSION: "START_SESSION",
    STOP_SESSION: "STOP_SESSION",
    APPLY_SETTINGS: "APPLY_SETTINGS",
    GET_STATUS: "GET_STATUS",
    GET_DIAGNOSTICS: "GET_DIAGNOSTICS",
    START: "START",
    STOP: "STOP",
    STATE: "STATE",
    ERROR: "ERROR",
    OFFSCREEN_STATE: "OFFSCREEN_STATE",
    OFFSCREEN_ERROR: "OFFSCREEN_ERROR",
    OFFSCREEN_TRANSCRIPT: "OFFSCREEN_TRANSCRIPT",
    OFFSCREEN_CLEAR_INTERIM: "OFFSCREEN_CLEAR_INTERIM",
    OFFSCREEN_CLEAR_ALL: "OFFSCREEN_CLEAR_ALL",
    DG_TRANSCRIPT: "DG_TRANSCRIPT",
    // Wire values for the committer's `action` field. These are the literal
    // strings offscreen.js sends and contentScript.js switches on.
    TRANSCRIPT_GROW: "GROW",
    TRANSCRIPT_REVISE: "REVISE",
    TRANSCRIPT_FINAL: "FINAL",
    TRANSCRIPT_INTERIM: "INTERIM",
    CLEAR_INTERIM: "CLEAR_INTERIM",
    CLEAR_ALL: "CLEAR_ALL",
    REMOVE_OVERLAY: "REMOVE_OVERLAY",
    RESET_OVERLAY: "RESET_OVERLAY",
    PCM_CHUNK: "PCM_CHUNK"
  });

  const STATE = Object.freeze({
    IDLE: "idle",
    CREATING_OFFSCREEN: "creating_offscreen",
    LOADING_VAD: "loading_vad",
    LOADING_MODEL: "loading_model",
    AWAITING_CAPTURE_PERMISSION: "awaiting_capture_permission",
    CAPTURING: "capturing",
    LISTENING: "listening",
    STOPPING: "stopping",
    ERROR: "error"
  });

  const OVERLAY_CSS = `
    #dg-live-subtitle-overlay {
      --dg-styled: 1;
      position: fixed;
      left: 50%;
      right: auto;
      bottom: 6%;
      top: auto;
      transform: translateX(-50%);
      display: block;
      overflow: visible;
      opacity: 1;
      visibility: visible;
      contain: layout style;
      touch-action: none;
      z-index: 2147483647;
      pointer-events: auto;
      user-select: text;
      -webkit-user-select: text;
      direction: ltr;
      writing-mode: horizontal-tb;
      unicode-bidi: normal;
      font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
      font-style: normal;
      font-weight: 500;
      text-transform: none;
      text-decoration: none;
      text-indent: 0;
      word-spacing: normal;
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
      margin: 0;
      border: none;
      outline: none;
      padding: 10px 16px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.45);
      width: max-content;
      max-width: min(92vw, 1100px);
      min-width: 120px;
      line-height: 1.35;
      letter-spacing: 0.03em;
      white-space: pre-wrap;
      box-sizing: border-box;
      transition: opacity 120ms ease;
    }

    #dg-live-subtitle-overlay.dg-empty {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    #dg-live-subtitle-overlay .dg-toolbar {
      position: absolute;
      top: -36px;
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      display: flex;
      gap: 6px;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      padding-bottom: 14px;
      transition: opacity 120ms ease;
    }

    #dg-live-subtitle-overlay.dg-toolbar-bottom .dg-toolbar {
      top: auto;
      bottom: -36px;
      padding-bottom: 0;
      padding-top: 14px;
    }

    #dg-live-subtitle-overlay.dg-controls-open .dg-toolbar,
    #dg-live-subtitle-overlay.dg-dragging .dg-toolbar {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    #dg-live-subtitle-overlay.dg-empty .dg-toolbar {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    #dg-live-subtitle-overlay .dg-tool-button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      background: rgba(15, 18, 20, 0.92);
      color: #ffffff;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      padding: 6px 10px;
      text-shadow: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }

    #dg-live-subtitle-overlay .dg-tool-button:hover {
      background: rgba(35, 42, 48, 0.98);
      border-color: rgba(255, 255, 255, 0.5);
    }

    #dg-live-subtitle-overlay .dg-drag-handle {
      cursor: grab;
      touch-action: none;
    }

    #dg-live-subtitle-overlay.dg-dragging .dg-drag-handle {
      cursor: grabbing;
    }

    #dg-live-subtitle-overlay .dg-line-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
    }

    #dg-live-subtitle-overlay .dg-final-line {
      min-height: 1.35em;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
      pointer-events: auto;
      cursor: text;
    }

    #dg-live-subtitle-overlay .dg-interim-tail {
      color: #ffd54f;
      opacity: 0.95;
      font-style: italic;
    }
  `;

  globalThis.LIVE_SUBS = Object.freeze({
    MSG,
    STATE,
    OVERLAY_CSS
  });
})();
