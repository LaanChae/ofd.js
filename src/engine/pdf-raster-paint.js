import * as m from "mupdf";

const intersect = (a, b) => [
  Math.max(a[0], b[0]), Math.max(a[1], b[1]),
  Math.min(a[2], b[2]), Math.min(a[3], b[3]),
];

export function rasterClip(method, args) {
  const stroke = method === "clipStrokePath" || method === "clipStrokeText";
  const ctm = args[method === "clipPath" || stroke ? 2 : 1];
  const bounds = method === "clipImageMask"
    ? m.Rect.transform([0, 0, 1, 1], ctm)
    : args[0].getBounds(stroke ? args[1] : null, ctm);
  return { method, args, bounds };
}

// Only combinations without a native mapping (currently image-masked shades)
// use sampled paint. Ordinary gradients are handled by pdf-native-shading.js.
export function rasterizePaint(bounds, clips, pageBounds, paint, dpi = 300) {
  let box = intersect(pageBounds, bounds);
  for (const clip of clips) box = intersect(box, clip.bounds);
  if (!box.every(Number.isFinite)) throw new Error("PDF 绘制边界无效。");
  const width = box[2] - box[0], height = box[3] - box[1];
  if (width <= 0 || height <= 0) return null;
  // Reserve two pixels for rounding either edge before allocating native memory.
  const ratio = Math.min(dpi / 72, 8190 / width, 8190 / height,
    Math.sqrt(15.9e6 / (width * height)));
  const pixels = box.map((v, i) => i < 2 ? Math.floor(v * ratio) : Math.ceil(v * ratio));
  const pixmap = new m.Pixmap(m.ColorSpace.DeviceRGB, pixels, true);
  let device;
  try {
    pixmap.clear();
    device = new m.DrawDevice([ratio, 0, 0, ratio, 0, 0], pixmap);
    for (const clip of clips) device[clip.method](...clip.args);
    paint(device);
    for (const clip of clips) device.popClip();
    device.close();
    return {
      bytes: pixmap.asPNG(), dpi: ratio * 72,
      matrix: [(pixels[2] - pixels[0]) / ratio, 0, 0,
        (pixels[3] - pixels[1]) / ratio, pixels[0] / ratio, pixels[1] / ratio],
    };
  } finally {
    device?.destroy();
    pixmap.destroy();
  }
}
