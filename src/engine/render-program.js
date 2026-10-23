import * as m from "mupdf";
import { DirectGradients } from "./direct-gradients.js";
import { indexRenderBounds, outside } from "./render-bounds.js";
import { finishRender, RENDER_SLICE_MS } from "./render-task.js";

const methods = [
  "fillPath", "strokePath", "clipPath", "clipStrokePath",
  "fillText", "strokeText", "clipText", "clipStrokeText", "ignoreText",
  "fillShade", "fillImage", "fillImageMask", "clipImageMask", "popClip",
  "beginMask", "endMask", "beginGroup", "endGroup", "beginTile", "endTile",
  "beginLayer", "endLayer",
];

function clipRectangle(path, matrix) {
  // Only axis-aligned rectangles can replace a clip with a scissor bound.
  if (!((matrix[1] === 0 && matrix[2] === 0) || (matrix[0] === 0 && matrix[3] === 0))) return null;
  const points = []; let closed = 0, invalid = false;
  path.walk({ moveTo(x,y) { if (points.length) invalid = true; points.push([x,y]); },
    lineTo(x,y) { points.push([x,y]); }, curveTo() { invalid = true; }, closePath() { closed++; } });
  if (points.length === 5 && points[0][0] === points[4][0] && points[0][1] === points[4][1]) points.pop();
  if (invalid || closed !== 1 || points.length !== 4) return null;
  if (new Set(points.map(p=>p.join(","))).size !== 4) return null;
  const xs = new Set(points.map(p=>p[0])), ys = new Set(points.map(p=>p[1]));
  if (xs.size !== 2 || ys.size !== 2) return null;
  for (let i=0;i<4;i++) {
    const a=points[i], b=points[(i+1)%4];
    if ((a[0]===b[0]) === (a[1]===b[1])) return null;
  }
  return path.getBounds(null, matrix);
}

function omitRedundantClips(commands) {
  let bounds = null;
  const clips = [], scopes = [], result = [];
  for (const command of commands) {
    const {method,args} = command;
    if (method.startsWith("clip")) {
      const rect = method === "clipPath" ? clipRectangle(args[0],args[2]) : null,
        omit = rect && bounds && rect[0]<=bounds[0] && rect[1]<=bounds[1] && rect[2]>=bounds[2] && rect[3]>=bounds[3];
      clips.push({bounds,omit});
      if (rect) bounds = bounds ? [Math.max(rect[0],bounds[0]),Math.max(rect[1],bounds[1]),Math.min(rect[2],bounds[2]),Math.min(rect[3],bounds[3])] : rect;
      if (omit) continue;
    } else if (method === "popClip") {
      const clip = clips.pop();
      if (!clip) throw Error("绘制指令的裁剪栈不完整。");
      bounds = clip.bounds;
      if (clip.omit) continue;
    } else if (method === "beginMask" || method === "beginTile") {
      // Mask painting and pattern cells have independent drawing extents.
      scopes.push(bounds); bounds = null;
    } else if (method === "endMask" || method === "endTile") {
      bounds = scopes.pop();
      if (method === "endMask") clips.push({bounds,omit:false});
    }
    result.push(command);
  }
  if (clips.length || scopes.length) throw Error("绘制指令的裁剪栈未闭合。");
  return result;
}

