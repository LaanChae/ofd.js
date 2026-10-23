import * as asn from "asn1js";
import { AttributeTypeAndValue } from "pkijs";
import { certificateFields } from "../../public/shared/certificate-fields.js";

const printable = /^[A-Za-z0-9 '()+,\-./:=?]+$/;
export function createSubject(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject))
    throw Error("请填写证书主体字段。");
  for (const key of Object.keys(subject))
    if (!certificateFields.some((field) => field.key === key))
      throw Error(`未知的证书主体字段：${key}`);
  const result = [];
  for (const field of certificateFields) {
    let value = String(subject[field.key] ?? "").trim();
    if (!value) {
      if (field.required) throw Error(`${field.label}（${field.key}）必填。`);
      continue;
    }
    if (field.key === "C") value = value.toUpperCase();
    if (
      Array.from(value).length > field.maxLength ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw Error(
        `${field.label}（${field.key}）最多 ${field.maxLength} 个字符，不能包含控制字符。`,
      );
    if (field.key === "C" && !/^[A-Z]{2}$/.test(value))
      throw Error("国家或地区代码（C）须为两个英文字母，例如 CN。");
    if (field.encoding === "printable" && !printable.test(value))
      throw Error(`${field.key} 仅支持 PrintableString 字符。`);
    if (field.encoding === "ia5" && !/^[\x20-\x7e]+$/.test(value))
      throw Error(`${field.key} 仅支持 ASCII 字符。`);
    if (field.key === "emailAddress" && !/^[^\s@]+@[^\s@]+$/.test(value))
      throw Error("电子邮箱格式无效。");
    if (
      field.key === "DC" &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)
    )
      throw Error("域组件（DC）填写一个域名标签，例如 example，不含点号。");
    const Type =
      field.encoding === "printable"
        ? asn.PrintableString
        : field.encoding === "ia5"
          ? asn.IA5String
          : asn.Utf8String;
    result.push(
      new AttributeTypeAndValue({
        type: field.oid,
        value: new Type({ value }),
      }),
    );
  }
  return result;
}

export function parseDistinguishedName(name) {
  return name.typesAndValues.map((attribute) => {
    const field = certificateFields.find(
        (field) => field.oid === attribute.type,
      ),
      value = attribute.value.valueBlock.value;
    return {
      oid: attribute.type,
      name: field?.key || attribute.type,
      label: field?.label || "未知字段",
      value:
        typeof value === "string"
          ? value
          : "#" +
            Array.from(new Uint8Array(attribute.value.toBER(false)), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join(""),
    };
  });
}
export function distinguishedNameText(fields) {
  return fields
    .map((field) => `${field.name}=${JSON.stringify(field.value)}`)
    .join(", ");
}
