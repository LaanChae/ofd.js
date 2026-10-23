import { attr, child, children, resolve } from './archive.js';
import { bundledFonts } from './font-catalog.js';
import { normalizeFontName } from './fonts.js';
import { ChunkedFont } from './font-chunks.js';

// Gather only parsed pages (including templates, annotation appearances,
// patterns, clips and composites). Export prepares every page before calling.
export async function loadBundledFonts(document, store, choices = {}) {
  const required = new Map();
  function collect(doc, selected) {
    for (const [id, resource] of doc.resources.fonts) {
      const choice = selected[id] || 'auto', characters = doc.fontCharacters.get(id);
      if (!characters && choice === 'auto') continue;
      let font;
      if (choice !== 'auto') font = bundledFonts.find(f => f.id === choice);
      else {
        if (resource.path && doc.archive.has(resource.path)) continue;
        const name = attr(resource.node, 'FontName'), family = attr(resource.node, 'FamilyName');
        if (store.match(name, family)?.source === 'imported') continue;
        font = bundledFonts.find(f => [name, family].some(n => normalizeFontName(n) === normalizeFontName(f.name)));
      }
      if (!font) continue;
      if (!required.has(font.id)) required.set(font.id, new Set());
      for (const code of characters || []) required.get(font.id).add(code);
    }
  }
  collect(document, choices);
  const loaded = new Set(document.pages.filter(p => p.loaded).map(p => p.id));
  if (loaded.size) {
    const { file: indexFile, entries } = document.signatureIndex;
    for (const entry of entries) {
      const file = resolve(indexFile, attr(entry, 'BaseLoc')), root = document.archive.xml(file);
      if (!children(child(root, 'SignedInfo'), 'StampAnnot').some(n => loaded.has(attr(n, 'PageRef')))) continue;
      const image = document.signatureImage(file, root);
      if (image?.[0] === 0x50 && image[1] === 0x4b) collect(document.sealDocument(file, image), {});
    }
  }
  for (const font of bundledFonts) {
    const characters = required.get(font.id);
    if (!characters) continue;
    const fetchAsset = async path => {
      const response = await fetch(new URL(`../fonts/${font.id}/${path}`, import.meta.url));
      if (!response.ok) throw Error(`字体分包加载失败：${font.label}（HTTP ${response.status}）`);
      return new Uint8Array(await response.arrayBuffer());
    };
    let bundle = store.bundles.get(font.id);
    if (!bundle) {
      bundle = new ChunkedFont(await fetchAsset('index.zip'), fetchAsset);
      store.bundles.set(font.id, bundle);
    }
    const bytes = await bundle.ensure(characters);
    if (bytes) {
      try { store.import(bytes, font.id); }
      catch (error) { bundle.installed = false; throw error; }
    }
  }
}
