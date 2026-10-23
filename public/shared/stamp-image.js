// Remove a white matte from straight RGBA pixels. Preserve existing alpha and
// recover foreground colours at antialiased edges instead of leaving white halos.
export function removeWhiteBackground(pixels, tolerance = 10) {
  if (
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 80 ||
    pixels.length % 4
  )
    throw Error("去白底容差无效。");
  const result = new Uint8ClampedArray(pixels);
  for (let i = 0; i < result.length; i += 4) {
    const minimum = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    const coverage = (255 - minimum) / 255;
    if (minimum >= 255 - tolerance) {
      result.fill(0, i, i + 4);
      continue;
    }
    for (let c = 0; c < 3; c++)
      result[i + c] = (pixels[i + c] - minimum) / coverage;
    result[i + 3] = pixels[i + 3] * coverage;
  }
  return result;
}
