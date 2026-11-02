// Diagnostic capture shared by every extension context (service worker,
// offscreen document, popup). Loaded as a side-effect import in the worker and
// as a classic script in the two HTML pages, exactly like constants.js.
//
// Why a ring buffer instead of console history: MV3 kills the service worker
// after ~30 s idle, and the popup closes on blur, so by the time the user
// reports a problem the live console is gone. Everything here has to survive in
// memory per context, be serialisable across chrome.runtime.sendMessage
// (structured clone, no functions), and stay small enough that copying it is
// instant.
//
// Why capture the console instead of editing every call site: the useful
// evidence is usually a warning nobody thought to wrap, plus the two or three
// lines around it. Wrapping warn/error once per context collects all of it,
// including uncaught errors and unhandled rejections, at a bounded cost.
//
// The renderer is pure and takes an explicit list of sources, because the popup
// assembles the final report from three separate snapshots: it is the only
// context guaranteed to be alive when the user clicks Copy.
(function () {
  const REPORT_VERSION = 1;
  const MAX_EVENTS = 60;
  const MAX_EVENT_CHARS = 400;
  const MAX_REPORT_CHARS = 24000;

  const events = [];
  const fields = Object.create(null);
  const timings = Object.create(null);
  const transcriptTail = [];
  let lastError = null;
  let installed = false;
  let captureDepth = 0;
  const bootId = Math.random().toString(36).slice(2, 10);

  function clip(value, limit) {
    const text = String(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function render(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return clip(value, MAX_EVENT_CHARS);
    if (value === null || value === undefined) return String(value);
    try {
      return clip(JSON.stringify(value), MAX_EVENT_CHARS);
    } catch {
      return clip(Object.prototype.toString.call(value), MAX_EVENT_CHARS);
    }
  }

  function record(scope, level, message) {
    events.push({ t: Date.now(), scope, level, msg: clip(message, MAX_EVENT_CHARS) });
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
  }

  // Reentrancy guard: a throwing getter inside a logged object, or a console
  // call made while rendering, would otherwise recurse and fill the buffer with
  // its own noise instead of the evidence.
  function installConsoleCapture() {
    if (installed) return;
    installed = true;

    for (const level of ["warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        if (captureDepth === 0) {
          captureDepth += 1;
          try {
            record("console", level, args.map(render).join(" "));
          } finally {
            captureDepth -= 1;
          }
        }
        original(...args);
      };
    }

    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("error", (event) => {
        if (captureDepth !== 0) return;
        const where = event?.filename ? ` @ ${event.filename}:${event.lineno}` : "";
        record("window", "error", `${event?.message || "uncaught error"}${where}`);
      });
      globalThis.addEventListener("unhandledrejection", (event) => {
        if (captureDepth !== 0) return;
        record("window", "error", `unhandled rejection: ${render(event?.reason)}`);
      });
    }
    record("diag", "info", `capture installed (boot ${bootId})`);
  }

  function set(name, value) {
    fields[name] = value;
  }

  function bump(name, delta) {
    fields[name] = (Number(fields[name]) || 0) + (delta === undefined ? 1 : delta);
  }

  // Duration summary per call site: count, last, mean, max. A mean alone hides
  // the one stall that actually caused dropped audio.
  function sample(name, ms) {
    const bucket = timings[name] || (timings[name] = { count: 0, last: 0, sum: 0, max: 0 });
    bucket.count += 1;
    bucket.last = ms;
    bucket.sum += ms;
    if (ms > bucket.max) bucket.max = ms;
  }

  function mark(scope, message) {
    record(scope, "state", message);
  }

  function attachError(code, message, stack) {
    lastError = {
      code: code || "UNKNOWN",
      message: clip(message || "", MAX_EVENT_CHARS),
      stack: stack ? clip(stack, 800) : "",
      t: Date.now()
    };
    record("error", "error", `[${lastError.code}] ${lastError.message}`);
  }

  function clearError() {
    lastError = null;
  }

  // The overlay only shows text; when a user says "it said something wrong",
  // the last few emissions reconstruct exactly what the pipeline believed.
  function addTranscript(event) {
    transcriptTail.push({
      t: Date.now(),
      action: event.action,
      lineId: event.lineId,
      text: clip(event.text || "", 120),
      tail: clip(event.tail || "", 80),
      telemetry: event.telemetry || null
    });
    if (transcriptTail.length > 3) transcriptTail.shift();
  }

  function snapshot() {
    return {
      reportVersion: REPORT_VERSION,
      bootId,
      capturedAt: new Date().toISOString(),
      fields: { ...fields },
      timings: JSON.parse(JSON.stringify(timings)),
      lastError: lastError ? { ...lastError } : null,
      events: events.map((e) => ({ ...e })),
      transcript: transcriptTail.map((e) => ({ ...e }))
    };
  }

  function pad(text, width) {
    return String(text) + " ".repeat(Math.max(1, width - String(text).length));
  }

  // Fixed section order, fixed key order inside each section. Two reports from
  // two machines should diff cleanly instead of shuffling.
  function renderBlock(title, rows) {
    if (!rows.length) return "";
    const width = rows.reduce((max, [key]) => Math.max(max, String(key).length), 0);
    return [`[${title}]`, ...rows.map(([k, v]) => `  ${pad(k, width)}${v}`)].join("\n") + "\n\n";
  }

  function formatReport({ header = [], blocks = [], timings: timingList = [], events: eventList = [], errors = [], transcript = [] }) {
    let body = `LIVE SUBTITLES DIAGNOSTIC REPORT  v${REPORT_VERSION}\n`;
    body += `generated ${new Date().toISOString()}\n\n`;
    body += renderBlock("build", header);

    for (const block of blocks) {
      body += renderBlock(block.title, block.rows);
    }

    if (timingList.length) {
      body += renderBlock(
        "timings",
        timingList.map((b) => [
          `${b.source}.${b.name}`,
          `n=${b.count} last=${b.last.toFixed(1)}ms mean=${(b.count ? b.sum / b.count : 0).toFixed(1)}ms max=${b.max.toFixed(1)}ms`
        ])
      );
    }

    if (transcript.length) {
      body += "[last emissions]\n";
      for (const e of transcript) {
        const tel = e.telemetry
          ? ` audio=${e.telemetry.audioSeconds}s asr=${e.telemetry.asrDurationMs}ms`
          : "";
        body += `  ${new Date(e.t).toISOString().slice(11, 23)} ${pad(e.action, 7)} ${JSON.stringify(e.text)}${tel}\n`;
      }
      body += "\n";
    }

    if (errors.length) {
      body += "[errors]\n";
      for (const e of errors) {
        body += `  ${new Date(e.t).toISOString().slice(11, 23)} ${e.source} ${e.code}\n`;
        body += `  message  ${e.message}\n`;
        if (e.stack) body += `  stack    ${e.stack.split("\n").slice(0, 4).join(" | ")}\n`;
      }
      body += "\n";
    }

    if (eventList.length) {
      const ordered = eventList.slice().sort((a, b) => a.t - b.t);
      body += `[events] (${ordered.length}, oldest first)\n`;
      for (const e of ordered) {
        body += `  ${new Date(e.t).toISOString().slice(11, 23)} ${pad(e.level, 5)} ${pad(e.source, 9)} ${pad(e.scope, 12)} ${e.msg}\n`;
      }
      body += "\n";
    }

    if (body.length > MAX_REPORT_CHARS) {
      body = `${body.slice(0, MAX_REPORT_CHARS)}\n… report truncated at ${MAX_REPORT_CHARS} chars\n`;
    }
    return body;
  }

  globalThis.LIVE_DIAG = Object.freeze({
    REPORT_VERSION,
    bootId,
    install: installConsoleCapture,
    record,
    mark,
    set,
    bump,
    sample,
    attachError,
    clearError,
    addTranscript,
    snapshot,
    formatReport
  });
})();
