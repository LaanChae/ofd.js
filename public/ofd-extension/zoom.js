// Keep OFD pinching inside PDF.js: Safari's native GestureEvents otherwise
// zoom the entire web page, including the per-glyph selection layer. Commit
// at most one scale change per animation frame, regardless of input frequency.
export function mountOfdZoom(app, host = window) {
  const container = app.pdfViewer.container;
  let frame = null, owner = null, targetScale = null, gesture = null;
  const enabled = () => app.pdfDocument?.isOFD &&
    !app.pdfViewer.isInPresentationMode && !app.overlayManager.active;
  function clear() {
    if (frame !== null) host.cancelAnimationFrame(frame);
    frame = owner = targetScale = gesture = null;
  }
  function flush() {
    frame = null;
    if (owner !== app.pdfDocument || !enabled()) { clear(); return; }
    const { scale, origin } = targetScale;
    targetScale = null;
    const current = app.pdfViewer.currentScale;
    const factor = gesture ? scale / current
      : app._accumulateFactor(current, scale / current, '_wheelUnusedFactor');
    app.updateZoom(null, factor, origin);
  }
  function schedule(scale, event) {
    owner = app.pdfDocument;
    // Match PDF.js's scale limits so reversing at an endpoint responds at once.
    targetScale = { scale: Math.max(.1, Math.min(25, scale)),
      origin: [event.clientX, event.clientY] };
    if (frame === null) frame = host.requestAnimationFrame(flush);
  }
  container.addEventListener('gesturestart', event => {
    if (!enabled()) return;
    event.preventDefault();
    clear();
    if (!(event.scale > 0) || !Number.isFinite(event.scale)) return;
    gesture = { document: app.pdfDocument, scale: app.pdfViewer.currentScale / event.scale };
  }, { passive: false });
  host.addEventListener('gesturechange', event => {
    if (!gesture) return;
    event.preventDefault();
    if (gesture.document !== app.pdfDocument || !enabled()) { clear(); return; }
    if (event.scale > 0 && Number.isFinite(event.scale)) schedule(gesture.scale * event.scale, event);
  }, { passive: false });
  host.addEventListener('gestureend', event => {
    if (!gesture) return;
    event.preventDefault();
    if (frame !== null) { host.cancelAnimationFrame(frame); flush(); }
    gesture = null;
  }, { passive: false });
  container.addEventListener('wheel', event => {
    if (!enabled()) return;
    // Safari may emit wheel events alongside its native gesture stream.
    if (gesture && event.ctrlKey) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    // Preserve ordinary scrolling and deliberate Ctrl+wheel's discrete steps.
    if (!event.ctrlKey || app._isCtrlKeyDown || event.deltaMode !== 0 ||
        event.deltaX !== 0 || event.deltaZ !== 0 ||
        Math.abs(Math.exp(-event.deltaY / 100) - 1) >= .05) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (app._isScrolling || host.document.visibilityState === 'hidden') return;
    const scale = owner === app.pdfDocument && targetScale
      ? targetScale.scale : app.pdfViewer.currentScale;
    schedule(scale * Math.exp(-event.deltaY / 100), event);
  }, { capture: true, passive: false });
  host.addEventListener('blur', clear);
  app.eventBus.on('pagesdestroy', clear);
}