// A resolution-independent OFD operator list. Native display-list text bounds
// clipped equations in the embedded-subset regression document. Retaining the
// actual operations avoids that extra text culling while preserving outlines.
export class RenderProgram {
  constructor() {
    this.commands = [];
    this.resources = new Map();
    this.imageBytes = 0;
    this.forms = {
      clipToPage: true,
      paint: (_device, plan, alpha, opacity) =>
        this.gradient("paint", plan, [alpha, opacity]),
      paintWithAlpha: (_device, plan, opacity, bounds) =>
        this.gradient("paintWithAlpha", plan, [opacity, bounds]),
    };
  }
  retain(object) {
    if (!object || typeof object.destroy !== "function") return object;
    const key = `${object.constructor.name}:${object.pointer}`;
    if (this.resources.has(key)) {
      const retained = this.resources.get(key);
      if (retained !== object) object.destroy();
      return retained;
    }
    this.resources.set(key, object);
    if (object instanceof m.Image)
      this.imageBytes += object.getWidth() * object.getHeight() * 4;
    return object;
  }
  gradient(method, plan, args) {
    const spaces = new Map();
    const colors = plan.colors.map(color => {
      let space = color.space;
      // A nested OFD seal's Renderer is destroyed after compiling the seal.
      // Own its ICC spaces independently, just as Device callbacks retain fonts.
      if (color.profile) {
        if (!spaces.has(space)) spaces.set(space,
          this.retain(new m.ColorSpace(color.profile, space.getName())));
        space = spaces.get(space);
      }
      return { ...color, space };
    });
    this.commands.push({ method, plan: {
      matrix: plan.matrix, box: plan.box, colors, geometry: plan.geometry,
    }, args, clipToPage: this.forms.clipToPage });
  }
  compile(renderer, page) {
    const previous = renderer.forms, backendForms = renderer.backend.forms;
    const device = new m.Device(Object.fromEntries(methods.map(method => [method,
      (...args) => {
        this.commands.push({ method, args: args.map(arg => this.retain(arg)) });
        return 0;
      },
    ])));
    renderer.forms = renderer.backend.forms = this.forms;
    try {
      renderer.page(device, page);
      device.close();
      this.commands = omitRedundantClips(this.commands);
      indexRenderBounds(this.commands);
      const used = new Set();
      for (const command of this.commands) {
        for (const arg of command.args) if (arg?.destroy) used.add(arg);
        for (const color of command.plan?.colors || []) used.add(color.space);
      }
      for (const [key, object] of this.resources) {
        if (used.has(object)) continue;
        object.destroy();
        this.resources.delete(key);
      }
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      renderer.forms = previous;
      renderer.backend.forms = backendForms;
      device.destroy();
    }
  }
  run(device, matrix, width, height) {
    return finishRender(this.steps(device, matrix, width, height));
  }
  *steps(device, matrix, width, height) {
    const gradients = new DirectGradients(matrix, width, height),
      inverse = m.Matrix.invert(matrix),
      dx = Math.abs(inverse[0]) + Math.abs(inverse[2]),
      dy = Math.abs(inverse[1]) + Math.abs(inverse[3]),
      viewport = m.Rect.transform([-2, -2, width + 2, height + 2], inverse);
    let deadline = performance.now() + RENDER_SLICE_MS, checked = 0;
    for (let i = 0; i < this.commands.length; i++) {
      if ((checked++ & 15) === 0 && performance.now() >= deadline) {
        yield;
        deadline = performance.now() + RENDER_SLICE_MS;
      }
      const command = this.commands[i];
      if (command.bounds && outside(command.bounds, viewport)) {
        if (command.skipTo !== undefined) { i = command.skipTo; continue; }
        if (command.canCull) continue;
      }
      const { method, args } = command;
      if (command.plan) {
        gradients.clipToPage = command.clipToPage;
        gradients[method](device, command.plan, ...args);
      } else if (method === "beginGroup") {
        const [bounds, ...rest] = args;
        device.beginGroup([bounds[0]-dx, bounds[1]-dy, bounds[2]+dx, bounds[3]+dy], ...rest);
      } else device[method](...args);
    }
  }
  destroy() {
    for (const object of this.resources.values()) object.destroy();
    this.resources.clear();
    this.commands.length = 0;
    this.imageBytes = 0;
  }
}

// Bound both page count and retained image/command volume. Large pages still
// render through the same operator list, then release it instead of caching it.
export class RenderProgramCache {
  constructor() { this.pages = new Map(); }
  get(index) {
    const program = this.pages.get(index);
    if (program) { this.pages.delete(index); this.pages.set(index, program); }
    return program;
  }
  set(index, program) {
    this.pages.set(index, program);
    while (this.pages.size > 3 ||
      [...this.pages.values()].reduce((n, p) => n + p.imageBytes, 0) > 64 * 1024 * 1024 ||
      [...this.pages.values()].reduce((n, p) => n + p.commands.length, 0) > 100000) {
      const first = this.pages.keys().next().value, oldest = this.pages.get(first);
      this.pages.delete(first);
      oldest.destroy();
    }
  }
  destroy() {
    for (const program of this.pages.values()) program.destroy();
    this.pages.clear();
  }
}
