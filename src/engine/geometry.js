import * as mupdf from "mupdf";
import { numbers } from "./archive.js";

export const IDENTITY = [1, 0, 0, 1, 0, 0];
export { MM } from "./units.js";
// Column-vector affine matrices: multiply(a,b) applies b first, then a.
export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (x, y = x) => [x, 0, 0, y, 0, 0];
export const transformPoint = (m, x, y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
export function rectangle(box) {
  const p = new mupdf.Path();
  p.rect(box[0], box[1], box[0] + box[2], box[1] + box[3]);
  return p;
}
export function roundedRectangle(box, horizontalRadius = 0, verticalRadius = 0) {
  const [x, y, w, h] = box,
    rx = Math.min(Math.max(0, horizontalRadius), w / 2),
    ry = Math.min(Math.max(0, verticalRadius), h / 2);
  if (!rx || !ry) return rectangle(box);
  const p = new mupdf.Path(), k = 4 * (Math.sqrt(2) - 1) / 3;
  // Start at the upper-left tangent and proceed clockwise, including dashes.
  p.moveTo(x + rx, y);
  p.lineTo(x + w - rx, y);
  p.curveTo(x + w - rx + k * rx, y, x + w, y + ry - k * ry, x + w, y + ry);
  p.lineTo(x + w, y + h - ry);
  p.curveTo(x + w, y + h - ry + k * ry, x + w - rx + k * rx, y + h, x + w - rx, y + h);
  p.lineTo(x + rx, y + h);
  p.curveTo(x + rx - k * rx, y + h, x, y + h - ry + k * ry, x, y + h - ry);
  p.lineTo(x, y + ry);
  p.curveTo(x, y + ry - k * ry, x + rx - k * rx, y, x + rx, y);
  p.closePath();
  return p;
}
export function delta(value, limit = 1000000) {
  const tokens = String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "g") {
      const count = Number(tokens[++i]),
        step = Number(tokens[++i]);
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        result.length + count > limit ||
        !Number.isFinite(step)
      )
        throw new Error("无效的文字间距缩写。");
      for (let n = 0; n < count; n++) result.push(step);
    } else {
      const step = Number(tokens[i]);
      if (!Number.isFinite(step) || result.length >= limit)
        throw new Error("无效的文字间距。");
      result.push(step);
    }
  }
  return result;
}

// Elliptical arc endpoint parameterization, converted to <=90-degree cubic segments.
function arc(p, x1, y1, rx, ry, rotation, large, sweep, x2, y2) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (x1 === x2 && y1 === y2) return;
  if (!rx || !ry) {
    p.lineTo(x2, y2);
    return;
  }
  const phi = ((rotation % 360) * Math.PI) / 180,
    c = Math.cos(phi),
    s = Math.sin(phi);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2,
    xp = c * dx + s * dy,
    yp = -s * dx + c * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const k =
    (Boolean(large) === Boolean(sweep) ? -1 : 1) *
    Math.sqrt(
      Math.max(
        0,
        (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) /
          (rx * rx * yp * yp + ry * ry * xp * xp),
      ),
    );
  const cxp = (k * rx * yp) / ry,
    cyp = (-k * ry * xp) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2,
    cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const start = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  let angle = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - start;
  if (sweep && angle < 0) angle += 2 * Math.PI;
  if (!sweep && angle > 0) angle -= 2 * Math.PI;
  const steps = Math.ceil(Math.abs(angle) / (Math.PI / 2)),
    step = angle / steps;
  const map = (x, y) => [
    cx + rx * c * x - ry * s * y,
    cy + rx * s * x + ry * c * y,
  ];
  for (let i = 0; i < steps; i++) {
    const a = start + i * step,
      b = a + step,
      t = (4 / 3) * Math.tan(step / 4);
    p.curveTo(
      ...map(Math.cos(a) - t * Math.sin(a), Math.sin(a) + t * Math.cos(a)),
      ...map(Math.cos(b) + t * Math.sin(b), Math.sin(b) - t * Math.cos(b)),
      ...map(Math.cos(b), Math.sin(b)),
    );
  }
}

export function ofdPath(data) {
  const tokens =
    String(data).match(/[A-Za-z]|[-+]?(?:\d*\.?\d+)(?:[eE][-+]?\d+)?/g) || [];
  const path = new mupdf.Path();
  let i = 0,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  const take = (n) => {
    const a = tokens.slice(i, i + n).map(Number);
    i += n;
    if (a.length !== n || a.some((v) => !Number.isFinite(v)))
      throw new Error("路径参数不完整。");
    return a;
  };
  try {
    while (i < tokens.length) {
      const op = tokens[i++];
      if (op === "M" || op === "S") {
        [x, y] = take(2);
        sx = x;
        sy = y;
        path.moveTo(x, y);
      } else if (op === "L") {
        [x, y] = take(2);
        path.lineTo(x, y);
      } else if (op === "B") {
        const v = take(6);
        path.curveTo(...v);
        [x, y] = v.slice(4);
      } else if (op === "Q") {
        const [cx, cy, ex, ey] = take(4);
        path.curveTo(
          x + (2 / 3) * (cx - x),
          y + (2 / 3) * (cy - y),
          ex + (2 / 3) * (cx - ex),
          ey + (2 / 3) * (cy - ey),
          ex,
          ey,
        );
        x = ex;
        y = ey;
      } else if (op === "A") {
        const v = take(7);
        arc(path, x, y, ...v);
        [x, y] = v.slice(5);
      } else if (op === "C") {
        path.closePath();
        x = sx;
        y = sy;
      } else throw new Error(`不支持的 OFD 路径指令：${op}`);
    }
    return path;
  } catch (e) {
    path.destroy();
    throw e;
  }
}

export function svgTransform(value) {
  let m = IDENTITY;
  for (const match of String(value || "").matchAll(
    /([a-z]+)\s*\(([^)]*)\)/gi,
  )) {
    const v = numbers(match[2]);
    let n;
    if (match[1] === "matrix" && v.length === 6) n = v;
    else if (match[1] === "translate") n = translate(v[0], v[1] || 0);
    else if (match[1] === "scale") n = scale(v[0], v[1] ?? v[0]);
    else if (match[1] === "rotate") {
      const a = (v[0] * Math.PI) / 180;
      n = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (v.length === 3)
        n = multiply(
          translate(v[1], v[2]),
          multiply(n, translate(-v[1], -v[2])),
        );
    } else throw new Error(`不支持的 SVG 变换：${match[1]}`);
    m = multiply(m, n);
  }
  return m;
}
