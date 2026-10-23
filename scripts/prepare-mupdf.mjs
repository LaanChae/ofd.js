import { readFile, writeFile } from "node:fs/promises";

// MuPDF.js 1.28.1 retains native arguments in Device callbacks except Shade.
// Its wrapper nevertheless registers a finalizer, which otherwise drops the
// borrowed pointer after the PDF's own shade has already been freed.
const path = new URL("../node_modules/mupdf/dist/mupdf.js", import.meta.url);
const source = await readFile(path, "utf8");
const before = "new Shade(shade), fromMatrix(ctm), alpha";
const after =
  "new Shade(libmupdf._wasm_keep_shade(shade)), fromMatrix(ctm), alpha";
if (source.includes(before)) {
  await writeFile(path, source.replace(before, after));
} else if (!source.includes(after)) {
  throw new Error(
    "MuPDF Shade callback changed; review native ownership before building.",
  );
}

// StructuredText.walk must emit full Unicode scalar values, including CJK
// extension characters and emoji. The upstream wrapper truncated them to UTF-16.
const current = await readFile(path, "utf8");
const charBefore = "String.fromCharCode(libmupdf._wasm_stext_char_get_c(ch))";
const charAfter = "String.fromCodePoint(libmupdf._wasm_stext_char_get_c(ch))";
if (current.includes(charBefore))
  await writeFile(path, current.replace(charBefore, charAfter));
else if (!current.includes(charAfter))
  throw new Error("MuPDF text walker changed; review Unicode extraction.");

// DeviceN has 1..32 components; upstream COLOR only marshals Gray/RGB/CMYK.
// Use the existing native color-space converter without truncating spot colors.
let colors = await readFile(path, 'utf8');
if (colors.includes('const _wasm_color = Malloc(4 * 4) >> 2;')) {
  colors = colors.replace('const _wasm_color = Malloc(4 * 4) >> 2;', 'const _wasm_color = Malloc(32 * 4) >> 2;')
    .replace('if (!Array.isArray(value) || (value.length !== 1 && value.length !== 3 && value.length !== 4))', 'if (!Array.isArray(value) || value.length < 1 || value.length > 32)')
    .replace(/function COLOR\(c\) \{[\s\S]*?\n\}\nfunction ensureOptions/, 'function COLOR(c) {\n\tif (c) for (let i = 0; i < c.length; i++) libmupdf.HEAPF32[_wasm_color + i] = c[i];\n\treturn _wasm_color << 2;\n}\nfunction ensureOptions')
    .replace(/function fromColor\(n\) \{[\s\S]*?\n\}\nfunction fromAnnotColor/, 'function fromColor(n) {\n\tif (n < 1 || n > 32) throw new TypeError("invalid color component count");\n\treturn Array.from({length:n}, (_,i) => libmupdf.HEAPF32[_wasm_color+i]);\n}\nfunction fromAnnotColor');
  await writeFile(path, colors);
} else if (!colors.includes('const _wasm_color = Malloc(32 * 4) >> 2;')) {
  throw new Error('MuPDF color buffer changed; review DeviceN marshalling.');
}
