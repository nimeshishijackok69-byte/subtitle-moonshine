// Process termination for bench runners.
//
// A child that has printed everything it has to say and still holds the event
// loop open is indistinguishable from a hang to a sweep driver. That is not
// hypothetical: a full run wrote its JSON and summary and then never exited,
// blocking the rest of the sweep (F-007). Every runner therefore ends through
// here, and reports what was still holding the loop so the leak stays visible
// instead of merely being suppressed.

function flush(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) return resolve();
    // Writing an empty chunk queues a callback behind everything already
    // buffered, so it fires once the pipe has actually drained.
    stream.write("", () => resolve());
  });
}

// Snapshot of the handles that would keep the process alive. Taken after the
// session is released: anything left is the difference between "the loop was
// clean" and "the runtime was holding us open".
export function exitEvidence() {
  const resources = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [];
  return { activeResources: [...resources] };
}

// Drain stdout/stderr, then exit without waiting for the event loop to empty.
// Node normally exits on its own; this is the floor for the case where native
// teardown never signals completion.
export async function exitNow(code = 0) {
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
}
