import * as m from "mupdf";
import { multiply, transformPoint } from "./geometry.js";
import { roots, interpolate } from "./gradients.js";

function parameter(g, x, y) {
  const dx = g.end[0] - g.start[0],
    dy = g.end[1] - g.start[1],
    px = x - g.start[0],
    py = y - g.start[1],
    dr = g.r1 - g.r0;
  let t;
  if (g.radial) {
    const candidates = roots(
      dx * dx + dy * dy - dr * dr,
      -2 * (px * dx + py * dy + g.r0 * dr),
      px * px + py * py - g.r0 * g.r0,
    ).filter(
      (v) =>
        g.r0 + dr * v >= -1e-9 &&
        (v >= g.domain[0] || (g.mapType === "Direct" && g.extend & 1)) &&
        (v <= g.domain[1] || (g.mapType === "Direct" && g.extend & 2)),
    );
    if (!candidates.length) return null;
    t = Math.max(...candidates);
  } else t = (px * dx + py * dy) / (dx * dx + dy * dy);
  if (
    (t < g.domain[0] && !(g.mapType === "Direct" && g.extend & 1)) ||
    (t > g.domain[1] && !(g.mapType === "Direct" && g.extend & 2))
  )
    return null;
  if (g.mapType === "Direct") return Math.max(0, Math.min(1, t));
  const cycle = Math.floor(t / g.period),
    u = t / g.period - cycle;
  return g.mapType === "Reflect" && ((cycle % 2) + 2) % 2 === 1 ? 1 - u : u;
}

// Rasterize at the actual target resolution. MuPDF still owns clipping,
// composition and ICC conversion; no PDF objects or PDF bytes are involved.
export class DirectGradients {
  constructor(matrix, width, height) {
    this.matrix = matrix;
    this.width = width;
    this.height = height;
    this.clipToPage = true;
  }
  paint(device, plan, alpha, opacity) {
    const tm = multiply(this.matrix, plan.matrix),
      inv = m.Matrix.invert(tm),
      corners = [
        [plan.box[0], plan.box[1]],
        [plan.box[2], plan.box[1]],
        [plan.box[0], plan.box[3]],
        [plan.box[2], plan.box[3]],
      ].map((p) => transformPoint(tm, ...p));
    const x0 = Math.max(
        this.clipToPage ? 0 : -Infinity,
        Math.floor(Math.min(...corners.map((p) => p[0]))),
      ),
      y0 = Math.max(
        this.clipToPage ? 0 : -Infinity,
        Math.floor(Math.min(...corners.map((p) => p[1]))),
      ),
      x1 = Math.min(
        this.clipToPage ? this.width : Infinity,
        Math.ceil(Math.max(...corners.map((p) => p[0]))),
      ),
      y1 = Math.min(
        this.clipToPage ? this.height : Infinity,
        Math.ceil(Math.max(...corners.map((p) => p[1]))),
      ),
      width = x1 - x0,
      height = y1 - y0;
    if (width <= 0 || height <= 0) return;
    if (width * height > 32 * 1024 * 1024)
      throw new Error("渐变绘制尺寸超过安全上限。");
    const uniform = plan.colors.every((c) => c.space === plan.colors[0].space),
      space = alpha
        ? m.ColorSpace.DeviceGray
        : uniform
          ? plan.colors[0].space
          : m.ColorSpace.DeviceRGB,
      source = new m.Pixmap(space, [0, 0, width, height], false),
      pixels = source.getPixels(),
      components = space.getNumberOfComponents(),
      coverage = new Uint8Array(width * height),
      g = plan.geometry;
    let rgb, rgba, image;
    const write = (x, y, values) => {
      const index = (y - y0) * width + x - x0;
      coverage[index] = 255;
      for (let c = 0; c < components; c++)
        pixels[index * components + c] = Math.round(
          Math.max(0, Math.min(1, values[c])) * 255,
        );
    };
    try {
      if (g.triangles) {
        const pts = g.points.map((p) => transformPoint(tm, ...p));
        for (const tri of g.triangles) {
          const [a, b, c] = tri.map((i) => pts[i]),
            d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          if (Math.abs(d) < 1e-12) continue;
          const left = Math.max(x0, Math.floor(Math.min(a[0], b[0], c[0]))),
            right = Math.min(x1, Math.ceil(Math.max(a[0], b[0], c[0]))),
            top = Math.max(y0, Math.floor(Math.min(a[1], b[1], c[1]))),
            bottom = Math.min(y1, Math.ceil(Math.max(a[1], b[1], c[1]))),
            colors = tri.map((i) =>
              alpha ? [plan.colors[i].alpha] : plan.colors[i].values,
            );
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) {
              const u =
                  ((b[1] - c[1]) * (x + 0.5 - c[0]) +
                    (c[0] - b[0]) * (y + 0.5 - c[1])) /
                  d,
                v =
                  ((c[1] - a[1]) * (x + 0.5 - c[0]) +
                    (a[0] - c[0]) * (y + 0.5 - c[1])) /
                  d,
                w = 1 - u - v;
              if (u >= -1e-8 && v >= -1e-8 && w >= -1e-8)
                write(
                  x,
                  y,
                  colors[0].map(
                    (n, i) => u * n + v * colors[1][i] + w * colors[2][i],
                  ),
                );
            }
        }
      } else {
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const p = transformPoint(inv, x + 0.5, y + 0.5),
              t = parameter(g, ...p);
            if (t !== null) write(x, y, interpolate(g.stops, t, alpha));
          }
      }
      rgb = source.convertToColorSpace(m.ColorSpace.DeviceRGB, false);
      rgba = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, width, height], true);
      const out = rgba.getPixels(),
        input = rgb.getPixels();
      for (let i = 0; i < coverage.length; i++) {
        out[i * 4] = coverage[i] ? input[i * 3] : 0;
        out[i * 4 + 1] = coverage[i] ? input[i * 3 + 1] : 0;
        out[i * 4 + 2] = coverage[i] ? input[i * 3 + 2] : 0;
        out[i * 4 + 3] = coverage[i];
      }
      image = new m.Image(rgba);
      device.fillImage(
        image,
        multiply(m.Matrix.invert(this.matrix), [width, 0, 0, height, x0, y0]),
        opacity,
      );
    } finally {
      image?.destroy();
      rgba?.destroy();
      rgb?.destroy();
      source.destroy();
    }
  }
  paintWithAlpha(device, plan, opacity, bounds) {
    device.beginMask(bounds, true, m.ColorSpace.DeviceGray, [0]);
    this.paint(device, plan, true, 1);
    device.endMask();
    try { this.paint(device, plan, false, opacity); }
    finally { device.popClip(); }
  }
}
