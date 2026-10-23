import {
  Certificate,
  CertificateChainValidationEngine,
  CertificateRevocationList,
  OCSPResponse,
  BasicOCSPResponse,
  CertID,
  SignedData,
  ContentInfo,
  TSTInfo,
} from "pkijs";
import { OctetString } from "asn1js";
import {
  OfdCrypto,
  parseASN1,
  certificateInfo,
  digest,
  verifySignatures,
} from "./signatures.js";
import {
  decodePem,
  base64,
  fromBase64,
  hex,
  assertSigningCertificate,
} from "./certificates.js";
import {certificateIssuers,certificateKey,uniqueCertificates,timestampCertificates} from './certificate-evidence.js';

const engine = () => new OfdCrypto();
const der = (c) => new Uint8Array(c.toSchema().toBER(false));
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const same = (a, b) => equal(der(a), der(b));
const certificate = (s) =>
  new Certificate({ schema: parseASN1(fromBase64(s)) });
const ext = (c, id) => c.extensions?.find((e) => e.extnID === id);
const unknown = (reason) => ({ status: "unknown", reason });

export function parseEvidence(bytes, type) {
  if (!["crl", "ocsp"].includes(type)) throw Error("验证材料类型无效。");
  return decodePem(bytes).map((block) => {
    const root = parseASN1(block.bytes);
    if (type === "crl") return new CertificateRevocationList({ schema: root });
    const response = new OCSPResponse({ schema: root });
    if (
      response.responseStatus.valueBlock.valueDec !== 0 ||
      response.responseBytes?.responseType !== "1.3.6.1.5.5.7.48.1.1"
    )
      throw Error("OCSP 响应未成功或响应类型不受支持。");
    return new BasicOCSPResponse({
      schema: parseASN1(response.responseBytes.response.getValue()),
    });
  });
}

