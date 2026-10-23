import * as asn from "asn1js";
import {
  Certificate,
  Extension,
  BasicConstraints,
  AuthorityKeyIdentifier,
  PrivateKeyInfo,
  PKCS8ShroudedKeyBag,
} from "pkijs";
import { sm2 } from "sm-crypto-v2";
import { zipSync, strToU8 } from "fflate";
import { cryptoEngine, base64 } from "./certificates.js";
import { createSubject } from "./certificate-name.js";
import { parseASN1, OfdCrypto } from "./signatures.js";

const unhex = (s) => Uint8Array.from(s.match(/../g), (v) => parseInt(v, 16));
const oid = (value) => new asn.ObjectIdentifier({ value });
const pem = (label, bytes) =>
  `-----BEGIN ${label}-----\n${base64(bytes)
    .match(/.{1,64}/g)
    .join("\n")}\n-----END ${label}-----\n`;

// Only the requested backup leaves the worker. Session keys are re-imported non-extractable.
export async function createCertificate(
  store,
  {
    subject,
    algorithm = "SM2",
    days = 365,
    password = "",
    type = "self-signed",
    issuerId,
    purpose = 'sign',
  },
) {
  const subjectAttributes = createSubject(subject);
  if (!["self-signed", "root-ca", "issued"].includes(type))
    throw Error("证书创建方式无效。");
  if (type !== "issued" && issuerId)
    throw Error("自签名证书不应指定其他颁发者。");
  const issuer = type === "issued" ? store.issuingIdentity(issuerId) : null;
  const isCA = type === "root-ca";
  if(!['sign','encrypt'].includes(purpose))throw Error('证书用途无效。');
  if(purpose==='encrypt'&&(isCA||algorithm!=='SM2'))throw Error('文档加密证书必须是 SM2 终端证书。');
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw Error("有效期须为 1–3650 天。");
  if (
    typeof password !== "string" ||
    password.length > 1024
  )
    throw Error("备份密码须为字符串，最多 1024 个字符，可留空。");
  if (!["SM2", "ECDSA", "RSA"].includes(algorithm))
    throw Error("不支持的密钥算法。");
  const cert = new Certificate({ version: 2 });
  const serial = crypto.getRandomValues(new Uint8Array(20));
  serial[0] = serial[0] & 0x7f || 1;
  cert.serialNumber = new asn.Integer({ valueHex: serial });
  cert.subject.typesAndValues.push(...subjectAttributes);
  cert.issuer = issuer?.cert.subject || cert.subject;
  cert.notBefore.value = new Date(Date.now() - 60000);
  cert.notAfter.value = new Date(Date.now() + days * 86400000);
  if (issuer) {
    cert.notBefore.value = new Date(
      Math.max(+cert.notBefore.value, +issuer.cert.notBefore.value),
    );
    cert.notAfter.value = new Date(
      Math.min(+cert.notAfter.value, +issuer.cert.notAfter.value),
    );
  }
  cert.extensions = [
    new Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: new BasicConstraints(
        isCA ? { cA: true, pathLenConstraint: 0 } : { cA: false },
      )
        .toSchema()
        .toBER(false),
    }),
    new Extension({
      extnID: "2.5.29.15",
      critical: true,
      extnValue: new asn.BitString({
        valueHex: new Uint8Array([isCA ? 0x06 : purpose==='encrypt' ? 0x20 : 0xc0]),
        unusedBits: isCA ? 1 : purpose==='encrypt' ? 5 : 6,
      }).toBER(false),
    }),
  ];
  let privateDer, credential;
  try {
    if (algorithm === "SM2") {
      const pair = sm2.generateKeyPairHex();
      cert.subjectPublicKeyInfo.algorithm.algorithmId = "1.2.840.10045.2.1";
      cert.subjectPublicKeyInfo.algorithm.algorithmParams = oid(
        "1.2.156.10197.1.301",
      );
      cert.subjectPublicKeyInfo.subjectPublicKey = new asn.BitString({
        valueHex: unhex(pair.publicKey),
      });
      const ec = new asn.Sequence({
        value: [
          new asn.Integer({ value: 1 }),
          new asn.OctetString({ valueHex: unhex(pair.privateKey) }),
        ],
      });
      privateDer = new Uint8Array(
        new asn.Sequence({
          value: [
            new asn.Integer({ value: 0 }),
            cert.subjectPublicKeyInfo.algorithm.toSchema(),
            new asn.OctetString({ valueHex: ec.toBER(false) }),
          ],
        }).toBER(false),
      );
      credential = { key: pair.privateKey, algorithm: { name: "SM2" } };
    } else {
      const params =
        algorithm === "RSA"
          ? {
              name: "RSASSA-PKCS1-v1_5",
              modulusLength: 3072,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            }
          : { name: "ECDSA", namedCurve: "P-256" };
      const pair = await crypto.subtle.generateKey(params, true, [
        "sign",
        "verify",
      ]);
      privateDer = new Uint8Array(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      );
      await cert.subjectPublicKeyInfo.importKey(pair.publicKey, cryptoEngine());
      credential = {
        key: pair.privateKey,
        algorithm: { name: params.name, hash: "SHA-256" },
      };
    }
    const subjectKeyId = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-1",
        cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
      ),
    );
    const issuerKeyExtension = issuer?.cert.extensions?.find(
      (e) => e.extnID === "2.5.29.14",
    );
    const authorityKeyId = issuerKeyExtension
      ? parseASN1(issuerKeyExtension.extnValue.getValue()).getValue()
      : issuer
        ? await crypto.subtle.digest(
            "SHA-1",
            issuer.cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock
              .valueHexView,
          )
        : subjectKeyId;
    cert.extensions.push(
      new Extension({
        extnID: "2.5.29.14",
        extnValue: new asn.OctetString({ valueHex: subjectKeyId }).toBER(false),
      }),
      new Extension({
        extnID: "2.5.29.35",
        extnValue: new AuthorityKeyIdentifier({
          keyIdentifier: new asn.OctetString({ valueHex: authorityKeyId }),
        })
          .toSchema()
          .toBER(false),
      }),
    );
    const signer = issuer?.credential || credential;
    if (signer.algorithm.name === "SM2") {
      cert.signature.algorithmId = cert.signatureAlgorithm.algorithmId =
        "1.2.156.10197.1.501";
      cert.tbsView = new Uint8Array(cert.encodeTBS().toBER(false));
      cert.signatureValue = new asn.BitString({
        valueHex: unhex(
          sm2.doSignature(cert.tbsView, signer.key, {
            der: true,
            hash: true,
            userId: "1234567812345678",
          }),
        ),
      });
    } else {
      await cert.sign(signer.key, signer.algorithm.hash, cryptoEngine());
    }
    if (!(await cert.verify(issuer?.cert || cert, new OfdCrypto())))
      throw Error("新证书签名自检失败，未保存证书。");
    const keyFile = password ? "private-key.encrypted.pem" : "private-key.pem";
    let keyPem;
    if (password) {
      const encrypted = new PKCS8ShroudedKeyBag({
        parsedValue: new PrivateKeyInfo({ schema: parseASN1(privateDer) }),
      });
      await encrypted.makeInternalValues(
        {
          password: strToU8(password).buffer,
          contentEncryptionAlgorithm: { name: "AES-CBC", length: 256 },
          hmacHashAlgorithm: "SHA-256",
          iterationCount: 210000,
        },
        cryptoEngine(),
      );
      // EncryptedPrivateKeyInfo is DER: CMS's segmented OCTET STRING is not valid here.
      encrypted.encryptedData = new asn.OctetString({
        valueHex: encrypted.encryptedData.getValue(),
      });
      keyPem = pem("ENCRYPTED PRIVATE KEY", encrypted.toSchema().toBER(false));
    } else {
      keyPem = pem("PRIVATE KEY", privateDer);
    }
    const der = new Uint8Array(cert.toSchema().toBER(false));
    const backupFiles = {
      "certificate.pem": strToU8(pem("CERTIFICATE", der)),
      [keyFile]: strToU8(keyPem),
      "README.txt": strToU8(
        `这是本地${issuer ? "由所选 CA 签发" : isCA ? "生成的自签名根 CA" : "生成的自签名"}证书，不会自动获得本机或系统信任。恢复时分别导入 certificate.pem 和 ${keyFile}，${password ? "并输入备份密码。" : "密码留空。私钥未加密，任何拿到该文件的人都能使用它。"}${issuer ? "issuer.pem 是颁发者的公开证书，可单独导入用于构建证书链，不含 CA 私钥。" : ""}私钥不会保存在浏览器持久存储中。`,
      ),
    };
    if (issuer)
      backupFiles["issuer.pem"] = strToU8(pem("CERTIFICATE", issuer.der));
    const backup = zipSync(backupFiles);
    const certificates = await store.import({
      bytes: der,
      privateKey: privateDer,
    });
    return { certificates, backup };
  } finally {
    privateDer?.fill(0);
  }
}
