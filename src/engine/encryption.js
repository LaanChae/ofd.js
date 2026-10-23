import { sm2, sm3, sm4 } from 'sm-crypto-v2';
import { zipSync } from 'fflate';
import { Archive, NS, MAX_FILE, attr, child, children, name, text, resolve, xmlParse } from './archive.js';
import { base64, fromBase64, hex, keyAlgorithm } from './certificates.js';
import { assertEncryptionUsage } from './certificate-policy.js';
import { esc } from './ofd-write-utils.js';
import { XMLSerializer } from '@xmldom/xmldom';
import { OfdDocument } from './document.js';

// GM/T 0099-2020 §7.3, normative Annex A and the XML description in Annex C.
// CBC provides confidentiality, not authentication. Existing signatures are
// preserved byte for byte and must be verified separately after decryption.
const encode = s => new TextEncoder().encode(s);
const unhex = s => Uint8Array.from(s.match(/../g) || [], b => parseInt(b, 16));
const MAX_XML = 16 * 1048576, MAX_TOTAL = 512 * 1048576;
const xml = (tag, attributes, content) => encode(`<?xml version="1.0" encoding="UTF-8"?><ofd:${tag} xmlns:ofd="${NS}" ${attributes}>${content}</ofd:${tag}>`);
const required = (node, key) => { const v = attr(node,key); if (!v) throw Error(`加密描述缺少 ${key}。`); return v; };
const binary = (value, label) => {
  const v = value.replace(/\s/g,'');
  if (!v || v.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) throw Error(`${label} 不是有效 Base64。`);
  return fromBase64(v);
};
function parse(bytes, roots) {
  if (bytes.length > MAX_XML) throw Error('加密描述 XML 超过 16 MB。');
  const root = xmlParse(bytes);
  if (!roots.includes(name(root))) throw Error(`加密描述根节点应为 ${roots.join(' / ')}。`);
  return root;
}
function parameterXml(parameters, seed=false) {
  if(!Array.isArray(parameters)||parameters.length>100)throw Error('扩展参数最多 100 项。');
  return parameters.map(p=>{
    if(typeof p.name!=='string'||!p.name.trim()||p.name.length>256||String(p.value??'').length>4096)throw Error('扩展参数名称或值无效。');
    return seed?`<ofd:Parameter Name="${esc(p.name)}" Value="${esc(p.value??'')}"/>`:
      `<ofd:Parameter Name="${esc(p.name)}"${p.type?` Type="${esc(p.type)}"`:''}>${esc(p.value??'')}</ofd:Parameter>`;
  }).join('');
}
const parameters = (node,seed=false) => children(node,'Parameter').map(p=>({name:attr(p,'Name'),value:seed?attr(p,'Value'):text(p),...(!seed&&attr(p,'Type')?{type:attr(p,'Type')}: {})}));
export function encryptionInfo(bytes) {
  const session=new EncryptedOfd(bytes);
  try {
    return {files:[...session.files.keys()].filter(p=>p!=='Encryptions.xml'),operations:session.operations.map(op=>{
      const provider=child(op,'Provider');
      return {id:attr(op,'ID'),relative:attr(op,'Relative'),scope:text(op,'EncryptScope'),date:text(op,'EncryptDate'),
        provider:{name:attr(provider,'Name'),version:attr(provider,'Version'),company:attr(provider,'Company'),protocolVer:attr(provider,'ProtocolVer'),extendData:text(provider,'ExtendData')},
        parameters:parameters(child(op,'Parameters')),seedPath:resolve('Encryptions.xml',text(op,'DecryptSeedLoc')),mapPath:resolve('Encryptions.xml',text(op,'EntriesMapLoc'))};
    })};
  }finally{session.destroy();}
}
function absolute(value) {
  if (!value.startsWith('/')) throw Error('加密映射必须使用包内绝对路径。');
  return resolve('',value);
}
export function passwordKey(password) {
  if (typeof password !== 'string' || !password.length || password.length > 1024) throw Error('文档密码不能为空，最多 1024 个字符。');
  // GB/T 32918 KDF, klen=128: first 128 bits of SM3(Z || 00000001).
  const raw=encode(password), input=new Uint8Array(raw.length+4);
  input.set(raw); input[input.length-1]=1;
  try { return unhex(sm3(input)).slice(0,16); } finally { raw.fill(0); input.fill(0); }
}
export function sm4Encrypt(bytes,key,iv) {
  return Uint8Array.from(sm4.encrypt(bytes,key,{mode:'cbc',iv,output:'array'}));
}
export function sm4Decrypt(bytes,key,iv) {
  if (!bytes.length || bytes.length%16 || key.length!==16 || iv.length!==16) throw Error('SM4 密文、密钥或 IV 长度无效。');
  // Check padding ourselves: every padding byte and its range are significant.
  const out=Uint8Array.from(sm4.decrypt(bytes,key,{mode:'cbc',iv,padding:'none',output:'array'}));
  const n=out.at(-1);
  if (n<1 || n>16 || out.subarray(out.length-n).some(v=>v!==n)) {out.fill(0);throw Error('密码／私钥不匹配，或加密数据已损坏。');}
  const plain=out.slice(0,-n); out.fill(0); return plain;
}
export function assertEncryptionCertificate(entry, creating=true) {
  if (!entry || keyAlgorithm(entry.cert).name!=='SM2') throw Error('GM/T 0099 证书加密需要 SM2 证书。');
  if (!creating) {
    // An expired certificate must still decrypt its historical documents.
    if (!entry.credential || entry.credential.algorithm.name!=='SM2') throw Error('请先导入此 SM2 证书对应的私钥。');
    return entry;
  }
  assertEncryptionUsage(entry.cert);
  return entry;
}
function pack(files) {
  if(files.size>20000)throw Error('生成的 OFD 超过 20000 个文件限制。');
  const entries=Object.create(null); let total=0;
  for (const [path,read] of files) {
    const bytes=typeof read==='function'?read():read;
    total+=bytes.length;
    if(total>MAX_TOTAL || (/\.xml$/i.test(path)&&bytes.length>MAX_XML)) throw Error('解密内容超过限制（512 MB，单个 XML 16 MB）。');
    entries[path]=bytes;
  }
  const bytes=zipSync(entries);
  if(bytes.length>MAX_FILE) throw Error('生成的 OFD 超过 100 MB，请减少文档大小。');
  return bytes;
}

