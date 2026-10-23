import * as asn from "asn1js";
import { sm2 } from "sm-crypto-v2";
import { digest, parseASN1 } from "./signatures.js";
import { Certificate } from "pkijs";
import { assertSigningCertificate, keyAlgorithm } from "./certificates.js";

const seq = (...value) => new asn.Sequence({ value });
const int = (value) => new asn.Integer({ value });
const ia5 = (value) => new asn.IA5String({ value });
const oct = (valueHex) => new asn.OctetString({ valueHex });
const bit = (valueHex) => new asn.BitString({ valueHex });
const seconds = (date) => new Date(Math.floor(+date / 1000) * 1000);
const time = (date) => new asn.GeneralizedTime({ valueDate: seconds(date) });
const alg = () => new asn.ObjectIdentifier({ value: "1.2.156.10197.1.501" });
const der = (node) => new Uint8Array(node.toBER(false));
const sign = (data, identity) =>
  bit(
    Uint8Array.from(
      sm2
        .doSignature(data, identity.credential.key, {
          der: true,
          hash: true,
          userId: "1234567812345678",
        })
        .match(/../g),
      (s) => parseInt(s, 16),
    ),
  );

// GB/T 38540 SES v4. Making a seal is independent of signing a document.
export function createSeal(identity, stamp, now = new Date()) {
  if (identity.credential.algorithm.name !== "SM2")
    throw Error("可见电子印章使用 SM2 / SM3，请选择或创建 SM2 证书。");
  assertSigningCertificate(identity.cert, now);
  const image = new Uint8Array(stamp.image || []);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    image.length < 33 ||
    image.length > 4 * 1048576 ||
    !png.every((v, i) => image[i] === v)
  )
    throw Error("印章须为不超过 4 MB 的 PNG 图片。");
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (
    !view.getUint32(16) ||
    !view.getUint32(20) ||
    view.getUint32(16) * view.getUint32(20) > 16000000
  )
    throw Error("印章图片尺寸无效或超过 1600 万像素。");
  const name = String(stamp.name || "个人电子印章").trim();
  if (!name || name.length > 128) throw Error("印章名称须为 1–128 字。");
  if (
    ![stamp.width, stamp.height].every(
      (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
    )
  )
    throw Error("印章图片显示尺寸须为 1–1000 整数毫米。");
  if (!Number.isSafeInteger(stamp.type) || stamp.type < 1 || stamp.type > 65535)
    throw Error("印章类型须为 1–65535 的整数。");
  if (
    !Array.isArray(stamp.certificates) ||
    !stamp.certificates.length ||
    stamp.certificates.length > 100
  )
    throw Error("请选择 1–100 张授权用章证书。");
  const certificates = stamp.certificates.map(
    (bytes) => new Certificate({ schema: parseASN1(bytes) }),
  );
  const created = seconds(now),
    start = stamp.validFrom ? seconds(new Date(stamp.validFrom)) : created;
  const latest = Math.min(
    +identity.cert.notAfter.value,
    ...certificates.map((c) => +c.notAfter.value),
  );
  const end = stamp.validTo
    ? seconds(new Date(stamp.validTo))
    : seconds(new Date(latest));
  if (
    ![created, start, end].every((d) => Number.isFinite(+d)) ||
    start < created ||
    end <= start ||
    +end > latest
  )
    throw Error(
      "印章有效期须从制章时刻或未来开始，且不超过制章者和授权证书有效期。",
    );
  for (const cert of certificates) {
    assertSigningCertificate(cert, start);
    if (keyAlgorithm(cert).name !== "SM2")
      throw Error("授权用章证书必须为 SM2 证书。");
  }
  const cert = identity.der;
  const info = seq(
    seq(ia5("ES"), int(4), ia5("Paperdesk")),
    ia5(crypto.randomUUID()),
    seq(
      int(stamp.type),
      new asn.Utf8String({ value: name }),
      int(1),
      seq(...stamp.certificates.map((cert) => oct(cert))),
      time(created),
      time(start),
      time(end),
    ),
    seq(
      ia5("PNG"),
      oct(image),
      int(Math.round(stamp.width)),
      int(Math.round(stamp.height)),
    ),
  );
  return seq(info, oct(cert), alg(), sign(der(info), identity));
}

