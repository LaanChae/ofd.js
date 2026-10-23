import * as m from "mupdf";
import { attr, child, children, name, number, numbers } from "./archive.js";
import {
  IDENTITY,
  multiply,
  translate,
  transformPoint,
  rectangle,
} from "./geometry.js";

export function segmentPositions(nodes) {
  if (nodes.length < 2) throw new Error("渐变至少需要两个色标。");
  const p = nodes.map((n) =>
    n.hasAttribute("Position") ? number(n, "Position") : null,
  );
  p[0] ??= 0;
  p[p.length - 1] ??= 1;
  for (let a = 0; a < p.length - 1;) {
    let b = a + 1;
    while (p[b] === null) b++;
    if (!(p[b] > p[a]) || p[a] < 0 || p[b] > 1)
      throw new Error("渐变色标位置必须在 0 到 1 之间递增。");
    for (let i = a + 1; i < b; i++)
      p[i] = p[a] + ((p[b] - p[a]) * (i - a)) / (b - a);
    a = b;
  }
  return p;
}

// Convert each stop through MuPDF's color management before interpolating mixed spaces.
// Uniform device spaces retain their original interpolation (notably CMYK).
function prepareColors(colors) {
  if (colors.some((c) => c.complex))
    throw new Error("渐变色标必须使用基本颜色。");
  const spaces = new Map([
    [m.ColorSpace.DeviceRGB, "DeviceRGB"],
    [m.ColorSpace.DeviceGray, "DeviceGray"],
    [m.ColorSpace.DeviceCMYK, "DeviceCMYK"],
  ]);
  const uniform = colors.every((c) => c.space === colors[0].space);
  if (uniform && spaces.has(colors[0].space))
    return { space: spaces.get(colors[0].space), colors };
  if (uniform && colors[0].profile)
    return {
      colors,
      space: (doc) => {
        const stream = doc.addStream(colors[0].profile, {
          N: colors[0].values.length,
        });
        try {
          return doc.addObject(["ICCBased", stream]);
        } finally {
          stream.destroy();
        }
      },
    };
  return {
    space: "DeviceRGB",
    colors: colors.map((c) => {
      const px = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, 1, 1], false);
      const device = new m.DrawDevice(IDENTITY, px),
        path = rectangle([0, 0, 1, 1]);
      try {
        device.fillPath(path, false, IDENTITY, c.space, c.values, 1);
        device.close();
        return {
          ...c,
          values: [...px.getPixels()].slice(0, 3).map((v) => v / 255),
        };
      } finally {
        device.destroy();
        path.destroy();
        px.destroy();
      }
    }),
  };
}
export function localBounds(matrix, bounds) {
  const inverse = m.Matrix.invert(matrix);
  const points = [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[3]],
  ].map((p) => transformPoint(inverse, ...p));
  return [
    Math.min(...points.map((p) => p[0])) - 1,
    Math.min(...points.map((p) => p[1])) - 1,
    Math.max(...points.map((p) => p[0])) + 1,
    Math.max(...points.map((p) => p[1])) + 1,
  ];
}
export function roots(a, b, c) {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  return [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)];
}
function extent(start, end, r0, r1, box, radial) {
  const dx = end[0] - start[0],
    dy = end[1] - start[1],
    dr = r1 - r0;
  const candidates = [0, 1];
  for (const x of [box[0], box[2]])
    for (const y of [box[1], box[3]]) {
      const px = x - start[0],
        py = y - start[1];
      if (radial)
        candidates.push(
          ...roots(
            dx * dx + dy * dy - dr * dr,
            -2 * (px * dx + py * dy + r0 * dr),
            px * px + py * py - r0 * r0,
          ),
        );
      else candidates.push((px * dx + py * dy) / (dx * dx + dy * dy));
    }
  if (radial) {
    // Extrema on rectangle edges occur at tangency; corners are covered above.
    for (let axis = 0; axis < 2; axis++)
      for (const edge of [box[axis], box[axis + 2]])
        for (const sign of [-1, 1]) {
          const divisor = end[axis] - start[axis] + sign * dr;
          if (Math.abs(divisor) > 1e-12)
            candidates.push((edge - start[axis] - sign * r0) / divisor);
        }
  }
  let lo = Math.min(...candidates.filter(Number.isFinite)),
    hi = Math.max(...candidates.filter(Number.isFinite));
  if (radial && dr > 0) lo = Math.max(lo, -r0 / dr);
  if (radial && dr < 0) hi = Math.min(hi, -r0 / dr);
  return [lo, hi];
}
export function interpolate(stops, t, alpha) {
  const values = (c) => (alpha ? [c.alpha] : c.values);
  if (t <= stops[0].position) return values(stops[0].color);
  if (t >= stops.at(-1).position) return values(stops.at(-1).color);
  const i = stops.findIndex((s) => s.position >= t),
    a = stops[i - 1],
    b = stops[i],
    u = (t - a.position) / (b.position - a.position);
  return values(a.color).map((v, j) => v + (values(b.color)[j] - v) * u);
}
function shadingFunction(stops, mapType, period, domain, alpha) {
  const intervals = [];
  const add = (a, b, ta, tb) => {
    if (b > a)
      intervals.push({
        a,
        b,
        from: interpolate(stops, ta, alpha),
        to: interpolate(stops, tb, alpha),
      });
  };
  if (mapType === "Direct") {
    const positions = [0, ...stops.map((s) => s.position), 1].filter(
      (v, i, a) => !i || v > a[i - 1],
    );
    for (let i = 1; i < positions.length; i++)
      add(positions[i - 1], positions[i], positions[i - 1], positions[i]);
  } else {
    const first = Math.floor(domain[0] / period),
      last = Math.ceil(domain[1] / period);
    if ((last - first) * (stops.length + 1) > 16384)
      throw new Error("渐变重复次数过多，超过安全绘制上限。");
    for (let cycle = first; cycle < last; cycle++) {
      const reverse = mapType === "Reflect" && ((cycle % 2) + 2) % 2 === 1;
      const positions = [0, ...stops.map((s) => s.position), 1]
        .map((v) => (reverse ? 1 - v : v))
        .sort((a, b) => a - b)
        .filter((v, i, a) => !i || v > a[i - 1]);
      for (let i = 1; i < positions.length; i++) {
        const a = Math.max(domain[0], (cycle + positions[i - 1]) * period),
          b = Math.min(domain[1], (cycle + positions[i]) * period);
        const ta = a / period - cycle,
          tb = b / period - cycle;
        add(a, b, reverse ? 1 - ta : ta, reverse ? 1 - tb : tb);
      }
    }
  }
  if (!intervals.length) throw new Error("渐变区间为空。");
  return {
    FunctionType: 3,
    Domain: domain,
    Functions: intervals.map((s) => ({
      FunctionType: 2,
      Domain: [0, 1],
      C0: s.from,
      C1: s.to,
      N: 1,
    })),
    Bounds: intervals.slice(1).map((s) => s.a),
    Encode: intervals.flatMap(() => [0, 1]),
  };
}
function analytic(node, getColor, matrix, bounds) {
  const nodes = children(node, "Segment"),
    positions = segmentPositions(nodes);
  const prepared = prepareColors(nodes.map((n) => getColor(child(n, "Color"))));
  const stops = positions.map((position, i) => ({
    position,
    color: prepared.colors[i],
  }));
  let start = numbers(attr(node, "StartPoint"), 2),
    end = numbers(attr(node, "EndPoint"), 2);
  const originalLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const radial = name(node) === "RadialShd",
    r0 = number(node, "StartRadius", 0),
    r1 = number(node, "EndRadius", 0);
  const mapType = attr(node, "MapType", "Direct"),
    extend = number(node, "Extend", 0);
  if (!["Direct", "Repeat", "Reflect"].includes(mapType))
    throw new Error("未知渐变映射方式。");
  if (radial) {
    const e = number(node, "Eccentricity", 0),
      angle = (number(node, "Angle", 0) * Math.PI) / 180;
    if (e < 0 || e >= 1 || r0 < 0 || r1 < 0)
      throw new Error("径向渐变的离心率或半径无效。");
    const k = Math.sqrt(1 - e * e),
      c = Math.cos(angle),
      s = Math.sin(angle),
      ellipse = [c, s, -k * s, k * c, 0, 0];
    const inv = m.Matrix.invert(ellipse);
    start = transformPoint(inv, ...start);
    end = transformPoint(inv, ...end);
    matrix = multiply(matrix, ellipse);
    if (!originalLength && r0 === r1)
      throw new Error("径向渐变的两个椭圆重合。");
  } else if (!originalLength) throw new Error("轴向渐变的起止点重合。");
  if (!Number.isInteger(extend) || extend < 0 || extend > 3)
    throw new Error("渐变 Extend 必须是 0、1、2 或 3。");
  const box = localBounds(matrix, bounds);
  let domain = [0, 1],
    period = 1;
  if (mapType !== "Direct") {
    // A concentric radial gradient has no center-line length; a cycle can still
    // be defined naturally by its radius change. Explicit MapUnit is measured there.
    const length = originalLength || Math.abs(r1 - r0);
    period = number(node, "MapUnit", length) / length;
    if (!(period > 0) || !Number.isFinite(period))
      throw new Error("MapUnit 必须是有限正数。");
    if (
      radial &&
      extend &&
      Math.abs(
        (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2 - (r1 - r0) ** 2,
      ) < 1e-12
    )
      throw new Error("圆心位移等于半径变化的径向重复渐变暂不支持无限延伸。");
    const limits = extent(start, end, r0, r1, box, radial);
    domain = [extend & 1 ? limits[0] : 0, extend & 2 ? limits[1] : 1];
  }
  const point = (t) => start.map((v, i) => v + (end[i] - v) * t),
    radius = (t) => Math.max(0, r0 + (r1 - r0) * t);
  const coords = radial
    ? [
        ...point(domain[0]),
        radius(domain[0]),
        ...point(domain[1]),
        radius(domain[1]),
      ]
    : [...point(domain[0]), ...point(domain[1])];
  return {
    matrix,
    box,
    geometry: {
      radial,
      start,
      end,
      r0,
      r1,
      mapType,
      extend,
      period,
      domain,
      stops,
    },
    colors: prepared.colors,
    make: (doc, alpha) => {
      const space = alpha
        ? "DeviceGray"
        : typeof prepared.space === "function"
          ? prepared.space(doc)
          : prepared.space;
      try {
        return doc.addObject({
          ShadingType: radial ? 3 : 2,
          ColorSpace: space,
          Coords: coords,
          Domain: domain,
          Function: shadingFunction(stops, mapType, period, domain, alpha),
          Extend:
            mapType === "Direct"
              ? [!!(extend & 1), !!(extend & 2)]
              : [false, false],
        });
      } finally {
        space?.destroy?.();
      }
    },
  };
}
function mesh(node, getColor, matrix, bounds) {
  const nodes = children(node, "Point"),
    // §8.3.4.5 and Annex A's CT_Color spell the lattice element differently.
    lattice = ["LaGouraudShd", "LaGourandShd"].includes(name(node)),
    row = number(node, "VerticesPerRow", 0);
  if (
    nodes.length > 100000 ||
    nodes.length < (lattice ? 4 : 3) ||
    (lattice &&
      (!Number.isInteger(row) ||
        row < 2 ||
        nodes.length % row ||
        nodes.length / row < 2))
  )
    throw new Error("网格渐变的控制点或每行顶点数无效。");
  const prepared = prepareColors(nodes.map((n) => getColor(child(n, "Color"))));
  const points = nodes.map((n) => [number(n, "X", NaN), number(n, "Y", NaN)]);
  if (points.some((p) => p.some((v) => !Number.isFinite(v))))
    throw new Error("网格顶点坐标无效。");
  let remaining = 0,
    hasTriangle = false;
  const flags = nodes.map((n, i) => {
    if (lattice) return 0;
    const flag = number(n, "EdgeFlag", 0);
    if (!Number.isInteger(flag) || flag < 0 || flag > 2)
      throw new Error("EdgeFlag 必须是 0、1 或 2。");
    if (remaining) {
      remaining--;
      if (!remaining) hasTriangle = true;
      return 0;
    }
    if (flag === 0) remaining = 2;
    else if (!hasTriangle) throw new Error("网格的首个三角形不完整。");
    return flag;
  });
  if (remaining) throw new Error("网格的最后一个三角形不完整。");
  const limits = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of points)
    for (let axis = 0; axis < 2; axis++) {
      limits[axis * 2] = Math.min(limits[axis * 2], p[axis]);
      limits[axis * 2 + 1] = Math.max(limits[axis * 2 + 1], p[axis]);
    }
  const triangles = [];
  if (lattice) {
    for (let i = 0; i < points.length - row; i++)
      if (i % row !== row - 1)
        triangles.push([i, i + 1, i + row], [i + 1, i + row, i + row + 1]);
  } else {
    let previous;
    for (let i = 0; i < points.length;) {
      if (flags[i] === 0) {
        previous = [i, i + 1, i + 2];
        i += 3;
      } else {
        previous =
          flags[i] === 1
            ? [previous[1], previous[2], i]
            : [previous[0], previous[2], i];
        i++;
      }
      triangles.push(previous);
    }
  }
  if (limits[0] === limits[1] || limits[2] === limits[3])
    throw new Error("网格区域没有面积。");
  const back =
    number(node, "Extend", 0) === 1 && child(node, "BackColor")
      ? getColor(child(node, "BackColor"))
      : null;
  return {
    matrix,
    box: localBounds(matrix, bounds),
    colors: prepared.colors,
    geometry: { points, triangles },
    back,
    coverage: () => {
      const path = new m.Path();
      for (const triangle of triangles) {
        let [a, b, c] = triangle.map((i) => points[i]);
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0)
          [b, c] = [c, b];
        path.moveTo(...a);
        path.lineTo(...b);
        path.lineTo(...c);
        path.closePath();
      }
      return path;
    },
    make: (doc, alpha) => {
      const components = alpha ? 1 : prepared.colors[0].values.length,
        stride = (lattice ? 0 : 1) + 8 + components * 2;
      const bytes = new Uint8Array(stride * points.length),
        view = new DataView(bytes.buffer);
      let offset = 0;
      points.forEach((p, i) => {
        if (!lattice) view.setUint8(offset++, flags[i]);
        for (let axis = 0; axis < 2; axis++) {
          view.setUint32(
            offset,
            Math.round(
              ((p[axis] - limits[axis * 2]) /
                (limits[axis * 2 + 1] - limits[axis * 2])) *
                0xffffffff,
            ),
          );
          offset += 4;
        }
        for (const v of alpha
          ? [prepared.colors[i].alpha]
          : prepared.colors[i].values) {
          view.setUint16(
            offset,
            Math.round(Math.max(0, Math.min(1, v)) * 65535),
          );
          offset += 2;
        }
      });
      const space = alpha
        ? "DeviceGray"
        : typeof prepared.space === "function"
          ? prepared.space(doc)
          : prepared.space;
      const dict = {
        ShadingType: lattice ? 5 : 4,
        ColorSpace: space,
        BitsPerCoordinate: 32,
        BitsPerComponent: 16,
        Decode: [
          ...limits,
          ...Array.from({ length: components }, () => [0, 1]).flat(),
        ],
      };
      if (lattice) dict.VerticesPerRow = row;
      else dict.BitsPerFlag = 8;
      try {
        return doc.addStream(bytes, dict);
      } finally {
        space?.destroy?.();
      }
    },
  };
}
export function drawGradient(
  device,
  node,
  matrix,
  opacity,
  getColor,
  bounds,
  forms,
) {
  const kind = name(node);
  if (!["AxialShd", "RadialShd", "GouraudShd", "LaGouraudShd", "LaGourandShd"].includes(kind))
    throw new Error(`尚不支持 ${kind} 颜色。`);
  const plan = ["AxialShd", "RadialShd"].includes(kind)
    ? analytic(node, getColor, matrix, bounds)
    : mesh(node, getColor, matrix, bounds);
  if (plan.back) {
    if (plan.back.complex) throw new Error("网格背景必须是基本颜色。");
    const path = rectangle([
        bounds[0],
        bounds[1],
        bounds[2] - bounds[0],
        bounds[3] - bounds[1],
      ]),
      coverage = plan.coverage(),
      reset = new m.Path();
    device.clipPath(path, false, IDENTITY);
    try {
      device.beginMask(bounds, true, m.ColorSpace.DeviceGray, [0]);
      device.fillPath(path, false, IDENTITY, m.ColorSpace.DeviceGray, [1], 1);
      device.fillPath(
        coverage,
        false,
        plan.matrix,
        m.ColorSpace.DeviceGray,
        [0],
        1,
      );
      device.fillPath(reset, false, IDENTITY, m.ColorSpace.DeviceGray, [0], 0);
      device.endMask();
      try {
        device.fillPath(
          path,
          false,
          IDENTITY,
          plan.back.space,
          plan.back.values,
          plan.back.alpha * opacity,
        );
      } finally {
        device.popClip();
      }
    } finally {
      device.popClip();
      path.destroy();
      coverage.destroy();
      reset.destroy();
    }
  }
  const first = plan.colors[0].alpha;
  if (plan.colors.every((c) => c.alpha === first)) {
    forms.paint(device, plan, false, opacity * first);
    return;
  }
  // Encapsulate gradient alpha in its own transparency Form. Installing a
  // second soft mask on the parent device overwrites an existing stroke/Area
  // clip mask; a Form applies both masks at their respective group boundaries.
  if (forms.paintWithAlpha) {
    forms.paintWithAlpha(device, plan, opacity, bounds);
    return;
  }
  forms.paint(device, {...plan, makeForm(pdf) {
    const shade=plan.make(pdf,false),alpha=plan.make(pdf,true),[x0,y0,x1,y1]=plan.box,w=x1-x0,h=y1-y0;
    let mask;
    try {
      mask=pdf.addStream('/A sh',{Type:'XObject',Subtype:'Form',BBox:plan.box,Group:{S:'Transparency',CS:'DeviceGray',I:true,K:false},Resources:{Shading:{A:alpha}}});
      return pdf.addStream(`q ${1/w} 0 0 ${-1/h} ${-x0/w} ${y1/h} cm /M gs /Sh sh Q`,{
        Type:'XObject',Subtype:'Form',BBox:[0,0,1,1],Group:{S:'Transparency',CS:'DeviceRGB',I:true,K:false},
        Resources:{Shading:{Sh:shade},ExtGState:{M:{ca:opacity,CA:opacity,SMask:{S:'Luminosity',G:mask,BC:[0]}}}},
      });
    } finally {mask?.destroy();shade.destroy();alpha.destroy();}
  }},false,1);
}
