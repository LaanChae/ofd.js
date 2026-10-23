import {zipSync} from 'fflate';
import {Integer,OctetString} from 'asn1js';
import {Certificate,ContentInfo,SignedData,TimeStampReq,TimeStampResp,TSTInfo,MessageImprint,AlgorithmIdentifier,Attribute,SignedAndUnsignedAttributes} from 'pkijs';
import {Archive,NS,MAX_FILE,attr,child,children,name,text,resolve} from './archive.js';
import {createCms} from './sign-ofd.js';
import {digest,parseASN1,verifyCms} from './signatures.js';
import {assertSigningCertificate,fromBase64,keyAlgorithm} from './certificates.js';
import {parseEvidence,validateCertificate,verifyTimestamp} from './trust.js';
import {inspectPackageReferences} from './package-resources.js';
import {esc} from './ofd-write-utils.js';

const MANIFEST='OFDEntries.xml',SM3='1.2.156.10197.1.401',SM2='1.2.156.10197.1.501';
const der=value=>new Uint8Array(value.toSchema().toBER(false));
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
export function integrityContext(store,materials=[]) {
  const entries=[...store.entries.values()],context={anchors:entries.filter(e=>e.trusted).map(e=>e.cert),certs:entries.map(e=>e.cert),crls:[],ocsps:[]};
  for(const item of materials)context[item.type==='crl'?'crls':'ocsps'].push(...parseEvidence(item.bytes,item.type));
  return context;
}
const emptyContext=()=>({anchors:[],certs:[],crls:[],ocsps:[]});

export function integrityInventory(bytes) {
  const archive=new Archive(bytes),paths=[...archive.paths()].sort();
  let references;
  try{references=inspectPackageReferences(archive);}catch(e){references={status:'failed',reason:e.message,unreferenced:[],missing:[]};}
  return {present:archive.has(MANIFEST),files:paths,references};
}

function readManifest(archive) {
  const root=archive.xml(MANIFEST);
  // Figure D.1 says OFDEntries; table D.1 says DocEntries. Write the figure.
  if(!['OFDEntries','DocEntries'].includes(name(root)))throw Error('完整性保护描述根节点无效。');
  if(!attr(root,'ID'))throw Error('完整性保护描述缺少 ID。');
  const list=children(child(root,'FileList'),'File'),ids=new Set(),paths=new Set();
  if(!list.length||list.length>20000)throw Error('完整性文件列表为空或超过限制。');
  for(const f of list) {
    const id=attr(f,'ID'),loc=attr(f,'FileLoc');
    if(!id||ids.has(id))throw Error('完整性文件 ID 缺失或重复。');
    ids.add(id);
    const path=resolve(MANIFEST,loc);
    if(paths.has(path))throw Error('完整性文件列表含重复路径。');
    paths.add(path);
  }
  const loc=text(root,'SignedValueLoc'),signature=loc?resolve(MANIFEST,loc):null;
  if(signature===MANIFEST)throw Error('完整性签名值不能指向清单自身。');
  return {root,paths,signature};
}

