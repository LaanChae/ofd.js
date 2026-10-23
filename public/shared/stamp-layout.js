export const MAX_STAMPS = 1000;
export function parsePageRange(value, count) {
  if (!Number.isInteger(count) || count < 1) throw Error("文档没有可用页面。");
  if (!value.trim()) return Array.from({ length: count }, (_, i) => i + 1);
  const result = new Set();
  for (const token of value.split(/[,，]/)) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw Error("页码范围格式为 1,3-5；留空表示全部页面。");
    const start = Number(match[1]),
      end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > count)
      throw Error("页码范围超出文档或顺序无效。");
    for (let p = start; p <= end; p++) result.add(p);
  }
  return [...result].sort((a, b) => a - b);
}
export function validatePlacements(pages, placements) {
  if (
    !Array.isArray(placements) ||
    !placements.length ||
    placements.length > MAX_STAMPS
  )
    throw Error(`请添加 1–${MAX_STAMPS} 个落章位置。`);
  const epsilon = 1e-7;
  for (const placement of placements) {
    const { page, boundary: b, clip: c } = placement;
    const box = pages[page - 1]?.box;
    if (
      !Number.isInteger(page) ||
      !box ||
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      b[2] < 1 ||
      b[3] < 1
    )
      throw Error("印章页码或位置尺寸无效（单位毫米）。");
    if (
      c &&
      (!Array.isArray(c) ||
        c.length !== 4 ||
        !c.every(Number.isFinite) ||
        c[0] < 0 ||
        c[1] < 0 ||
        c[2] <= 0 ||
        c[3] <= 0 ||
        c[0] + c[2] > b[2] + epsilon ||
        c[1] + c[3] > b[3] + epsilon)
    )
      throw Error("印章裁剪区域必须位于完整印章内。");
    const v = c ? [b[0] + c[0], b[1] + c[1], c[2], c[3]] : b;
    if (
      v[0] < box[0] - epsilon ||
      v[1] < box[1] - epsilon ||
      v[0] + v[2] > box[0] + box[2] + epsilon ||
      v[1] + v[3] > box[1] + box[3] + epsilon
    )
      throw Error(`第 ${page} 页的印章可见区域超出页面。`);
  }
  return placements;
}
export function planPlacements(
  pages,
  { mode, page, range, x, y, width, height, edge },
) {
  const selected =
    mode === "point" ? [page] : parsePageRange(range, pages.length);
  if (!["point", "each", "seam"].includes(mode)) throw Error("未知盖章方式。");
  if (
    mode === "seam" &&
    (selected.length < 2 || !["left", "right"].includes(edge))
  )
    throw Error("骑缝章至少需要两页，并选择左侧或右侧。");
  const placements = selected.map((p, i) => {
    const box = pages[p - 1]?.box;
    if (!box) throw Error("印章页码无效。");
    if (mode !== "seam")
      return { page: p, boundary: [box[0] + x, box[1] + y, width, height] };
    const start = (width * i) / selected.length,
      end = (width * (i + 1)) / selected.length,
      slice = end - start;
    return {
      page: p,
      boundary: [
        box[0] + (edge === "right" ? box[2] - slice : 0) - start,
        box[1] + y,
        width,
        height,
      ],
      clip: [start, 0, slice, height],
    };
  });
  return validatePlacements(pages, placements);
}

// Drag in document millimetres. Clip coordinates stay relative to the full
// Boundary; riding-seal slices stay attached to their page edge.
export function movePlacement(placement, box, dx, dy) {
  if (![dx, dy].every(Number.isFinite)) throw Error("移动距离无效。");
  const result = structuredClone(placement),
    b = result.boundary;
  const c = result.clip || [0, 0, b[2], b[3]];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  if (!result.clip)
    b[0] = clamp(b[0] + dx, box[0] - c[0], box[0] + box[2] - c[0] - c[2]);
  b[1] = clamp(b[1] + dy, box[1] - c[1], box[1] + box[3] - c[1] - c[3]);
  return result;
}
