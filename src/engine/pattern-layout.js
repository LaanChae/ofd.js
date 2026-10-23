import { attr, child, number } from "./archive.js";
import { multiply, transformPoint } from "./geometry.js";

// GB/T 33190 §8.3.3: alternate columns horizontally and rows vertically.
// Both backends repeat the same bounded supercell, including the same gaps.
export function patternLayout(node) {
  const width = number(node, "Width", 0),
    height = number(node, "Height", 0),
    method = attr(node, "ReflectMethod", "Normal");
  if (width <= 0 || height <= 0)
    throw new Error("底纹单元尺寸必须为正数。");
  if (!["Normal", "Row", "Column", "RowAndColumn"].includes(method))
    throw new Error(`无效的底纹翻转方式：${method}`);
  // A step smaller than the cell dimension uses the default dimension.
  const dx = Math.max(width, number(node, "XStep", width)),
    dy = Math.max(height, number(node, "YStep", height)),
    columns = method === "Column" || method === "RowAndColumn" ? 2 : 1,
    rows = method === "Row" || method === "RowAndColumn" ? 2 : 1,
    cells = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++)
      cells.push([x ? -1 : 1, 0, 0, y ? -1 : 1,
        x * (dx + width), y * (dy + height)]);
  return {
    width: (columns - 1) * dx + width,
    height: (rows - 1) * dy + height,
    xstep: columns * dx,
    ystep: rows * dy,
    cellWidth: width,
    cellHeight: height,
    cells,
  };
}

export function paintPatternCells(renderer, device, node, layout, base, style, opacity) {
  const bounds = renderer.bounds,
    pageMatrix = renderer.pageMatrix,
    clipToPage = renderer.forms.clipToPage,
    w = layout.cellWidth,
    h = layout.cellHeight;
  renderer.forms.clipToPage = false;
  try {
    for (const cell of layout.cells) {
      const matrix = multiply(base, cell),
        corners = [[0, 0], [w, 0], [0, h], [w, h]]
          .map((p) => transformPoint(matrix, ...p));
      renderer.bounds = [
        Math.min(...corners.map((p) => p[0])),
        Math.min(...corners.map((p) => p[1])),
        Math.max(...corners.map((p) => p[0])),
        Math.max(...corners.map((p) => p[1])),
      ];
      // CellContent has its own independent coordinate system.
      renderer.pageMatrix = matrix;
      renderer.clipBox(device, [0, 0, w, h], matrix);
      try {
        renderer.block(device, child(node, "CellContent"), matrix, style, opacity);
      } finally {
        device.popClip();
      }
    }
  } finally {
    renderer.bounds = bounds;
    renderer.pageMatrix = pageMatrix;
    renderer.forms.clipToPage = clipToPage;
  }
}