export async function prepareIntegrity(bytes,identity) {
  assertSigningCertificate(identity.cert);
  if(keyAlgorithm(identity.cert).name!=='SM2'||identity.credential?.algorithm.name!=='SM2')throw Error('完整性保护创建需要 SM2 签名证书和私钥。');
  const archive=new Archive(bytes);
  // Replacing an existing protection could invalidate a digital signature that
  // covers it. Never silently strip or rewrite the old signature/manifest.
  if(archive.has(MANIFEST))throw Error('此文件已有完整性保护，请先验证；不能直接覆盖旧清单。');
  if(!archive.has('OFD.xml')&&!archive.has('Encryptions.xml'))throw Error('不是有效的 OFD 包。');
  const files=archive.materialize(),id='integrity_'+crypto.randomUUID().replaceAll('-',''),signaturePath=`${id}/SignedValue.dat`;
  if(files.size>19998)throw Error('添加完整性保护后超过包内文件数量限制。');
  const inventory=integrityInventory(bytes);
  if(inventory.references.status==='failed')throw Error(`包内引用关系检查失败：${inventory.references.reason}`);
  if(inventory.references.status==='checked'&&inventory.references.missing.length)throw Error('文档引用的包内文件缺失，不能创建完整性保护。');
  if(inventory.references.status==='checked'&&inventory.references.unreferenced.length)throw Error(`存在未被文档引用的文件，请先处理后再保护：${inventory.references.unreferenced.slice(0,5).join('、')}`);
  const list=[...files.keys()].sort().map((path,i)=>`<ofd:File ID="f${i+1}" FileLoc="/${esc(path)}"/>`).join('');
  const manifest=new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><ofd:OFDEntries xmlns:ofd="${NS}" ID="${id}" CreatorName="OFD JS" Version="1.0" CreationDate="${new Date().toISOString().slice(0,10)}"><ofd:FileList>${list}</ofd:FileList><ofd:SignedValueLoc>/${signaturePath}</ofd:SignedValueLoc></ofd:OFDEntries>`);
  if(manifest.length>16*1048576)throw Error('完整性清单超过 16 MB。');
  // §7.4.5(c,d): the protected message is the SM3 digest of the original XML
  // bytes. Encapsulate that digest in GB/T 35275 SignedData, not a private hash
  // attribute on File. The filename inventory does not hash each file's content.
  const cms=await createCms(await digest('SM3',manifest),identity,{encapsulate:true});
  const content=new ContentInfo({schema:parseASN1(cms)}),signed=new SignedData({schema:content.content});
  const signature=new Uint8Array(signed.signerInfos[0].signature.getValue());
  const random=crypto.getRandomValues(new Uint8Array(16));random[0]&=0x7f;random[0]|=1;
  const request=new TimeStampReq({version:1,certReq:true,nonce:new Integer({valueHex:random}),messageImprint:new MessageImprint({hashAlgorithm:new AlgorithmIdentifier({algorithmId:SM3}),hashedMessage:new OctetString({valueHex:await digest('SM3',signature)})})});
  return {files,manifest,signaturePath,cms,signature,request:der(request),inventory};
}

export async function finishIntegrity(pending,responseBytes,context=emptyContext()) {
  const response=new TimeStampResp({schema:parseASN1(responseBytes)});
  if(![0,1].includes(response.status.status)||!response.timeStampToken)throw Error(`时间戳服务未成功签发（状态 ${response.status.status}）。`);
  const token=der(response.timeStampToken),sd=new SignedData({schema:response.timeStampToken.content});
  if(!sd.encapContentInfo.eContent)throw Error('时间戳响应没有 TSTInfo。');
  const info=new TSTInfo({schema:parseASN1(sd.encapContentInfo.eContent.getValue())}),request=new TimeStampReq({schema:parseASN1(pending.request)});
  if(!info.nonce?.isEqual(request.nonce))throw Error('时间戳 nonce 与本次请求不一致。');
  if(info.messageImprint.hashAlgorithm.algorithmId!==request.messageImprint.hashAlgorithm.algorithmId||!equal(new Uint8Array(info.messageImprint.hashedMessage.getValue()),new Uint8Array(request.messageImprint.hashedMessage.getValue())))throw Error('时间戳消息摘要与请求不一致。');
  const timestamp=await verifyTimestamp(token,pending.signature,context);
  if(timestamp.status==='failed')throw Error(`时间戳验证失败：${timestamp.reason}`);
  const content=new ContentInfo({schema:parseASN1(pending.cms)}),signed=new SignedData({schema:content.content});
  signed.signerInfos[0].unsignedAttrs=new SignedAndUnsignedAttributes({type:1,attributes:[new Attribute({type:'1.2.840.113549.1.9.16.2.14',values:[parseASN1(token)]})]});
  content.content=signed.toSchema(true);
  const entries=Object.fromEntries(pending.files);entries[MANIFEST]=pending.manifest;entries[pending.signaturePath]=der(content);
  let total=0;for(const bytes of Object.values(entries)){total+=bytes.length;if(total>512*1048576)throw Error('保护后的包内文件超过大小限制。');}
  const bytes=zipSync(entries);if(bytes.length>MAX_FILE)throw Error('保护后的 OFD 超过 100 MB。');
  const report=await verifyIntegrity(bytes,context);
  if(report.status==='failed')throw Error(`不能生成验证失败的完整性保护：${report.reason}`);
  return {bytes,timestamp,report};
}

export async function verifyIntegrity(bytes,context=emptyContext(),now=new Date()) {
  const archive=new Archive(bytes);
  if(!archive.has(MANIFEST))return {status:'absent',reason:'未包含 OFDEntries.xml 完整性保护清单。'};
  const result={status:'failed',inventory:'failed',signature:'not-checked',timestamps:[],signers:[],extra:[],missing:[]};
  try {
    const {root,paths,signature}=readManifest(archive),expected=new Set([...paths,MANIFEST,...(signature?[signature]:[])]);
    result.creator=attr(root,'CreatorName');result.date=attr(root,'CreationDate');result.count=paths.size;
    result.extra=[...archive.paths()].filter(p=>!expected.has(p));result.missing=[...expected].filter(p=>!archive.has(p));
    result.inventory=result.extra.length||result.missing.length?'failed':'passed';
    if(!signature)throw Error('清单缺少 §7.4 必需的签名值。');
    const value=archive.read(signature),parsed=new ContentInfo({schema:parseASN1(value)});
    if(parsed.contentType!=='1.2.156.10197.6.1.4.2.2')throw Error('完整性签名值不是 GB/T 35275 SignedData。');
    const checked=await verifyCms(value,await digest('SM3',archive.read(MANIFEST)),SM2,now);
    result.signature=checked.verified?'passed':'failed';
    const certs=checked.certificates.map(v=>new Certificate({schema:parseASN1(fromBase64(v))})),scoped={...context,certs:[...context.certs,...certs]};
    for(const signer of checked.signers) {
      const cert=new Certificate({schema:parseASN1(fromBase64(signer.certificate.der))});
      const validation=await validateCertificate(cert,scoped,now);
      result.signers.push({certificate:signer.certificate,validation});
      if(!signer.timestampTokens.length)throw Error('完整性保护签名缺少 §7.4 要求的时间戳。');
      for(const token of signer.timestampTokens)result.timestamps.push(await verifyTimestamp(fromBase64(token),fromBase64(signer.signatureValue),scoped,now));
    }
    try{result.references=inspectPackageReferences(archive);}catch(e){result.references={status:'failed',reason:e.message};}
    const broken=result.inventory==='failed'||result.signature==='failed'||result.timestamps.some(t=>t.status==='failed')||result.signers.some(s=>s.validation.trust==='failed'||s.validation.revocation==='revoked')||result.references.status==='failed'||result.references.missing?.length||result.references.unreferenced?.length;
    const trusted=result.timestamps.every(t=>t.status==='passed')&&result.signers.every(s=>s.validation.trust==='trusted'&&['good','not-applicable'].includes(s.validation.revocation));
    result.status=broken?'failed':trusted?'passed':'incomplete';
    result.reason=broken?'文件清单、引用关系、签名或时间戳验证失败。':trusted?'文件清单、签名和可信时间戳验证通过。':'文件清单和密码学验证通过，证书信任或吊销状态尚未确认。';
  }catch(error){result.status='failed';result.reason=error.message;}
  return result;
}