export function encryptOfd(bytes,{scheme='1.1.1',recipients,paths,encryptMap=true,publicPages=false,scope,parameters:extra=[],seedParameters=[]}={}) {
  if(!['1.1.1','1.1.2'].includes(scheme)) throw Error('不支持的 OFD 加密方案。');
  if(!recipients?.length || recipients.length>100) throw Error('请指定 1–100 位文档接收者。');
  const archive=new Archive(bytes);
  const existing=archive.has('Encryptions.xml')?encryptionInfo(bytes):null;
  if(!existing)parse(archive.read('OFD.xml'),['OFD']);
  if(existing?.operations.length>=100)throw Error('最多支持 100 层加密操作。');
  // An outer operation encrypts all existing ciphertext and its metadata, but
  // Encryptions.xml remains the single cleartext entry for every operation.
  if(existing&&paths!==undefined)throw Error('追加加密层必须覆盖整个现有加密包。');
  if(paths!==undefined&&(!Array.isArray(paths)||paths.some(p=>typeof p!=='string')))throw Error('待加密路径必须是包内绝对路径列表。');
  const selected=paths===undefined?new Set([...archive.paths()].filter(p=>p!=='Encryptions.xml')):
    new Set(paths.map(p=>absolute(p)));
  if(!selected.size||selected.has('Encryptions.xml')||[...selected].some(p=>!archive.has(p)))throw Error('请选择存在的包内文件，加密入口不能被加密。');
  const extraXml=parameterXml(extra),seedExtraXml=parameterXml(seedParameters,true);
  const key=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(16));
  const id='enc_'+crypto.randomUUID().replaceAll('-',''), prefix=`Encrypted_${id}`;
  const files=new Map(), maps=[], users=[];
  try {
    for(const recipient of recipients) {
      const userName=String(recipient.userName||'').trim(), userType=recipient.userType||'User';
      if(!userName || userName.length>256 || !['Owner','User'].includes(userType)) throw Error('接收者名称或角色无效。');
      let wrapped,certificate='';
      if(scheme==='1.1.1') {
        const kek=passwordKey(recipient.password);
        try{wrapped=sm4Encrypt(key,kek,iv);}finally{kek.fill(0);}
      } else {
        const entry=assertEncryptionCertificate(recipient.identity);
        wrapped=unhex(sm2.doEncrypt(key,hex(entry.cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView),1,{asn1:true}));
        certificate=`<ofd:UserCert>${base64(entry.der)}</ofd:UserCert>`;
      }
      users.push(`<ofd:UserInfo UserName="${esc(userName)}" UserType="${userType}">${certificate}<ofd:EncryptedWK>${base64(wrapped)}</ofd:EncryptedWK><ofd:IVValue>${base64(iv)}</ofd:IVValue></ofd:UserInfo>`);
    }
    let index=0;
    for(const path of archive.paths()) {
      if(path==='Encryptions.xml')continue;
      if(!selected.has(path)){files.set(path,()=>archive.read(path));continue;}
      const encrypted=`${prefix}/${index++}.dat`;
      files.set(encrypted,sm4Encrypt(archive.read(path),key,iv));
      maps.push(`<ofd:EncryptEntry Path="/${esc(path)}" EPath="/${encrypted}"/>`);
      // Annex C.1 permits non-confidential replacements. Preserve only the
      // physical page area, never content, actions, template or resource links.
      if(paths&&publicPages&&/\.xml$/i.test(path)) {
        let original;
        try{original=xmlParse(archive.read(path));}catch{continue;}
        if(name(original)==='Page') {
          const area=child(original,'Area');
          const boxes=['PhysicalBox','ApplicationBox','ContentBox','BleedBox'].filter(tag=>child(area,tag)).map(tag=>`<ofd:${tag}>${esc(text(area,tag))}</ofd:${tag}>`).join('');
          files.set(path,xml('Page','',boxes?`<ofd:Area>${boxes}</ofd:Area>`:''));
        }
      }
    }
    // Figure C.3 names EncryptEntries; table C.3 spells EncryptedEntries.
    // Write the figure spelling (also used by OFDRW), accept both on input.
    const mapPath=`${prefix}/entriesmap.dat`,seedPath=`${prefix}/decryptseed.dat`;
    const mapping=xml('EncryptEntries',`ID="${id}"`,maps.join(''));
    files.set(mapPath,encryptMap?sm4Encrypt(mapping,key,iv):mapping);
    files.set(seedPath,xml('DecyptSeed',`ID="${id}" EncryptCaseId="${scheme}"`,users.join('')+`<ofd:ExtendParams>${seedExtraXml}</ofd:ExtendParams>`));
    // Serialize the old elements themselves, preserving their namespace and
    // extension fields. Existing seed/map bytes are restored unchanged.
    const old=existing?children(parse(archive.read('Encryptions.xml'),['Encryptions','EncryptList']),'EncryptInfo').map(n=>new XMLSerializer().serializeToString(n)).join(''):'';
    const relative=existing?` Relative="${esc(existing.operations[0].id)}"`:'';
    files.set('Encryptions.xml',xml('Encryptions','',old+`<ofd:EncryptInfo ID="${id}"${relative}><ofd:Provider Name="OFD JS" Version="1.0"/><ofd:EncryptScope>${esc(scope??(paths===undefined?'All':'Selected package files'))}</ofd:EncryptScope>${extraXml?`<ofd:Parameters>${extraXml}</ofd:Parameters>`:''}<ofd:EncryptDate>${new Date().toISOString()}</ofd:EncryptDate><ofd:DecryptSeedLoc>/${seedPath}</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/${mapPath}</ofd:EntriesMapLoc></ofd:EncryptInfo>`));
    return pack(files);
  }finally{key.fill(0);iv.fill(0);}
}

