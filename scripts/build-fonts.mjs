import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createFontChunks } from '../src/engine/font-chunks.js';

export async function buildFonts(fonts) {
  for (const font of fonts) {
    const result = createFontChunks(new Uint8Array(await readFile(`public/fonts/${font.file}`)));
    const directory = `dist/fonts/${font.id}`;
    await mkdir(`${directory}/${result.revision}`, { recursive: true });
    await writeFile(`${directory}/index.zip`, result.index);
    await Promise.all(result.chunks.map((bytes, id) => writeFile(`${directory}/${result.revision}/${id}.bin`, bytes)));
    console.log(`${font.name}: index ${(result.index.length / 1024).toFixed(1)} KiB, ${result.chunks.length} glyph chunks`);
  }
}
