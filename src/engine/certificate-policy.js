import { BasicConstraints } from "pkijs";
import { parseASN1 } from "./signatures.js";

const extension = (cert, id) => cert.extensions?.find((e) => e.extnID === id);
export function assertEncryptionUsage(cert, now=new Date()) {
  const algorithm=cert.subjectPublicKeyInfo.algorithm;
  if(algorithm.algorithmId!=='1.2.840.10045.2.1'||algorithm.algorithmParams?.valueBlock?.toString()!=='1.2.156.10197.1.301')
    throw Error('GM/T 0099 证书加密需要 SM2 证书。');
  if(now<cert.notBefore.value||now>=cert.notAfter.value)throw Error('加密证书当前不在有效期内。');
  const usage=extension(cert,'2.5.29.15');
  if(usage&&!(parseASN1(usage.extnValue.getValue()).valueBlock.valueHexView?.[0]&0x20))
    throw Error('证书 KeyUsage 未允许密钥加密（keyEncipherment），请创建或导入 SM2 加密证书。');
}
export function certificateIsCA(cert) {
  const ext = extension(cert, "2.5.29.19");
  return (
    !!ext &&
    new BasicConstraints({ schema: parseASN1(ext.extnValue.getValue()) }).cA ===
      true
  );
}

// Issuance currently creates end-entity certificates, not subordinate CAs.
// Do not silently drop restrictions from imported CA profiles we cannot reproduce.
export function assertIssuingCertificate(cert, now = new Date()) {
  if (now < cert.notBefore.value || now >= cert.notAfter.value)
    throw Error("颁发者证书当前不在有效期内。");
  if (!certificateIsCA(cert) || !extension(cert, "2.5.29.19").critical)
    throw Error("颁发者须具有关键 BasicConstraints 扩展且 CA=true。");
  const usage = extension(cert, "2.5.29.15");
  const bits =
    usage && parseASN1(usage.extnValue.getValue()).valueBlock.valueHexView;
  if (!bits?.length || !(bits[0] & 0x04))
    throw Error("颁发者 KeyUsage 必须允许签发证书（keyCertSign）。");
  const seen = new Set();
  for (const ext of cert.extensions || []) {
    if (seen.has(ext.extnID)) throw Error("颁发者证书包含重复扩展。");
    seen.add(ext.extnID);
    if (
      [
        "2.5.29.30",
        "2.5.29.33",
        "2.5.29.36",
        "2.5.29.37",
        "2.5.29.54",
      ].includes(ext.extnID)
    )
      throw Error(
        `此 CA 带有当前签发功能不支持的名称、策略或用途约束（${ext.extnID}）。`,
      );
    if (ext.critical && !["2.5.29.19", "2.5.29.15"].includes(ext.extnID))
      throw Error(`此 CA 带有当前签发功能不支持的关键扩展（${ext.extnID}）。`);
  }
}