export async function revocationStatus(
  cert,
  issuer,
  context,
  date = new Date(),
) {
  if (!issuer) return unknown("缺少颁发者证书，无法核验吊销材料");
  const notes = [],
    findings = [];
  for (const crl of context.crls || []) {
    if (!crl.issuer.isEqual(issuer.subject)) continue;
    try {
      const extensions = crl.crlExtensions?.extensions || [];
      if(extensions.some(e=>e.critical&&!['2.5.29.20','2.5.29.35','2.5.29.27','2.5.29.28'].includes(e.extnID)))throw Error('CRL 含未支持的关键扩展');
      if (extensions.some((e) => ["2.5.29.27", "2.5.29.28"].includes(e.extnID)))
        throw Error("暂不处理增量、间接或分区 CRL");
      if (
        crl.thisUpdate.value > date ||
        !crl.nextUpdate ||
        crl.nextUpdate.value < date ||
        crl.nextUpdate.value < crl.thisUpdate.value
      )
        throw Error("CRL 尚未生效、已过期或没有 nextUpdate");
      const usage = ext(issuer, "2.5.29.15");
      if (
        usage &&
        !(parseASN1(usage.extnValue.getValue()).valueBlock.valueHexView[0] & 2)
      )
        throw Error("CRL 颁发者没有 cRLSign 用途");
      if (!(await crl.verify({ issuerCertificate: issuer }, engine())))
        throw Error("CRL 签名不正确");
      if (
        (crl.revokedCertificates || []).some((r) =>
          r.crlEntryExtensions?.extensions.some(
            (e) => e.extnID === "2.5.29.29" || e.critical,
          ),
        )
      )
        throw Error("CRL 条目包含未支持的扩展");
      const revoked = crl.revokedCertificates?.find(
        (r) =>
          r.userCertificate.isEqual(cert.serialNumber) &&
          r.revocationDate.value <= date,
      );
      findings.push({
        status: revoked ? "revoked" : "good",
        source: "CRL",
        thisUpdate: crl.thisUpdate.value.toISOString(),
        nextUpdate: crl.nextUpdate.value.toISOString(),
      });
    } catch (e) {
      notes.push(e.message);
    }
  }
  for (const ocsp of context.ocsps || []) {
    try {
      const matching = [];
      for (const response of ocsp.tbsResponseData.responses) {
        const id = new CertID();
        const hash = engine().getAlgorithmByOID(
          response.certID.hashAlgorithm.algorithmId,
        )?.name;
        if (!hash) continue;
        await id.createForCertificate(
          cert,
          { hashAlgorithm: hash, issuerCertificate: issuer },
          engine(),
        );
        if (id.isEqual(response.certID)) matching.push(response);
      }
      if (!matching.length) continue;
      if (matching.length !== 1) throw Error("OCSP 对同一证书包含重复状态");
      const response = matching[0];
      if (
        ocsp.tbsResponseData.producedAt > date ||
        response.thisUpdate > date ||
        (response.nextUpdate ? response.nextUpdate < date || response.nextUpdate < response.thisUpdate : date-response.thisUpdate > 86400000) ||
        ocsp.tbsResponseData.producedAt < response.thisUpdate
      )
        throw Error("OCSP 响应尚未生效或已过期（无 nextUpdate 时最多接受 24 小时内的状态）");
      if (
        [
          ...(ocsp.tbsResponseData.responseExtensions || []),
          ...(response.singleExtensions || []),
        ].some((e) => e.critical)
      )
        throw Error("OCSP 含未支持的关键扩展");
      // Some responders omit their certificate. Candidate certificates remain untrusted here.
      const copy = new BasicOCSPResponse({ schema: parseASN1(der(ocsp)) });
      const candidates = [...(copy.certs || []), issuer, ...context.certs];
      let authenticated = false;
      for (const candidate of candidates) {
        copy.certs = [candidate];
        try {
          if (
            !(await copy.verify(
              { trustedCerts: context.anchors, issuerCerts: candidates },
              engine(),
            ))
          )
            continue;
          if (!same(candidate, issuer)) {
            const noCheck = ext(candidate, "1.3.6.1.5.5.7.48.1.5");
            if (noCheck) {
              const nullValue = parseASN1(noCheck.extnValue.getValue());
              if (
                nullValue.idBlock.tagClass !== 1 ||
                nullValue.idBlock.tagNumber !== 5 ||
                nullValue.lenBlock.length !== 0
              )
                continue;
            } else {
              // Do not recursively ask this responder to vouch for its own revocation.
              const delegate = await validateCertificate(
                candidate,
                { ...context, certs: candidates, ocsps: [] },
                date,
              );
              if (
                delegate.trust !== "trusted" ||
                !["good", "not-applicable"].includes(delegate.revocation)
              )
                continue;
            }
          }
          authenticated = true;
          break;
        } catch {
          /* Try other matching responder certificates. */
        }
      }
      if (!authenticated)
        throw Error("OCSP 响应者的签名、授权、证书链或自身吊销状态未确认");
      const tag = response.certStatus.idBlock.tagNumber;
      findings.push({
        status: tag === 0 ? "good" : tag === 1 ? "revoked" : "unknown",
        source: "OCSP",
        thisUpdate: response.thisUpdate.toISOString(),
        nextUpdate: response.nextUpdate?.toISOString(),
      });
    } catch (e) {
      notes.push(e.message);
    }
  }
  return (
    findings.find((f) => f.status === "revoked") ||
    findings.find((f) => f.status === "good") ||
    unknown(notes.join("；") || "缺少与此证书匹配且有效的 CRL / OCSP 材料")
  );
}

