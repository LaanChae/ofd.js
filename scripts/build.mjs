import { build } from "esbuild";
import "./prepare-mupdf.mjs";
import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bundledFonts } from "../src/engine/font-catalog.js";
const availableFonts = bundledFonts.filter(font => existsSync(`public/fonts/${font.file}`));
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", {
  recursive: true,
  filter: path => !path.endsWith(".map") && !path.endsWith(".DS_Store") &&
    !path.endsWith("/fonts/provenance.json") && !path.endsWith("/fonts/README.md"),
});
await cp("licenses", "dist/licenses", { recursive: true });
await mkdir("dist/vendor/mupdf", { recursive: true });
for (const file of ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"])
  await cp(`node_modules/mupdf/dist/${file}`, `dist/vendor/mupdf/${file}`);
await cp("node_modules/mupdf/LICENSE", "dist/licenses/mupdf-LICENSE");
await build({
  entryPoints: ["src/engine/worker.js"],
  outfile: "dist/engine/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  alias: { mupdf: "/vendor/mupdf/mupdf.js" },
  external: ["/vendor/mupdf/mupdf.js"],
  plugins: [{
    name: "available-project-fonts",
    setup(build) {
      build.onLoad({ filter: /[/\\]font-catalog\.js$/ }, () => ({
        contents: `export const bundledFonts = ${JSON.stringify(availableFonts)};`,
        loader: "js",
      }));
    },
  }],
  logLevel: "info",
});

await build({
  entryPoints: ["src/engine/security-worker.js"],
  outfile: "dist/engine/security-worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
