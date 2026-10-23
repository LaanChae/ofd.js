import { validatePlacements } from "../../public/shared/stamp-layout.js";
import { XMLSerializer } from "@xmldom/xmldom";
import { zipSync, strToU8 } from "fflate";
import * as asn from "asn1js";
import {
  SignedData,
  SignerInfo,
  IssuerAndSerialNumber,
  EncapsulatedContentInfo,
  ContentInfo,
  AlgorithmIdentifier,
  Attribute,
  SignedAndUnsignedAttributes,
} from "pkijs";
import { sm2 } from "sm-crypto-v2";
import { OfdDocument } from "./document.js";
import {
  NS,
  MAX_FILE,
  child,
  children,
  text,
  attr,
  resolve,
  xmlParse,
} from "./archive.js";
import { digest, verifySignatures } from "./signatures.js";
import {
  base64,
  cryptoEngine,
  assertSigningCertificate,
} from "./certificates.js";
import { createSes, sealSigningTime } from "./seal.js";
import { assertUsableSeal } from "./seal-store.js";
import { esc, matrixText } from "./ofd-write-utils.js";

export async function createCms(data, identity, {encapsulate=false}={}) {
  const {
    cert,
    credential: { key, algorithm },
  } = identity;
  const dataType=algorithm.name==='SM2'?'1.2.156.10197.6.1.4.2.1':'1.2.840.113549.1.7.1';
  const signer = new SignerInfo({
    version: 1,
    sid: new IssuerAndSerialNumber({
      issuer: cert.issuer,
      serialNumber: cert.serialNumber,
    }),
    signedAttrs: new SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new Attribute({
          type: "1.2.840.113549.1.9.3",
          values: [new asn.ObjectIdentifier({ value: dataType })],
        }),
        new Attribute({
          type: "1.2.840.113549.1.9.4",
          values: [
            new asn.OctetString({
              valueHex: await digest(algorithm.hash, data),
            }),
          ],
        }),
      ],
    }),
  });
  const sd = new SignedData({
    version: 1,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: dataType,
      ...(encapsulate?{eContent:new asn.OctetString({valueHex:data})}:{}),
    }),
    certificates: [cert],
    signerInfos: [signer],
  });
  if (algorithm.name === "SM2") {
    signer.digestAlgorithm = new AlgorithmIdentifier({
      algorithmId: "1.2.156.10197.1.401",
    });
    sd.digestAlgorithms = [signer.digestAlgorithm];
    signer.signatureAlgorithm = new AlgorithmIdentifier({
      algorithmId: algorithm.method,
    });
    const signedAttributes = new Uint8Array(
      signer.signedAttrs.toSchema().toBER(false),
    );
    signedAttributes[0] = 0x31; // CMS signs the DER SET, not its implicit [0] tag.
    const sig = sm2.doSignature(signedAttributes, key, {
      der: true,
      hash: true,
      userId: "1234567812345678",
    });
    signer.signature = new asn.OctetString({
      valueHex: Uint8Array.from(sig.match(/../g), (s) => parseInt(s, 16))
        .buffer,
    });
  } else {
    await sd.sign(key, 0, algorithm.hash, data, cryptoEngine());
  }
  return new Uint8Array(
    new ContentInfo({
      contentType: algorithm.name==='SM2'?'1.2.156.10197.6.1.4.2.2':'1.2.840.113549.1.7.2',
      content: sd.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
}

export async function signOfd(bytes, identity, { stamp, selection } = {}) {
  assertSigningCertificate(identity.cert);
  const doc = new OfdDocument(bytes, selection),
    files = doc.archive.materialize();
  if (doc.selection.versionId !== (doc.documents[doc.selection.documentIndex].versions.find((v) => v.current)?.id || ""))
    throw Error("历史版本不能直接追加签章，请先切换到当前版本。");
  let seal;
  if (stamp) {
    validatePlacements(doc.pages, stamp.placements);
    seal = await assertUsableSeal(stamp.seal, identity);
  }

  const location = text(doc.body, "Signatures");
  let directory = "Signs";
  for (
    let n = 1;
    [...files.keys()].some(
      (p) => p === directory || p.startsWith(directory + "/"),
    );
    n++
  )
    directory = `Signs_${n}`;
  const indexFile = location
    ? resolve("OFD.xml", location)
    : `${directory}/Signatures.xml`;
  const index = location
    ? xmlParse(files.get(indexFile))
    : xmlParse(`<ofd:Signatures xmlns:ofd="${NS}"/>`);
  const existing = children(index, "Signature");
  if (existing.length >= 100) throw Error("最多支持 100 个签名。");
  const ids = new Set(existing.map((e) => attr(e, "ID")));
  // A shared OFD.xml can be protected by a signature in another DocBody.
  // Never invalidate it when adding this document's signature entry.
  for (const body of children(doc.archive.xml("OFD.xml"), "DocBody")) {
    const loc = text(body, "Signatures");
    if (!loc) continue;
    const listFile = resolve("OFD.xml", loc);
    for (const item of children(doc.archive.xml(listFile), "Signature")) {
      const path = resolve(listFile, attr(item, "BaseLoc"));
      const info = child(doc.archive.xml(path), "SignedInfo"), refs = child(info, "References");
      if (listFile === indexFile)
        for (const annot of children(info, "StampAnnot")) ids.add(attr(annot, "ID"));
      if (!refs) throw Error("已有签名缺少引用列表，无法安全追加签名。");
      for (const ref of children(refs, "Reference")) {
        const protectedPath = resolve(path, attr(ref, "FileRef"));
        if (protectedPath === indexFile || (!location && protectedPath === "OFD.xml") || protectedPath === doc.version?.file)
          throw Error("已有签名保护了需要更新的入口或签名列表，不允许继续追加签名。");
      }
    }
  }
  if (!location) {
    const owner = doc.body.ownerDocument;
    const node = owner.createElementNS(
      doc.body.namespaceURI || NS,
      doc.body.prefix ? `${doc.body.prefix}:Signatures` : "Signatures",
    );
    node.textContent = `/${indexFile}`;
    doc.body.appendChild(node);
    files.set("OFD.xml", strToU8(new XMLSerializer().serializeToString(owner)));
  }
  const max = text(index, "MaxSignId");
  if (max) ids.add(max);
  let idNumber = Math.max(
    0,
    ...[...ids].map((id) => (/^s\d+$/.test(id) ? Number(id.slice(1)) : 0)),
  );
  if (!Number.isSafeInteger(idNumber) || idNumber > 1e9)
    throw Error("签名 ID 超出支持范围。");
  // Signature and StampAnnot share the separate security ID space (§18.1).
  const nextId = () => {
    if (idNumber >= 1e9) throw Error("签名 ID 超出支持范围。");
    return `s${++idNumber}`;
  };
  const id = nextId();
  const stamps = seal ? stamp.placements.map(({ page, boundary, clip }) =>
    `<ofd:StampAnnot ID="${nextId()}" PageRef="${esc(doc.pages[page - 1].id)}" Boundary="${matrixText(boundary)}"${clip ? ` Clip="${matrixText(clip)}"` : ""}/>`,
  ).join("") : "";
  let signatureFile = `${indexFile.slice(0, indexFile.lastIndexOf("/") + 1)}Sign_${id}/Signature.xml`;
  if ([...files.keys()].some((p) => p.startsWith(signatureFile.slice(0, -13))))
    throw Error("新签名目录与已有内容冲突。");
  const signedValueFile = resolve(signatureFile, "SignedValue.dat");
  const owner = index.ownerDocument,
    prefix = index.prefix ? index.prefix + ":" : "";
  let maxNode = child(index, "MaxSignId");
  if (!maxNode) {
    maxNode = owner.createElementNS(
      index.namespaceURI || NS,
      prefix + "MaxSignId",
    );
    index.insertBefore(maxNode, index.firstChild);
  }
  maxNode.textContent = `s${idNumber}`;
  const registration = owner.createElementNS(
    index.namespaceURI || NS,
    prefix + "Signature",
  );
  registration.setAttribute("ID", id);
  registration.setAttribute("Type", seal ? "Seal" : "Sign");
  registration.setAttribute("BaseLoc", `/${signatureFile}`);
  index.appendChild(registration);
  files.set(indexFile, strToU8(new XMLSerializer().serializeToString(index)));
  if (seal)
    files.set(resolve(signatureFile, "Seal.esl"), new Uint8Array(stamp.seal));
  let versionFiles;
  if (doc.version) {
    const root = xmlParse(files.get(doc.version.file)), list = child(root, "FileList"),
      ids = new Set([attr(root, "ID"), ...children(list, "File").map(n => attr(n, "ID"))]);
    versionFiles = new Set([...doc.version.files, "OFD.xml", doc.version.file, indexFile, signatureFile, signedValueFile]);
    if (seal) versionFiles.add(resolve(signatureFile, "Seal.esl"));
    for (const path of versionFiles) {
      if (doc.version.files.includes(path)) continue;
      let n = 1; while (ids.has(`file${n}`)) n++;
      const node = root.ownerDocument.createElementNS(root.namespaceURI || NS, root.prefix ? `${root.prefix}:File` : "File");
      node.setAttribute("ID", `file${n}`); ids.add(`file${n}`); node.textContent = `/${path}`; list.appendChild(node);
    }
    files.set(doc.version.file, strToU8(new XMLSerializer().serializeToString(root)));
  }
  const hash = identity.credential.algorithm.hash;
  const refs = [];
  for (const [path, content] of files) {
    if (path === indexFile || (versionFiles && !versionFiles.has(path))) continue;
    refs.push(
      `<ofd:Reference FileRef="/${esc(path)}"><ofd:CheckValue>${base64(await digest(hash, content))}</ofd:CheckValue></ofd:Reference>`,
    );
  }
  const signingTime = seal ? sealSigningTime(seal) : new Date();
  assertSigningCertificate(identity.cert, signingTime);
  const signature = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><ofd:Signature xmlns:ofd="${NS}"><ofd:SignedInfo><ofd:Provider ProviderName="Paperdesk OFD" Version="1.0"/><ofd:SignatureMethod>${identity.credential.algorithm.method}</ofd:SignatureMethod><ofd:SignatureDateTime>${signingTime.toISOString()}</ofd:SignatureDateTime><ofd:References CheckMethod="${hash.replaceAll("-", "")}">${refs.join("")}</ofd:References>${stamps}${seal ? "<ofd:Seal><ofd:BaseLoc>Seal.esl</ofd:BaseLoc></ofd:Seal>" : ""}</ofd:SignedInfo><ofd:SignedValue>SignedValue.dat</ofd:SignedValue></ofd:Signature>`,
  );
  files.set(signatureFile, signature);
  files.set(
    signedValueFile,
    seal
      ? await createSes(signature, identity, seal, signingTime)
      : await createCms(signature, identity),
  );
  const output = zipSync(Object.fromEntries(files));
  if (output.length > MAX_FILE) throw Error("签名后的文件超过 100 MB。");
  const verified = await verifySignatures(new OfdDocument(output, doc.selection));
  const report = verified.signatures.find((s) => s.id === id);
  if (report?.status !== "passed")
    throw Error(
      `签名生成后的自检未通过：${report?.error || report?.status || "未找到签名"}`,
    );
  return {
    bytes: output,
    id,
    references: refs.length,
    algorithm: identity.credential.algorithm.label,
  };
}
