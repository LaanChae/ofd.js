import * as asn from "asn1js";
import { Certificate, AlgorithmIdentifier } from "pkijs";
import { createSeal, sealPolicy } from "./seal.js";
import { parseASN1, digest, certificateInfo, OfdCrypto } from "./signatures.js";
import { hex, keyAlgorithm, assertSigningCertificate } from "./certificates.js";

const fields = (n) => n?.valueBlock?.value;
const value = (n) => n?.valueBlock?.valueHexView;
export async function inspectSeal(bytes) {
  const root = parseASN1(bytes),
    outer = fields(root),
    info = outer?.[0];
  const f = fields(info),
    header = fields(f?.[0]),
    p = fields(f?.[2]),
    picture = fields(f?.[3]);
  if (
    !(root instanceof asn.Sequence) ||
    outer.length !== 4 ||
    ![4, 5].includes(f?.length) ||
    !(f[0] instanceof asn.Sequence) ||
    header?.length !== 3 ||
    !(header[0] instanceof asn.IA5String) ||
    header[0].valueBlock.value !== "ES" ||
    !(header[1] instanceof asn.Integer) ||
    header[1].valueBlock.valueDec !== 4 ||
    !(header[2] instanceof asn.IA5String) ||
    !(f[1] instanceof asn.IA5String) ||
    !f[1].valueBlock.value ||
    p?.length !== 7 ||
    !(p[0] instanceof asn.Integer) ||
    p[0].valueBlock.valueDec < 1 ||
    !(p[1] instanceof asn.Utf8String) ||
    !(p[2] instanceof asn.Integer) ||
    p[2].valueBlock.valueDec !== 1 ||
    !(p[3] instanceof asn.Sequence) ||
    !p.slice(4).every((t) => t instanceof asn.GeneralizedTime) ||
    picture?.length !== 4 ||
    picture[0].valueBlock.value !== "PNG" ||
    !(picture[1] instanceof asn.OctetString) ||
    !picture
      .slice(2)
      .every(
        (n) =>
          n instanceof asn.Integer &&
          n.valueBlock.valueDec > 0 &&
          n.valueBlock.valueDec <= 1000,
      ) ||
    !(outer[1] instanceof asn.OctetString) ||
    !(outer[3] instanceof asn.BitString) ||
    outer[3].valueBlock.unusedBits !== 0 ||
    !(outer[2] instanceof asn.ObjectIdentifier) ||
    outer[2].valueBlock.toString() !== "1.2.156.10197.1.501"
  )
    throw Error("仅支持完整的 SES v4 / SM2 印章、PNG 图片和完整授权证书列表。");
  if (f[4]) {
    if (!(f[4] instanceof asn.Sequence)) throw Error("印章扩展结构无效。");
    for (const extension of fields(f[4])) {
      const e = fields(extension);
      if (
        !(extension instanceof asn.Sequence) ||
        ![2, 3].includes(e?.length) ||
        !(e[0] instanceof asn.ObjectIdentifier) ||
        !(e.at(-1) instanceof asn.OctetString) ||
        (e.length === 3 && !(e[1] instanceof asn.Boolean))
      )
        throw Error("印章扩展结构无效。");
      if (e.length === 3 && e[1].valueBlock.value)
        throw Error(`尚不支持印章关键扩展 ${e[0].valueBlock.toString()}。`);
    }
  }
  const image = value(picture[1]);
  if (
    !image ||
    image.length < 33 ||
    image.length > 4 * 1048576 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => image[i] === b)
  )
    throw Error("印章 PNG 图片无效或超过 4 MB。");
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (
    !view.getUint32(16) ||
    !view.getUint32(20) ||
    view.getUint32(16) * view.getUint32(20) > 16000000
  )
    throw Error("印章图片超过尺寸限制。");
  const maker = new Certificate({ schema: parseASN1(value(outer[1])) });
  if (
    !(await new OfdCrypto().verifyWithPublicKey(
      info.valueBeforeDecodeView,
      outer[3],
      maker.subjectPublicKeyInfo,
      new AlgorithmIdentifier({ algorithmId: "1.2.156.10197.1.501" }),
      "SM3",
    ))
  )
    throw Error("电子印章制章签名值验证失败，不能导入或使用。");
  const certNodes = fields(p[3]);
  if (
    !certNodes.length ||
    certNodes.length > 100 ||
    !certNodes.every((n) => n instanceof asn.OctetString)
  )
    throw Error("印章授权证书列表无效。");
  const authorized = [];
  for (const node of certNodes) {
    const cert = new Certificate({ schema: parseASN1(value(node)) });
    if (keyAlgorithm(cert).name !== "SM2")
      throw Error("印章授权证书不是 SM2。");
    authorized.push({
      ...certificateInfo(cert, new Date()),
      id: hex(await digest("SHA-256", value(node))),
    });
  }
  const [created, start, end] = p.slice(4).map((n) => n.toDate());
  if (
    ![created, start, end].every((d) => Number.isFinite(+d)) ||
    start > end ||
    created > end
  )
    throw Error("印章时间属性无效。");
  assertSigningCertificate(maker, created);
  return {
    root,
    image: image.slice(),
    metadata: {
      id: hex(await digest("SHA-256", bytes)),
      sealId: f[1].valueBlock.value,
      name: p[1].valueBlock.value,
      type: p[0].valueBlock.valueDec,
      version: 4,
      vendor: header[2].valueBlock.value,
      created: created.toISOString(),
      validFrom: start.toISOString(),
      validTo: end.toISOString(),
      width: picture[2].valueBlock.valueDec,
      height: picture[3].valueBlock.valueDec,
      maker: certificateInfo(maker, new Date()),
      authorized,
    },
  };
}

export class SealStore {
  #entries = new Map();
  list() {
    const now = Date.now();
    return [...this.#entries.values()].map(({ metadata }) =>
      structuredClone({
        ...metadata,
        timeValid:
          Date.parse(metadata.created) <= now &&
          Date.parse(metadata.validFrom) <= now &&
          now <= Date.parse(metadata.validTo),
      }),
    );
  }
  async import(bytes) {
    bytes = new Uint8Array(bytes).slice();
    const { metadata, image } = await inspectSeal(bytes);
    const size = [...this.#entries.values()].reduce(
      (n, e) => n + e.bytes.length,
      0,
    );
    if (
      !this.#entries.has(metadata.id) &&
      (this.#entries.size >= 100 || size + bytes.length > 64 * 1048576)
    )
      throw Error("印章目录最多 100 枚、总计 64 MB。");
    this.#entries.set(metadata.id, { bytes, metadata, image });
    return metadata.id;
  }
  async create(identity, options) {
    return this.import(
      new Uint8Array(createSeal(identity, options).toBER(false)),
    );
  }
  get(id) {
    const entry = this.#entries.get(id);
    if (!entry) throw Error("印章不存在，请重新选择。");
    return structuredClone(entry);
  }
  remove(id) {
    this.#entries.delete(id);
    return this.list();
  }
}

export async function assertUsableSeal(bytes, identity) {
  assertSigningCertificate(identity.cert);
  if (identity.credential.algorithm.name !== "SM2")
    throw Error("电子印章用章证书必须为 SM2。");
  const { root } = await inspectSeal(bytes);
  const policy = await sealPolicy(fields(root)[0], identity.der, new Date());
  if (policy.authorization !== "passed")
    throw Error("所选证书不在此印章的授权用章证书列表中。");
  if (policy.validity !== "passed")
    throw Error("印章尚未生效或已过期，不能用于新签章。");
  return root;
}
