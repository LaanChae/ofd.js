import { attr, child, children, text } from "./archive.js";

// Preserve the OFD declarations, including non-standard values tolerated by
// the reader. Do not substitute converter metadata or interpret date timezones.
export function readDocumentProperties(entry, body) {
  const info = child(body, "DocInfo");
  return {
    version: attr(entry, "Version"),
    docType: attr(entry, "DocType"),
    namespace: entry.namespaceURI || "",
    docRoot: text(body, "DocRoot"),
    signatures: text(body, "Signatures"),
    docInfo: Object.fromEntries(
      [
        "DocID",
        "Title",
        "Author",
        "Subject",
        "Abstract",
        "CreationDate",
        "ModDate",
        "DocUsage",
        "Cover",
        "Creator",
        "CreatorVersion",
      ].map((key) => [key, text(info, key)]),
    ),
    keywords: children(child(info, "Keywords"), "Keyword").map((node) =>
      text(node),
    ),
    customData: children(child(info, "CustomDatas"), "CustomData").map(
      (node) => ({
        name: attr(node, "Name"),
        value: text(node),
      }),
    ),
  };
}