export async function validateCertificate(
  cert,
  context,
  date = new Date(),
  signing = true,
) {
  const result = {
    trust: "unknown",
    revocation: "unknown",
    checkedAt: date.toISOString(),
    path: [],
  };
  try {
    if (date < cert.notBefore.value || date > cert.notAfter.value)
      throw Error("证书在验证时间不处于有效期内");
    if (signing) assertSigningCertificate(cert, date);
    let path;
    const pinned = context.anchors.find((c) => same(c, cert));
    if (
      pinned &&
      cert.subject.isEqual(cert.issuer) &&
      (await cert.verify(cert, engine()))
    ) {
      // Exact, explicitly pinned self-signed identity. This is local trust, not a CA claim.
      if (
        (cert.extensions || []).some(
          (e) =>
            e.critical &&
            !["2.5.29.19", "2.5.29.15", "2.5.29.37"].includes(e.extnID),
        )
      )
        throw Error("自签名证书含未支持的关键扩展");
      path = [cert];
      result.source = "本机显式信任的自签名证书";
    } else {
      const candidates = [...context.certs.filter((c) => !same(c, cert)), cert];
      const validation = await new CertificateChainValidationEngine({
        certs: candidates,
        trustedCerts: context.anchors,
        checkDate: date,
      }).verify({ passedWhenNotRevValues: true }, engine());
      if (!validation.result) {
        // Keep diagnostic candidate paths and revocation checks independent of
        // local trust. A verified issuer signature never creates a trust anchor.
        path=[cert];const seen=new Set([certificateKey(cert)]),pool=uniqueCertificates([...candidates,...context.anchors]);
        for(let i=0;i<16;i++) {
          const issuers=await certificateIssuers(path.at(-1),pool),next=issuers.find(c=>!seen.has(certificateKey(c)));
          if(!next)break;path.push(next);seen.add(certificateKey(next));
        }
        const tail=path.at(-1),selfSigned=tail.subject.isEqual(tail.issuer)&&await tail.verify(tail,engine());
        result.reason=(!context.anchors.length?'本机尚未设置任何信任锚。':'')+(selfSigned?'证书链末端的根证书尚未被设为本机信任锚，请核对指纹后在证书管理中设置。':`缺少可验证的颁发者证书或证书链不符合要求：${certificateInfo(tail,date).issuer}。`);
        result.detail=validation.resultMessage;
      } else {
        path = validation.certificatePath;
        if (!path?.length || !context.anchors.some((c) => same(c, path.at(-1))))throw Error("证书链没有终止于本机信任锚");
        result.source = "本机信任锚";
      }
    }
    if(result.source)result.trust = "trusted";
    for (let i = 0; i < path.length; i++) {
      const revocation =
        i === path.length - 1 && result.trust==='trusted'
          ? { status: "not-applicable", reason: "信任锚由本机信任设置管理" }
          : await revocationStatus(path[i], path[i + 1], context, date);
      result.path.push({ ...certificateInfo(path[i], date), revocation });
    }
    const statuses = result.path.map((p) => p.revocation.status);
    result.revocation = statuses.includes("revoked")
      ? "revoked"
      : statuses.includes("unknown")
        ? "unknown"
          : path.length === 1 && result.trust==='trusted'
          ? "not-applicable"
          : "good";
    return result;
  } catch (e) {
    return { ...result, trust: "failed", reason: e.message };
  }
}

async function checkEssBinding(signer, cert) {
  const attributes = signer.signedAttrs?.attributes || [];
  const bindings = attributes.filter((a) =>
    ["1.2.840.113549.1.9.16.2.12", "1.2.840.113549.1.9.16.2.47"].includes(
      a.type,
    ),
  );
  if (!bindings.length) throw Error("时间戳缺少 ESS 签名证书绑定属性");
  if (new Set(bindings.map((b) => b.type)).size !== bindings.length)
    throw Error("时间戳 ESS 属性重复");
  for (const binding of bindings) {
    if (binding.values.length !== 1) throw Error("时间戳 ESS 属性结构无效");
    const entry =
      binding.values[0].valueBlock.value?.[0]?.valueBlock.value?.[0]?.valueBlock
        .value;
    if (!entry?.length) throw Error("时间戳 ESS 证书列表为空");
    let hash = "SHA-1",
      index = 0;
    if (binding.type.endsWith(".47")) {
      hash = "SHA-256";
      if (entry[0].idBlock.tagNumber === 16) {
        hash = entry[0].valueBlock.value[0].valueBlock.toString();
        index++;
      }
    }
    if (
      !equal(
        await digest(hash, der(cert)),
        entry[index].valueBlock.valueHexView,
      )
    )
      throw Error("时间戳 ESS 证书摘要不匹配");
    const issuerSerial = entry[index + 1]?.valueBlock.value;
    if (issuerSerial) {
      if (!cert.serialNumber.isEqual(issuerSerial[1]))
        throw Error("时间戳 ESS 序列号不匹配");
      const names = issuerSerial[0].valueBlock.value;
      if (
        !names.some(
          (n) =>
            n.idBlock.tagClass === 3 &&
            n.idBlock.tagNumber === 4 &&
            equal(
              new Uint8Array(n.valueBlock.value[0].toBER(false)),
              new Uint8Array(cert.issuer.toSchema().toBER(false)),
            ),
        )
      )
        throw Error("时间戳 ESS 颁发者不匹配");
    }
  }
}

