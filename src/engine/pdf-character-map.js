// OFD TextCode is XML 1.0 text. U+FFFD is legal, but carries no recoverable
// character identity when the PDF already uses it for an unknown character.
export function usableUnicode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
    (value >= 32 || [9, 10, 13].includes(value)) &&
    !(value >= 0xd800 && value <= 0xdfff) &&
    ![0xfffd, 0xfffe, 0xffff].includes(value);
}

export function reverseCharacterMap(font) {
  const result = new Map();
  // PDF subsets commonly omit cmap entirely. Glyph indices are not Unicode.
  if (!font.directory.tables.cmap) return result;
  for (const code of font.characterSet) {
    if (!usableUnicode(code)) continue;
    const gid = font.glyphForCodePoint(code).id;
    if (!gid) continue;
    // Aliases are ambiguous: never choose the first of several candidates.
    if (!result.has(gid)) result.set(gid, code);
    else if (result.get(gid) !== code) result.set(gid, null);
  }
  return result;
}
