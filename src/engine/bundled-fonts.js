import { attr } from "./archive.js";
import { bundledFonts } from "./font-catalog.js";
import { normalizeFontName } from "./fonts.js";

// Called before rendering. Embedded resources require no font download; explicit
// user replacements are loaded even when the document has an embedded font.
export async function loadBundledFonts(document, store, choices = {}, fontIds = null) {
  const required = new Set();
  for (const [id, resource] of document.resources.fonts) {
    const choice = choices[id] || "auto";
    if (fontIds && !fontIds.has(id) && choice === "auto") continue;
    if (choice !== "auto") {
      required.add(choice);
      continue;
    }
    if (resource.path && document.archive.has(resource.path)) continue;
    const name = attr(resource.node, "FontName");
    const family = attr(resource.node, "FamilyName");
    if (store.match(name, family)) continue;
    for (const font of bundledFonts) {
      if (
        [name, family].some(
          (n) => normalizeFontName(n) === normalizeFontName(font.name),
        )
      )
        required.add(font.id);
    }
  }
  for (const font of bundledFonts) {
    if (!required.has(font.id) || store.faces.has(font.id)) continue;
    const response = await fetch(
      new URL(`../fonts/${font.file}`, import.meta.url),
    );
    if (!response.ok)
      throw new Error(
        `项目字体加载失败：${font.label}（HTTP ${response.status}）`,
      );
    store.import(new Uint8Array(await response.arrayBuffer()), font.id);
  }
}