export async function verifyTimestamp(
  token,
  signature,
  context,
  now = new Date(),
) {
  try {
    const ci = new ContentInfo({ schema: parseASN1(token) });
    if (!["1.2.840.113549.1.7.2","1.2.156.10197.6.1.4.2.2"].includes(ci.contentType))
      throw Error("时间戳不是 CMS SignedData");
    const sd = new SignedData({ schema: ci.content });
    if (
      sd.signerInfos.length !== 1 ||
      sd.encapContentInfo.eContentType !== "1.2.840.113549.1.9.16.1.4" ||
      !sd.encapContentInfo.eContent
    )
      throw Error("RFC 3161 时间戳结构无效");
    const info = new TSTInfo({
      schema: parseASN1(sd.encapContentInfo.eContent.getValue()),
    });
    if (
      info.version !== 1 ||
      info.genTime > now ||
      info.extensions?.some((e) => e.critical)
    )
      throw Error("时间戳版本、签发时间或关键扩展不受支持");
    if (!(await info.verify({ data: signature }, engine())))
      throw Error("时间戳消息摘要与签名值不匹配");
    const signer = sd.signerInfos[0];
    for (const type of ["1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4"]) {
      const attrs = signer.signedAttrs?.attributes.filter(
        (a) => a.type === type,
      );
      if (attrs?.length !== 1 || attrs[0].values.length !== 1)
        throw Error("时间戳必需签名属性缺失或重复");
      if (
        type.endsWith(".3") &&
        attrs[0].values[0].valueBlock.toString() !==
          sd.encapContentInfo.eContentType
      )
        throw Error("时间戳 content-type 不匹配");
    }
    // PKI.js's TSTInfo branch reads primitive octets; BER CMS may segment eContent.
    sd.encapContentInfo.eContent = new OctetString({
      valueHex: sd.encapContentInfo.eContent.getValue(),
    });
    const checked = await sd.verify(
      { signer: 0, data: signature, extendedMode: true, checkChain: false },
      engine(),
    );
    if (!checked.signatureVerified) throw Error("时间戳签名不正确");
    const cert = checked.signerCertificate,
      eku = ext(cert, "2.5.29.37");
    const purposes = eku?.parsedValue?.keyPurposes || [];
    if (
      !eku?.critical ||
      purposes.length !== 1 ||
      purposes[0] !== "1.3.6.1.5.5.7.3.8"
    )
      throw Error("TSA 证书必须仅具有关键 timeStamping 用途");
    await checkEssBinding(signer, cert);
    if (info.tsa) {
      const names = [
        { type: 4, value: cert.subject },
        ...(ext(cert, "2.5.29.17")?.parsedValue?.altNames || []),
      ];
      if (
        !names.some(
          (n) =>
            n.type === info.tsa.type &&
            (n.type === 4
              ? n.value.isEqual(info.tsa.value)
              : n.value === info.tsa.value),
        )
      )
        throw Error("TSTInfo 的 TSA 名称与签名证书不一致");
    }
    const scoped = {
      ...context,
      certs: [
        ...context.certs,
        ...(sd.certificates || []).filter((c) => c instanceof Certificate),
      ],
      crls: [
        ...context.crls,
        ...(sd.crls || []).filter(
          (c) => c instanceof CertificateRevocationList,
        ),
      ],
    };
    const validation = await validateCertificate(cert, scoped, info.genTime);
    return {
      status:
        validation.trust === "failed" || validation.revocation === "revoked"
          ? "failed"
          : validation.trust === "trusted" &&
              ["good", "not-applicable"].includes(validation.revocation)
            ? "passed"
            : "unknown",
      time: info.genTime.toISOString(),
      policy: info.policy,
      tsa: certificateInfo(cert, info.genTime).subject,
      validation,
      reason:
        validation.reason ||
        (validation.revocation === "unknown"
          ? "TSA 吊销状态未确认"
          : validation.trust !== "trusted"
            ? "TSA 未建立信任链"
            : undefined),
    };
  } catch (e) {
    return { status: "failed", reason: e.message };
  }
}

