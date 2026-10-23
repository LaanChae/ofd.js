import {
  parseDistinguishedName,
  distinguishedNameText,
} from "./certificate-name.js";
import { md5 } from "@noble/hashes/legacy";
import { fromBER } from "asn1js";
import {
  Certificate,
  CryptoEngine,
  SignedData,
  AlgorithmIdentifier,
} from "pkijs";
import { sm2, sm3 } from "sm-crypto-v2";
import { sealPolicy, sesTimePolicy } from "./seal.js";
import { attr, child, children, text, resolve } from "./archive.js";

const SM3 = "1.2.156.10197.1.401",
  SM2 = "1.2.156.10197.1.501";
const sm2Algorithms = new Set([SM2, "1.2.156.10197.1.301.1"]);
const hashNames = new Map([
  ["md5", "MD5"],
  ["1.2.840.113549.2.5", "MD5"],
  [SM3, "SM3"],
  ["sm3", "SM3"],
  ["sha1", "SHA-1"],
  ["sha256", "SHA-256"],
  ["sha384", "SHA-384"],
  ["sha512", "SHA-512"],
  ["1.3.14.3.2.26", "SHA-1"],
  ["2.16.840.1.101.3.4.2.1", "SHA-256"],
  ["2.16.840.1.101.3.4.2.2", "SHA-384"],
  ["2.16.840.1.101.3.4.2.3", "SHA-512"],
]);
const bytes = (value) =>
  value instanceof Uint8Array ? value : new Uint8Array(value);
const hex = (value) =>
  Array.from(bytes(value), (v) => v.toString(16).padStart(2, "0")).join("");
const unhex = (value) =>
  Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
const equal = (a, b) => {
  a = bytes(a);
  b = bytes(b);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};
