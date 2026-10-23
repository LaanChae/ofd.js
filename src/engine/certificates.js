import * as asn from "asn1js";
import { Certificate, CryptoEngine, PFX, PKCS8ShroudedKeyBag } from "pkijs";
import { sm2 } from "sm-crypto-v2";
import { parseASN1, certificateInfo } from "./signatures.js";
import {
  assertIssuingCertificate,
  assertEncryptionUsage,
  certificateIsCA,
} from "./certificate-policy.js";

export const cryptoEngine = () =>
  new CryptoEngine({ name: "OFD signing", crypto: globalThis.crypto });
export const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export const base64 = (bytes) => {
  let result = "";
  for (const b of new Uint8Array(bytes)) result += String.fromCharCode(b);
  return btoa(result);
};
export const fromBase64 = (s) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const encoder = new TextEncoder();
const oid = (node) => node?.valueBlock?.toString();
const data = (node) => node?.valueBlock?.valueHexView;
export function decodePem(bytes) {
  if (!bytes?.length || bytes.length > 16 * 1048576)
    throw Error("证书或密钥文件为空或超过 16 MB。");
  const source = new TextDecoder().decode(bytes);
  if (!source.includes("-----BEGIN")) return [{ label: "DER", bytes }];
  const blocks = [
    ...source.matchAll(
      /-----BEGIN ([A-Z0-9 ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----/g,
    ),
  ].map((m) => ({ label: m[1], bytes: fromBase64(m[2].replace(/\s/g, "")) }));
  if (!blocks.length || blocks.length > 100)
    throw Error("PEM 文件格式无效或证书数量过多。");
  return blocks;
}
export function keyAlgorithm(cert) {
  const alg = cert.subjectPublicKeyInfo.algorithm;
  if (alg.algorithmId === "1.2.840.113549.1.1.1")
    return {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      label: "RSA / SHA-256",
      method: "1.2.840.113549.1.1.11",
    };
  const curve = oid(alg.algorithmParams);
  if (
    alg.algorithmId === "1.2.840.10045.2.1" &&
    curve === "1.2.156.10197.1.301"
  )
    return {
      name: "SM2",
      hash: "SM3",
      label: "SM2 / SM3",
      method: "1.2.156.10197.1.501",
    };
  const curves = {
    "1.2.840.10045.3.1.7": ["P-256", "SHA-256", "1.2.840.10045.4.3.2"],
    "1.3.132.0.34": ["P-384", "SHA-384", "1.2.840.10045.4.3.3"],
    "1.3.132.0.35": ["P-521", "SHA-512", "1.2.840.10045.4.3.4"],
  };
  if (alg.algorithmId === "1.2.840.10045.2.1" && curves[curve]) {
    const [namedCurve, hash, method] = curves[curve];
    return {
      name: "ECDSA",
      namedCurve,
      hash,
      method,
      label: `ECDSA ${namedCurve} / ${hash}`,
    };
  }
  throw Error(`尚不支持此证书的签名算法：${alg.algorithmId} / ${curve || "—"}`);
}
export function assertSigningCertificate(cert, now = new Date()) {
  if (now < cert.notBefore.value || now > cert.notAfter.value)
    throw Error("证书当前不在有效期内，不能用于新签名。");
  const usage = cert.extensions?.find((e) => e.extnID === "2.5.29.15");
  if (usage) {
    const bits = data(parseASN1(usage.extnValue.getValue()));
    if (!bits?.length || !(bits[0] & 0xc0))
      throw Error("证书 KeyUsage 不允许数字签名或内容承诺。");
  }
}
async function importKey(cert, bytes) {
  const algorithm = keyAlgorithm(cert);
  if (algorithm.name === "SM2") {
    const pkcs8 = parseASN1(bytes).valueBlock.value;
    const alg = pkcs8[1]?.valueBlock.value;
    if (
      oid(alg?.[0]) !== "1.2.840.10045.2.1" ||
      oid(alg?.[1]) !== "1.2.156.10197.1.301"
    )
      throw Error("私钥不是 SM2 PKCS#8。");
    const ec = parseASN1(data(pkcs8[2])).valueBlock.value;
    const raw = data(ec[1]);
    if (raw?.length !== 32) throw Error("SM2 私钥长度无效。");
    const key = hex(raw);
    if (
      sm2.getPublicKeyFromPrivateKey(key).toLowerCase() !==
      hex(data(cert.subjectPublicKeyInfo.subjectPublicKey))
    )
      throw Error("私钥与证书不匹配。");
    return { key, algorithm };
  }
  const key = await crypto.subtle.importKey("pkcs8", bytes, algorithm, false, [
    "sign",
  ]);
  if (algorithm.name.startsWith("RSA") && key.algorithm.modulusLength < 2048)
    throw Error("RSA 签名密钥至少需要 2048 位。");
  const publicKey = await crypto.subtle.importKey(
    "spki",
    cert.subjectPublicKeyInfo.toSchema().toBER(false),
    algorithm,
    false,
    ["verify"],
  );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(algorithm, key, challenge);
  if (!(await crypto.subtle.verify(algorithm, publicKey, signature, challenge)))
    throw Error("私钥与证书不匹配。");
  return { key, algorithm };
}
async function decryptKey(bytes, password) {
  const block = decodePem(bytes);
  if (block.length !== 1) throw Error("请选择单个 PKCS#8 私钥。");
  const { label, bytes: der } = block[0];
  const root = parseASN1(der);
  if (
    label === "ENCRYPTED PRIVATE KEY" ||
    (label === "DER" && root.valueBlock.value[0] instanceof asn.Sequence)
  ) {
    const bag = new PKCS8ShroudedKeyBag({ schema: root });
    try {
      await bag.parseInternalValues(
        { password: encoder.encode(password).buffer },
        cryptoEngine(),
      );
    } catch {
      throw Error(
        "私钥解密失败：请检查密码、文件完整性及加密算法（支持 PBES2/AES）。",
      );
    }
    return new Uint8Array(bag.parsedValue.toSchema().toBER(false));
  }
  if (!["PRIVATE KEY", "DER"].includes(label))
    throw Error("请使用 PKCS#8 私钥（PRIVATE KEY 或 ENCRYPTED PRIVATE KEY）。");
  return der;
}
async function readPfx(bytes, password) {
  const pfx = new PFX({ schema: parseASN1(bytes) }),
    engine = cryptoEngine();
  const secret = encoder.encode(password).buffer;
  await pfx.parseInternalValues(
    { password: secret, checkIntegrity: true },
    engine,
  );
  const safe = pfx.parsedValue.authenticatedSafe;
  if (safe.safeContents.length > 100) throw Error("P12 内容数量超过限制。");
  await safe.parseInternalValues(
    { safeContents: safe.safeContents.map(() => ({ password: secret })) },
    engine,
  );
  const certs = [],
    keys = [];
  let count = 0;
  async function readBags(contents, depth = 0) {
    if (depth > 8) throw Error("P12 嵌套过深。");
    for (const bag of contents.safeBags) {
      if (++count > 100) throw Error("P12 条目数量超过限制。");
      switch (bag.bagId) {
        case "1.2.840.113549.1.12.10.1.3":
          if (!(bag.bagValue.parsedValue instanceof Certificate))
            throw Error("P12 包含不支持的证书类型。");
          certs.push(bag.bagValue.parsedValue);
          break;
        case "1.2.840.113549.1.12.10.1.1":
          keys.push(new Uint8Array(bag.bagValue.toSchema().toBER(false)));
          break;
        case "1.2.840.113549.1.12.10.1.2":
          await bag.bagValue.parseInternalValues({ password: secret }, engine);
          keys.push(
            new Uint8Array(bag.bagValue.parsedValue.toSchema().toBER(false)),
          );
          break;
        case "1.2.840.113549.1.12.10.1.6":
          await readBags(bag.bagValue, depth + 1);
          break;
      }
    }
  }
  for (const content of safe.parsedValue.safeContents)
    await readBags(content.value);
  if (!certs.length || !keys.length)
    throw Error("P12 必须包含证书及对应私钥。");
  return { certs, keys };
}
export class CertificateStore {
  entries = new Map();
  async import({ bytes, format = "certificate", privateKey, password = "" }) {
    let certs,
      keys = [];
    if (format === "p12") {
      try {
        ({ certs, keys } = await readPfx(bytes, password));
      } catch (e) {
        throw Error(
          `P12 导入失败：密码错误、文件损坏或加密算法不受支持（支持 PBES2/AES）。${e.message}`,
        );
      }
    } else {
      certs = decodePem(bytes).map((b) => {
        if (!["CERTIFICATE", "DER"].includes(b.label))
          throw Error("请选择 X.509 证书（PEM / DER）。");
        return new Certificate({ schema: parseASN1(b.bytes) });
      });
      if (privateKey?.length) keys.push(await decryptKey(privateKey, password));
    }
    const staged = [];
    const matched = new Set();
    try {
      for (const cert of certs) {
        const der = new Uint8Array(cert.toSchema().toBER(false));
        const id = hex(await crypto.subtle.digest("SHA-256", der));
        let credential;
        for (let i = 0; i < keys.length; i++) {
          try {
            credential = await importKey(cert, keys[i]);
            matched.add(i);
            break;
          } catch {
            /* Try each certificate in a chain; commit only if every key matches. */
          }
        }
        let algorithm;
        try {
          algorithm = keyAlgorithm(cert).label;
        } catch {
          algorithm = cert.subjectPublicKeyInfo.algorithm.algorithmId;
        }
        staged.push({ id, cert, der, credential, algorithm });
      }
      if (matched.size !== keys.length)
        throw Error(
          "私钥与证书不匹配，或密钥算法不受支持（RSA ≥2048、ECDSA、SM2）。",
        );
      if (
        new Set([...this.entries.keys(), ...staged.map((e) => e.id)]).size > 100
      )
        throw Error("最多保存 100 张证书。");
      for (const entry of staged) {
        entry.credential ||= this.entries.get(entry.id)?.credential;
        entry.trusted = this.entries.get(entry.id)?.trusted || false;
        this.entries.set(entry.id, entry);
      }
      return this.list();
    } finally {
      for (const key of keys) key.fill(0);
    }
  }
  list() {
    return [...this.entries.values()].map((e) => {
      let issueReason = "",
        canSign = false, canEncrypt = false, encryptionReason = '';
      try {assertEncryptionUsage(e.cert);canEncrypt=true;}catch(error){encryptionReason=error.message;}
      try {
        this.issuingIdentity(e.id);
      } catch (error) {
        issueReason = error.message;
      }
      try {
        this.signingIdentity(e.id);
        canSign = true;
      } catch {
        /* Display eligibility without changing the store. */
      }
      return {
        ...certificateInfo(e.cert, new Date()),
        id: e.id,
        der: base64(e.der),
        algorithm: e.algorithm,
        hasKey: !!e.credential,
        trusted: !!e.trusted,
        isCA: certificateIsCA(e.cert),
        canIssue: !issueReason,
        issueReason,
        canSign,
        canEncrypt,
        canDecrypt: e.credential?.algorithm.name === 'SM2',
        encryptionReason,
      };
    });
  }
  trust(id, trusted) {
    const entry = this.entries.get(id);
    if (!entry) throw Error("证书不存在。");
    entry.trusted = trusted === true;
    return this.list();
  }
  remove(id) {
    this.entries.delete(id);
    return this.list();
  }
  lock(id) {
    const entry = this.entries.get(id);
    if (entry) entry.credential = null;
    return this.list();
  }
  signingIdentity(id) {
    const entry = this.entries.get(id);
    if (!entry?.credential) throw Error("请先导入此证书对应的私钥。");
    assertSigningCertificate(entry.cert);
    return entry;
  }
  issuingIdentity(id) {
    const entry = this.entries.get(id);
    if (!entry?.credential) throw Error("请先导入颁发者证书及对应私钥。");
    assertIssuingCertificate(entry.cert);
    return entry;
  }
}
