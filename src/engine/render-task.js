export const RENDER_SLICE_MS = 12;

// The same rendering transaction is consumed synchronously by offline callers
// and cooperatively by the viewer worker. Returning closes its native handles.
export function finishRender(steps) {
  let next;
  do { next = steps.next(); } while (!next.done);
  return next.value;
}

export async function scheduleRender(steps, signal) {
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = steps.next();
      if (next.done) return next.value;
      // A timer task, not a microtask: allow worker cancellation messages in.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { steps.return(); }
}