export async function verifyTrustedDocument(
  doc,
  store,
  materials = [],
  now = new Date(),
) {
  const report = await verifySignatures(doc, now);
  const context = {
    anchors: [...store.entries.values()]
      .filter((e) => e.trusted)
      .map((e) => e.cert),
    certs: [...store.entries.values()].map((e) => e.cert),
    crls: [],
    ocsps: [],
  };
  for (const material of materials)
    context[material.type === "crl" ? "crls" : "ocsps"].push(
      ...parseEvidence(material.bytes, material.type),
    );
  const embedded=uniqueCertificates(report.signatures.flatMap(s=>{
    const c=s.crypto;if(!c)return [];
    return [...(c.certificates||[]).map(certificate),...c.signers.map(s=>certificate(s.certificate.der)),...(c.seal?[certificate(c.seal.certificate.der)]:[]),...timestampCertificates(c.signers.flatMap(s=>s.timestampTokens||[]))];
  }));
  context.certs=uniqueCertificates([...context.certs,...embedded]);
  for (const signature of report.signatures) {
    const c = signature.crypto;
    if (!c) continue;
    const scoped = {
      ...context,
      certs: [...context.certs, ...(c.certificates || []).map(certificate)],
      crls: [
        ...context.crls,
        ...(c.crls || []).map(
          (s) =>
            new CertificateRevocationList({ schema: parseASN1(fromBase64(s)) }),
        ),
      ],
    };
    for (const signer of c.signers) {
      signer.validation = await validateCertificate(
        certificate(signer.certificate.der),
        scoped,
        now,
      );
      signer.timestamps = [];
      for (const token of signer.timestampTokens || [])
        signer.timestamps.push(
          await verifyTimestamp(
            fromBase64(token),
            fromBase64(signer.signatureValue),
            scoped,
            now,
          ),
        );
      delete signer.timestampTokens;
      delete signer.signatureValue;
    }
    if (c.seal)
      c.seal.validation = await validateCertificate(
        certificate(c.seal.certificate.der),
        scoped,
        now,
      );
    const validations = [
      ...c.signers.map((s) => s.validation),
      ...(c.seal ? [c.seal.validation] : []),
    ];
    signature.trust = validations.every((v) => v.trust === "trusted")
      ? "trusted"
      : validations.some((v) => v.trust === "failed")
        ? "failed"
        : "unknown";
    signature.revocation = validations.some((v) => v.revocation === "revoked")
      ? "revoked"
      : validations.every((v) =>
            ["good", "not-applicable"].includes(v.revocation),
          )
        ? "good"
        : "unknown";
    const timestamps = c.signers.flatMap((s) => s.timestamps);
    signature.timestamp = !timestamps.length
      ? "absent"
      : timestamps.some((t) => t.status === "failed")
        ? "failed"
        : timestamps.every((t) => t.status === "passed")
          ? "passed"
          : "unknown";
    signature.verdict =
      signature.status === "failed" ||
      signature.trust === "failed" ||
      signature.revocation === "revoked" ||
      signature.timestamp === "failed"
        ? "failed"
        : signature.status === "passed" &&
            signature.trust === "trusted" &&
            signature.revocation === "good" &&
            ["passed", "absent"].includes(signature.timestamp)
          ? "passed"
          : "incomplete";
    delete c.certificates;
    delete c.crls;
  }
  delete report.trust;
  delete report.revocation;
  delete report.timestamp;
  return report;
}

export async function evidenceInfo(bytes, type, name) {
  const parsed = parseEvidence(bytes, type);
  return {
    id: hex(await digest("SHA-256", bytes)),
    type,
    name,
    der: base64(bytes),
    count: parsed.length,
  };
}