// Transactional unlock. Original container bytes never change; only a complete
// operation is committed. Keys live in this worker session until finish/cancel.
export class EncryptedOfd {
  constructor(bytes) {
    this.archive=new Archive(bytes); this.files=new Map([...this.archive.paths()].map(p=>[p,()=>this.archive.read(p)]));
    this.keys=new Map();this.completed=new Set();this.removed=new Set();this.total=0;
    if(!this.files.has('Encryptions.xml')) {this.operations=[];return;}
    const root=parse(this.read('Encryptions.xml'),['Encryptions','EncryptList']);
    this.operations=children(root,'EncryptInfo');
    if(!this.operations.length||this.operations.length>100) throw Error('加密操作记录为空或超过 100 项。');
    const ids=new Map();
    for(const op of this.operations) {const id=required(op,'ID');if(ids.has(id))throw Error('重复的加密操作 ID。');ids.set(id,op);}
    for(const op of this.operations) {
      const seen=new Set([attr(op,'ID')]);let parent=attr(op,'Relative');
      while(parent) {if(seen.has(parent)||!ids.has(parent))throw Error('加密操作 Relative 循环或指向不存在的 ID。');seen.add(parent);parent=attr(ids.get(parent),'Relative');}
    }
    // Newer operations first; explicit Relative determines dependency order.
    const pending=[...this.operations].reverse(),ordered=[];
    while(pending.length) {
      const index=pending.findIndex(op=>!pending.some(other=>attr(other,'Relative')===attr(op,'ID')));
      ordered.push(pending.splice(index,1)[0]);
    }
    this.operations=ordered;
  }
  read(path) {const v=this.files.get(path);if(!v)throw Error(`缺少加密包内文件：${path}`);return typeof v==='function'?v():v;}
  seed(path,id) {
    const root=parse(this.read(path),['DecyptSeed']);
    if(required(root,'ID')!==id)throw Error('密钥描述文件的 ID 与加密操作不一致。');
    const scheme=required(root,'EncryptCaseId');
    if(!['1.1.1','1.1.2'].includes(scheme))throw Error(`不支持的 OFD 加密方案：${scheme}`);
    const users=children(root,'UserInfo');
    if(!users.length||users.length>100)throw Error('加密接收者为空或超过 100 位。');
    return {root,scheme,users,parameters:parameters(child(root,'ExtendParams'),true)};
  }
  unlockKey(path,id,credential) {
    const cacheId=`${id}\0${path}`;
    if(this.keys.has(cacheId))return this.keys.get(cacheId);
    const {scheme,users,parameters}=this.seed(path,id);
    let key;
    if(credential && (!credential.seedPath||credential.seedPath===path)) {
      for(const user of users) {
        if(credential.userName && attr(user,'UserName')!==credential.userName)continue;
        const iv=child(user,'IVValue')?binary(text(user,'IVValue'),'IVValue'):new Uint8Array(16);
        if(iv.length!==16)throw Error('IVValue 必须是 16 字节。');
        const wrapped=binary(text(user,'EncryptedWK'),'EncryptedWK');
        try {
          if(scheme==='1.1.1'&&typeof credential.password==='string') {
            const kek=passwordKey(credential.password);
            try{key=sm4Decrypt(wrapped,kek,iv);}finally{kek.fill(0);}
          }else if(scheme==='1.1.2'&&credential.identity) {
            const identity=assertEncryptionCertificate(credential.identity,false);
            if(base64(binary(text(user,'UserCert'),'UserCert'))!==base64(identity.der))continue;
            key=Uint8Array.from(sm2.doDecrypt(hex(wrapped),identity.credential.key,1,{asn1:true,output:'array'}));
          }
          if(key?.length===16){const value={key,iv};this.keys.set(cacheId,value);return value;}
        }catch{/* Wrong credential is retryable; parsing errors above are not. */}
        key?.fill(0);
      }
    }
    const op=this.operations.find(n=>attr(n,'ID')===id);
    return {challenge:{seedPath:path,operationId:id,scheme,scope:text(op,'EncryptScope'),provider:attr(child(op,'Provider'),'Name'),parameters,users:users.map(u=>({name:required(u,'UserName'),type:attr(u,'UserType','User')})),retry:!!credential}};
  }
  advance(credential) {
    for(const op of this.operations) {
      const id=attr(op,'ID');if(this.completed.has(id))continue;
      const seedPath=resolve('Encryptions.xml',text(op,'DecryptSeedLoc')),mapPath=resolve('Encryptions.xml',text(op,'EntriesMapLoc'));
      const common=this.unlockKey(seedPath,id,credential);if(common.challenge)return common;
      let root;
      const mapBytes=this.read(mapPath);
      // §7.3.4 explicitly permits a cleartext mapping table.
      // Ciphertext may also start with '<'. Only an actual parsed mapping XML
      // is cleartext. XML permits UTF-16 (with BOM or byte-order signature).
      try {root=parse(mapBytes,['EncryptEntries','EncryptedEntries']);}catch{/* encrypted map */}
      try {if(!root){const plain=sm4Decrypt(mapBytes,common.key,common.iv);try{root=parse(plain,['EncryptEntries','EncryptedEntries']);}finally{plain.fill(0);}}}
      catch(error){this.keys.delete(`${id}\0${seedPath}`);common.key.fill(0);throw Error(`无法解密明密文映射表：${error.message}`);}
      if(required(root,'ID')!==id)throw Error('映射表 ID 与加密操作不一致。');
      const entries=children(root,'EncryptEntry');
      if(!entries.length||entries.length>20000)throw Error('明密文映射表为空或条目过多。');
      const targets=new Set(), jobs=[];
      for(const entry of entries) {
        const path=absolute(required(entry,'Path')),cipher=absolute(attr(entry,'EPath',attr(entry,'Path')));
        if(targets.has(path)||path==='Encryptions.xml')throw Error('加密映射含重复目标或覆盖解密入口。');targets.add(path);
        const own=attr(entry,'DecryptSeedLoc'),keyPath=own?resolve(mapPath,own):seedPath;
        const secret=this.unlockKey(keyPath,id,credential);if(secret.challenge)return secret;
        jobs.push({path,cipher,secret,keyPath});
      }
      const staged=new Map();let size=0;
      try {for(const job of jobs) {
          const plain=sm4Decrypt(this.read(job.cipher),job.secret.key,job.secret.iv);
          staged.set(job.path,plain);size+=plain.length;
          if(this.total+size>MAX_TOTAL||(/\.xml$/i.test(job.path)&&plain.length>MAX_XML))throw Error('解密内容超过大小限制。');
        }
      }catch(error){for(const plain of staged.values())plain.fill(0);throw error;}
      for(const job of jobs){this.files.delete(job.cipher);this.removed.add(job.keyPath);}
      for(const [path,plain] of staged)this.files.set(path,plain);
      this.total+=size;this.removed.add(mapPath);this.removed.add(seedPath);this.completed.add(id);
    }
    for(const path of this.removed)this.files.delete(path);
    this.files.delete('Encryptions.xml');
    if(!this.files.has('OFD.xml'))throw Error('解密后缺少 OFD.xml。');
    const bytes=pack(this.files);this.destroy();return {bytes};
  }
  available() {
    // A public placeholder can be read without pretending that its ciphertext
    // has been decrypted. The UI preserves the original encrypted download and
    // makes this view read-only. No new blanks are fabricated during reading.
    const files=new Map(this.files);files.delete('Encryptions.xml');
    const bytes=pack(files);
    try {
      const doc=new OfdDocument(bytes);
      for(let i=0;i<doc.pages.length;i++)doc.page(i);
      for(const resources of Object.values(doc.resources))for(const resource of resources.values())
        if(resource.path&&!doc.archive.has(resource.path))throw Error(`缺少资源：${resource.path}`);
    }catch(error){throw Error(`当前公开内容不足以显示文档，请继续解密。${error.message}`);}
    const remaining=this.operations.filter(op=>!this.completed.has(attr(op,'ID'))).map(op=>({id:attr(op,'ID'),scope:text(op,'EncryptScope')}));
    this.destroy();return {bytes,partial:true,remaining};
  }
  destroy(){for(const {key,iv} of this.keys.values()){key.fill(0);iv.fill(0);}this.keys.clear();for(const value of this.files.values())if(value instanceof Uint8Array)value.fill(0);this.files.clear();this.archive=null;}
}