// Record the actual UTC second. Validity endpoints are inclusive; no vendor
// clock delay or artificial signing time is part of the OFD format.
export function sealSigningTime(seal) {
  const properties =
    seal.valueBlock.value[0].valueBlock.value[2].valueBlock.value;
  const created = properties[4].toDate(),
    start = properties[5].toDate(),
    end = properties[6].toDate(),
    now = seconds(new Date());
  if (now < created)
    throw Error("系统时间发生回退，签章时间不能早于制章时间。");
  if (!(start <= now && now <= end))
    throw Error("签章时间不在印章有效期内，请检查系统时间和证书有效期。");
  return now;
}

export async function createSes(data, identity, seal, now) {
  const tbs = seq(
    int(4),
    seal,
    time(now),
    bit(await digest("SM3", data)),
    ia5("OFD"),
  );
  return der(seq(tbs, oct(identity.der), alg(), sign(der(tbs), identity)));
}

// A signed declaration is not a trusted timestamp. Check its internal temporal
// consistency separately from current validity and TSA evidence. Boundaries are
// inclusive here; the old Windows plugin's stricter rule is not an OFD rule.
export function sesTimePolicy(info, timeNode, signer, maker) {
  const p = info.valueBlock?.value?.[2]?.valueBlock?.value;
  if (
    !(timeNode instanceof asn.GeneralizedTime) ||
    p?.length !== 7 ||
    !p.slice(4).every((t) => t instanceof asn.GeneralizedTime)
  )
    return {
      signingTimeValidity: "failed",
      timeReason: "签章或印章时间格式无效。",
    };
  const signedAt = timeNode.toDate(),
    created = p[4].toDate(),
    start = p[5].toDate(),
    end = p[6].toDate();
  const valid =
    [signedAt, created, start, end].every((d) => Number.isFinite(+d)) &&
    created <= signedAt &&
    start <= signedAt &&
    signedAt <= end &&
    start <= end &&
    signer.notBefore.value <= signedAt &&
    signedAt <= signer.notAfter.value &&
    maker.notBefore.value <= created &&
    created <= maker.notAfter.value;
  return {
    signingTime: Number.isFinite(+signedAt)
      ? signedAt.toISOString()
      : undefined,
    signingTimeValidity: valid ? "passed" : "failed",
    ...(!valid
      ? {
          timeReason:
            "签章声明时间不在印章或签名者证书有效期内，或制章时间与签章时间、制章者证书有效期不一致。",
        }
      : {}),
  };
}

export async function sealPolicy(info, signerDer, now) {
  const fields = info.valueBlock?.value;
  if (!Array.isArray(fields) || fields.length < 4)
    return {
      authorization: "unknown",
      validity: "unknown",
      reason: "印章属性结构不完整",
    };
  const header = fields[0].valueBlock?.value,
    p = fields[2].valueBlock?.value;
  if (
    header?.[0]?.valueBlock?.value !== "ES" ||
    header?.[1]?.valueBlock?.valueDec !== 4 ||
    p?.length !== 7
  )
    return {
      authorization: "unknown",
      validity: "unknown",
      reason: "尚不支持此印章属性格式",
    };
  const equal = (a, b) =>
    a?.length === b?.length && a.every((v, i) => v === b[i]);
  const type = p[2].valueBlock.valueDec,
    list = p[3].valueBlock.value;
  let authorized = false;
  if (type === 1)
    authorized = list.some((c) => equal(c.valueBlock.valueHexView, signerDer));
  else if (type === 2) {
    for (const c of list) {
      const [algorithm, hash] = c.valueBlock.value;
      const name =
        algorithm.valueBlock.value || algorithm.valueBlock.toString();
      if (equal(await digest(name, signerDer), hash.valueBlock.valueHexView))
        authorized = true;
    }
  } else
    return {
      authorization: "unknown",
      validity: "unknown",
      reason: "未知授权证书列表类型",
    };
  const created = p[4].toDate(),
    start = p[5].toDate(),
    end = p[6].toDate();
  return {
    name: p[1].valueBlock.value,
    authorization: authorized ? "passed" : "failed",
    validity:
      created <= now && start <= now && now <= end && start <= end
        ? "passed"
        : "failed",
    validFrom: start.toISOString(),
    validTo: end.toISOString(),
  };
}
