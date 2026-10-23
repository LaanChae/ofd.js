import { attr, bool, child, children, name, resolve, text } from "./archive.js";

export function packageDocuments(archive) {
  const bodies = children(archive.xml("OFD.xml"), "DocBody");
  if (!bodies.length) throw Error("OFD 缺少 DocBody。");
  return bodies.map((body, index) => {
    const versions = children(child(body, "Versions"), "Version").map((ref) => {
      const id = attr(ref, "ID"), file = resolve("OFD.xml", attr(ref, "BaseLoc"));
      const result = { id, index: Number(attr(ref, "Index")), file,
        current: bool(ref, "Current", false), title: id, date: "" };
      try {
        const root = archive.xml(file);
        if (name(root) !== "DocVersion") throw Error("版本描述根节点不是 DocVersion。");
        if (attr(root, "ID") !== id) throw Error("版本入口 ID 与版本描述不一致。");
        result.title = attr(root, "Name", id);
        result.date = attr(root, "CreationDate");
        result.docRoot = resolve(file, text(root, "DocRoot"));
        result.files = children(child(root, "FileList"), "File").map((item) => resolve(file, text(item)));
        if (!result.files.includes(result.docRoot)) throw Error("版本文件列表未包含 DocRoot。");
        for (const path of result.files) if (!archive.has(path)) throw Error(`缺少包内文件：${path}`);
      } catch (error) { result.error = error.message; }
      return result;
    });
    if (new Set(versions.map((v) => v.id)).size !== versions.length)
      throw Error("同一文档内的版本 ID 重复。");
    if (versions.filter((v) => v.current).length > 1)
      archive.warnings.add("同一文档声明多个默认版本，使用列表中的第一个。");
    return { index, title: text(child(body, "DocInfo"), "Title") || `文档 ${index + 1}`,
      id: text(child(body, "DocInfo"), "DocID"),
      docRoot: resolve("OFD.xml", text(body, "DocRoot")), versions };
  });
}

export function selectDocument(archive, selection = {}) {
  const documents = packageDocuments(archive), documentIndex = selection.documentIndex ?? 0;
  if (!Number.isInteger(documentIndex) || !documents[documentIndex]) throw Error("包内文档序号无效。");
  const selected = documents[documentIndex],
    versionId = selection.versionId ?? selected.versions.find((v) => v.current)?.id ?? "",
    version = versionId ? selected.versions.find((v) => v.id === versionId) : null;
  if (versionId && !version) throw Error("所选版本不存在。");
  if (version?.error) throw Error(`无法打开版本：${version.error}`);
  return { documents, selection: { documentIndex, versionId },
    body: children(archive.xml("OFD.xml"), "DocBody")[documentIndex], version,
    docFile: version?.docRoot || selected.docRoot };
}
