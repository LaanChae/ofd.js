import { attr, numbers } from "./archive.js";
import { multiply } from "./geometry.js";
import { patternLayout, paintPatternCells } from "./pattern-layout.js";
import { localBounds } from "./gradients.js";

// Direct page drawing: repeat clipped OFD cells, without a PDF pattern resource.
export function drawDirectPattern(
  renderer,
  device,
  node,
  matrix,
  opacity,
  style,
) {
  const layout = patternLayout(node),
    { width, height, xstep, ystep } = layout;
  if (renderer.patternDepth >= 16) throw new Error("底纹嵌套过深。");
  const tm = multiply(
    attr(node, "RelativeTo") === "Page" ? renderer.pageMatrix : matrix,
    numbers(attr(node, "CTM", "1 0 0 1 0 0"), 6),
  );
  const box = localBounds(tm, renderer.bounds);
  renderer.patternDepth = (renderer.patternDepth || 0) + 1;
  let entered = false;
  try {
    device.beginTile(box, [0, 0, width, height], xstep, ystep, tm, 0, 0);
    entered = true;
    paintPatternCells(renderer, device, node, layout, tm, style, opacity);
  } finally {
    renderer.patternDepth--;
    if (entered) device.endTile();
  }
}
