export const fmt = (n) => {
  if (!Number.isFinite(n)) throw new Error("PDF 包含无效坐标。");
  return Number(n.toFixed(7)).toString();
};
export const matrixText = (matrix) => matrix.map(fmt).join(" ");
export const esc = (s) =>
  String(s)
    // PDF metadata can contain NUL/control codes and lone UTF-16 surrogates;
    // these are not legal XML 1.0, even when escaped as numeric references.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, "\u25a1")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