const value = (node) => node?.valueBlock?.valueHexView;
const oid = (node) => node?.valueBlock?.toString();
class Unsupported extends Error {}
export async function digest(algorithm, data) {
  const normalized =
    hashNames.get(String(algorithm).toLowerCase().replace(/-/g, "")) ||
    hashNames.get(algorithm);
  if (!normalized) throw new Unsupported(`尚不支持摘要算法 ${algorithm}`);
  if (normalized === "MD5") return md5(bytes(data));
  return normalized === "SM3"
    ? unhex(sm3(bytes(data)))
    : new Uint8Array(await crypto.subtle.digest(normalized, bytes(data)));
}
export class OfdCrypto extends CryptoEngine {
  constructor() {
    super({ name: "OFD browser crypto", crypto: globalThis.crypto });
  }
  getAlgorithmByOID(id, ...args) {
    return id === SM3 ? { name: "SM3" } : super.getAlgorithmByOID(id, ...args);
  }
  async digest(algorithm, data) {
    return (typeof algorithm === "string"
      ? algorithm
      : algorithm.name
    ).toUpperCase() === "SM3"
      ? (await digest("sm3", data)).buffer
      : super.digest(algorithm, data);
  }
  async verifyWithPublicKey(data, signature, key, algorithm, hash) {
    if (sm2Algorithms.has(algorithm.algorithmId)) {
      if (
        key.algorithm.algorithmId !== "1.2.840.10045.2.1" ||
        oid(key.algorithm.algorithmParams) !== "1.2.156.10197.1.301"
      )
        throw new Error("签名算法与 SM2 公钥曲线不一致。");
      if (hash && hash !== "SM3")
        throw new Error("SM2 签名声明了不一致的摘要算法。");
      return sm2.doVerifySignature(
        bytes(data),
        hex(value(signature)),
        hex(value(key.subjectPublicKey)),
        { der: true, hash: true, userId: "1234567812345678" },
      );
    }
    if (!this.getAlgorithmByOID(algorithm.algorithmId)?.name)
      throw new Unsupported(`尚不支持签名算法 ${algorithm.algorithmId}`);
    return super.verifyWithPublicKey(data, signature, key, algorithm, hash);
  }
}
export function parseASN1(data) {
  data = bytes(data);
  if (!data.length || data.length > 16 * 1048576)
    throw new Error("签名数据为空或超过 16 MB。");
  const parsed = fromBER(data);
  if (parsed.offset !== data.length || parsed.result.error)
    throw new Error("签名 ASN.1 数据损坏或存在尾随数据。");
  let count = 0;
  function walk(n, depth) {
    if (depth > 64 || ++count > 100000)
      throw new Error("签名 ASN.1 结构过于复杂。");
    if (n.idBlock.isConstructed)
      for (const c of n.valueBlock.value || []) walk(c, depth + 1);
  }
  walk(parsed.result, 0);
  return parsed.result;
}
export function certificateInfo(cert, now) {
  const subjectFields = parseDistinguishedName(cert.subject),
    issuerFields = parseDistinguishedName(cert.issuer);
  return {
    der: btoa(
      Array.from(new Uint8Array(cert.toSchema().toBER(false)), (b) =>
        String.fromCharCode(b),
      ).join(""),
    ),
    subject: distinguishedNameText(subjectFields),
    issuer: distinguishedNameText(issuerFields),
    subjectFields,
    issuerFields,
    serial: hex(value(cert.serialNumber)),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    timeValid: now >= cert.notBefore.value && now <= cert.notAfter.value,
    trust: "unknown",
    revocation: "unknown",
  };
}
function checkMethod(declared, actual) {
  if (!declared) return;
  if (
    declared === actual ||
    (sm2Algorithms.has(declared) && sm2Algorithms.has(actual))
  )
    return;
  throw new Error(
    `SignatureMethod（${declared}）与签名值中的算法（${actual}）不一致。`,
  );
}
export async function verifyCms(signature, data, declared='', now=new Date()) {
  const root=parseASN1(signature),type=oid(root.valueBlock.value?.[0]);
  if(!['1.2.840.113549.1.7.2','1.2.156.10197.6.1.4.2.2'].includes(type))throw Error('签名值不是 SignedData。');
  return cms(root,data,declared,now);
}
async function cms(root, data, declared, now) {
  const envelope = root.valueBlock.value;
  const sd = new SignedData({ schema: envelope[1]?.valueBlock.value[0] });
  if (!sd.signerInfos.length || sd.signerInfos.length > 32)
    throw new Error("CMS 签名者数量无效。");
  if (
    sd.encapContentInfo.eContent &&
    !equal(sd.encapContentInfo.eContent.getValue(), data)
  )
    throw new Error("CMS 内封装的数据与当前 Signature.xml 原始字节不一致。");
  const engine = new OfdCrypto(),
    signers = [];
  for (let i = 0; i < sd.signerInfos.length; i++) {
    const signer = sd.signerInfos[i];
    if (!hashNames.has(signer.digestAlgorithm.algorithmId))
      throw new Unsupported(
        `尚不支持摘要算法 ${signer.digestAlgorithm.algorithmId}`,
      );
    checkMethod(declared, signer.signatureAlgorithm.algorithmId);
    if (
      !sd.digestAlgorithms.some(
        (a) => a.algorithmId === signer.digestAlgorithm.algorithmId,
      )
    )
      throw new Error("CMS 摘要算法集合缺失签名者算法。");
    if (
      sm2Algorithms.has(signer.signatureAlgorithm.algorithmId) &&
      signer.digestAlgorithm.algorithmId !== SM3
    )
      throw new Error("SM2 签名必须使用 SM3 摘要。");
    if (signer.signedAttrs) {
      for (const type of ["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4"]) {
        const matches = signer.signedAttrs.attributes.filter(
          (a) => a.type === type,
        );
        if (matches.length !== 1 || matches[0].values.length !== 1)
          throw new Error("CMS 必需签名属性缺失或重复。");
        if (
          type.endsWith(".3") &&
          oid(matches[0].values[0]) !== sd.encapContentInfo.eContentType
        )
          throw new Error("CMS content-type 属性不一致。");
      }
    }
    const checked = await sd.verify(
      {
        signer: i,
        data: bytes(data).slice().buffer,
        checkChain: false,
        extendedMode: true,
      },
      engine,
    );
    signers.push({
      verified: checked.signatureVerified === true,
      algorithm: signer.signatureAlgorithm.algorithmId,
      digest: signer.digestAlgorithm.algorithmId,
      certificate: certificateInfo(checked.signerCertificate, now),
      signatureValue: encode64(value(signer.signature)),
      timestampTokens: (signer.unsignedAttrs?.attributes || [])
        .filter((a) => a.type === "1.2.840.113549.1.9.16.2.14")
        .flatMap((a) => a.values.map((v) => encode64(v.toBER(false)))),
    });
  }
  return {
    certificates: (sd.certificates || [])
      .filter((c) => c instanceof Certificate)
      .map((c) => certificateInfo(c, now).der),
    crls: (sd.crls || [])
      .filter((c) => c.constructor.CLASS_NAME === "CertificateRevocationList")
      .map((c) => encode64(c.toSchema().toBER(false))),
    format: "CMS SignedData",
    verified: signers.every((s) => s.verified),
    signers,
  };
}
function encode64(data) {
  let s = "";
  for (const b of new Uint8Array(data)) s += String.fromCharCode(b);
  return btoa(s);
}
function base64(s) {
  s = s.replace(/\s/g, "");
  if (
    !s ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    throw new Error("CheckValue 不是有效的 Base64。");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function verifySignatures(doc, now = new Date()) {
  const { file: index, entries: items } = doc.signatureIndex;
  const result = {
    checkedAt: now.toISOString(),
    signatures: [],
    trust: "unknown",
    revocation: "unknown",
    timestamp: "not-verified",
  };
  if (!index) return result;
  if (!items.length) return result; // §18.1 permits an empty signature list.
  if (items.length > 100) throw new Error("签名数量超过 100 个。");
  const seen = new Set();
  for (const item of items) {
    const report = {
      id: attr(item, "ID"),
      status: "incomplete",
      references: [],
      crypto: null,
      uncovered: [],
      warnings: [],
    };
    result.signatures.push(report);
    try {
      const file = resolve(index, attr(item, "BaseLoc"));
      report.file = file;
      if (seen.has(file)) throw new Error("签名列表重复引用同一个文件。");
      seen.add(file);
      const root = doc.archive.xml(file),
        info = child(root, "SignedInfo"),
        refs = child(info, "References");
      const refsList = children(refs, "Reference"),
        algorithm = attr(refs, "CheckMethod", "MD5");
      report.claimedTime = text(info, "SignatureDateTime");
      report.digest = algorithm;
      if (
        ["md5", "sha1", "1.2.840.113549.2.5", "1.3.14.3.2.26"].includes(
          algorithm.toLowerCase().replace(/-/g, ""),
        )
      )
        report.warnings.push(
          "文件摘要使用 MD5 或 SHA-1，抗碰撞强度已不足；摘要通过不能排除碰撞攻击。",
        );
      if (!refsList.length || refsList.length > 20000)
        throw new Error("签名引用列表为空或过长。");
      const covered = new Set();
      for (const ref of refsList) {
        const check = { path: attr(ref, "FileRef"), status: "failed" };
        report.references.push(check);
        try {
          const path = resolve(file, check.path);
          check.path = path;
          if (covered.has(path)) throw new Error("重复的签名引用。");
          covered.add(path);
          check.status = equal(
            await digest(algorithm, doc.archive.read(path)),
            base64(text(ref, "CheckValue")),
          )
            ? "passed"
            : "failed";
          if (check.status === "failed")
            check.error = "文件摘要不匹配，文件可能已改变。";
        } catch (e) {
          check.status = e instanceof Unsupported ? "unsupported" : "failed";
          check.error = e.message;
        }
      }
      const signedValue = resolve(file, text(root, "SignedValue"));
      report.uncovered = [...doc.archive.paths()].filter(
        (p) =>
          !covered.has(p) && p !== file && p !== signedValue && p !== index,
      );
      // Coverage is reported separately: OFD.xml and earlier/later signatures are often unsigned.
      if (report.uncovered.length)
        report.warnings.push(
          `${report.uncovered.length} 个包内文件未被本签名引用，不能据此断言整个文件包未被修改。`,
        );
      const asn = parseASN1(doc.archive.read(signedValue)),
        envelope = asn.valueBlock.value;
      const type = oid(envelope?.[0]);
      if (["1.2.840.113549.1.7.2", "1.2.156.10197.6.1.4.2.2"].includes(type))
        report.crypto = await cms(
          asn,
          doc.archive.read(file),
          text(info, "SignatureMethod"),
          now,
        );
      else
        report.crypto = await ses(
          asn,
          doc.archive.read(file),
          text(info, "SignatureMethod"),
          now,
        );
      const sealPath = text(child(info, "Seal"), "BaseLoc");
      if (sealPath && report.crypto.seal) {
        const embedded = asn.valueBlock.value[0].valueBlock.value[1];
        if (
          !equal(
            doc.archive.read(resolve(file, sealPath)),
            embedded.valueBeforeDecodeView,
          )
        )
          throw Error("Seal 文件与签名值内的电子印章不一致。");
      }
      report.status =
        report.references.some((r) => r.status === "failed") ||
        !report.crypto.verified
          ? "failed"
          : report.references.every((r) => r.status === "passed")
            ? "passed"
            : "incomplete";
      if (
        report.crypto.seal &&
        (report.crypto.seal.authorization !== "passed" ||
          report.crypto.seal.validity !== "passed" ||
          report.crypto.seal.signingTimeValidity !== "passed")
      ) {
        report.warnings.push(
          "电子印章授权、有效期或签章声明时间检查未通过，请检查印章详细结果。",
        );
        if (report.status === "passed")
          report.status = [
            report.crypto.seal.authorization,
            report.crypto.seal.validity,
            report.crypto.seal.signingTimeValidity,
          ].includes("failed")
            ? "failed"
            : "incomplete";
      }
      if (report.crypto.signers.some((s) => s.digest === "1.3.14.3.2.26"))
        report.warnings.push("签名使用 SHA-1，算法强度已不足。");
    } catch (e) {
      report.status = report.references.some((r) => r.status === "failed")
        ? "failed"
        : e instanceof Unsupported
          ? "incomplete"
          : "failed";
      report.error = e.message;
    }
  }
  return result;
}
async function ses(root, data, declared, now) {
  const outer = root.valueBlock.value,
    toSign = outer?.[0],
    parts = toSign?.valueBlock?.value;
  const version = parts?.[0]?.valueBlock?.valueDec;
  if (![1, 4].includes(version))
    throw new Unsupported(
      `尚不支持此电子签章格式（版本 ${version ?? "未知"}）。`,
    );
  if (
    (version === 1 && (outer.length !== 2 || parts.length !== 7)) ||
    (version === 4 &&
      (outer.length < 4 ||
        outer.length > 5 ||
        parts.length < 5 ||
        parts.length > 6))
  )
    throw new Error("SES 签名结构无效。");
  const certNode = version === 4 ? outer[1] : parts[5],
    alg = oid(version === 4 ? outer[2] : parts[6]),
    signature = version === 4 ? outer[3] : outer[1];
  if (!sm2Algorithms.has(alg))
    throw new Unsupported(`尚不支持 SES 签名算法 ${alg}`);
  checkMethod(declared, alg);
  if (!equal(await digest("sm3", data), value(parts[3])))
    throw new Error("电子签章 dataHash 与 Signature.xml 原始字节不一致。");
  const cert = new Certificate({ schema: parseASN1(value(certNode)) }),
    engine = new OfdCrypto();
  const verified = await engine.verifyWithPublicKey(
    toSign.valueBeforeDecodeView,
    signature,
    cert.subjectPublicKeyInfo,
    new AlgorithmIdentifier({ algorithmId: alg }),
    "SM3",
  );
  const sealParts = parts[1]?.valueBlock?.value;
  const sealInfo = sealParts?.[0];
  const sealSignature =
    version === 4 ? sealParts?.slice(1) : sealParts?.[1]?.valueBlock?.value;
  if (!sealInfo || sealSignature?.length !== 3)
    throw new Error("电子印章结构无效。");
  const sealCert = new Certificate({
    schema: parseASN1(value(sealSignature[0])),
  });
  const sealAlg = oid(sealSignature[1]);
  if (!sm2Algorithms.has(sealAlg))
    throw new Unsupported(`尚不支持制章签名算法 ${sealAlg}`);
  // v1 signs the seal information, maker certificate and algorithm as one sequence;
  // v4 signs the seal information alone. v1 seal policy is kept explicitly unverified
  // until its producer-specific encoding can be checked against an independent fixture.
  let sealVerified = null;
  if (version === 4)
    sealVerified = await engine.verifyWithPublicKey(
      sealInfo.valueBeforeDecodeView,
      sealSignature[2],
      sealCert.subjectPublicKeyInfo,
      new AlgorithmIdentifier({ algorithmId: sealAlg }),
      "SM3",
    );
  return {
    format: `SES v${version}`,
    verified: verified && sealVerified !== false,
    seal: {
      verified: sealVerified,
      certificate: certificateInfo(sealCert, now),
      ...(version === 4
        ? {
            ...(await sealPolicy(sealInfo, value(certNode), now)),
            ...sesTimePolicy(sealInfo, parts[2], cert, sealCert),
          }
        : {
            authorization: "unknown",
            validity: "unknown",
            signingTimeValidity: "unknown",
          }),
    },
    signers: [
      {
        verified,
        algorithm: alg,
        digest: SM3,
        certificate: certificateInfo(cert, now),
        signatureValue: encode64(value(signature)),
        timestampTokens:
          version === 4 && outer[4]
            ? [
                encode64(
                  value(
                    outer[4].idBlock.tagClass === 3 &&
                      outer[4].idBlock.tagNumber === 0
                      ? outer[4].valueBlock.value[0]
                      : null,
                  ),
                ),
              ]
            : [],
      },
    ],
  };
}
