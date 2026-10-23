import { line } from "./dialogs.js";

export function certificateLabel(certificate) {
  const fields = certificate.subjectFields;
  return (
    (
      fields.find((field) => field.name === "CN") ||
      fields.find((field) => field.name === "O") ||
      fields[0]
    )?.value || "（未命名证书）"
  );
}
export function propertyRows(parent, rows) {
  const table = document.createElement("div");
  table.className = "ofdFields";
  for (const [label, value, oid] of rows) {
    const row = document.createElement("div");
    row.className = "row";
    const term = line(row, `${label}：`, "span");
    if (oid) term.title = `OID ${oid}`;
    line(row, value || "-", "p");
    table.append(row);
  }
  parent.append(table);
}
export function certificateIdentity(parent, certificate) {
  for (const [label, fields] of [
    ["持有人", certificate.subjectFields],
    ["颁发者", certificate.issuerFields],
  ]) {
    const details = document.createElement("details");
    details.className = "ofdCertificateName";
    const name =
      (
        fields.find((field) => field.name === "CN") ||
        fields.find((field) => field.name === "O") ||
        fields[0]
      )?.value || "（未填写）";
    line(details, `${label}：${name}`, "summary");
    propertyRows(
      details,
      fields.map((field) => [
        `${field.label}（${field.name}）`,
        field.value,
        field.oid,
      ]),
    );
    parent.append(details);
  }
}
