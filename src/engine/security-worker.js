import { CertificateStore, fromBase64 } from "./certificates.js";
import { signOfd } from "./sign-ofd.js";
import { createCertificate } from "./create-certificate.js";
import { verifyTrustedDocument, evidenceInfo } from "./trust.js";
import { OfdDocument } from "./document.js";
import { SealStore } from "./seal-store.js";
import { EncryptedOfd, encryptOfd, encryptionInfo } from './encryption.js';
import {pageEncryptionPlan} from './package-resources.js';
import {prepareIntegrity,finishIntegrity,verifyIntegrity,integrityInventory,integrityContext} from './integrity.js';
import {readCertificateBundle,certificateKey} from './certificate-evidence.js';
const unlockSessions=new Map();
const integritySessions=new Map();
const seals = new SealStore();
const materials = new Map();
const store = new CertificateStore();
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};
async function handle({ id, method, args = {} }) {
  try {
    let result;
    switch (method) {
      case 'encryptionPages':result=pageEncryptionPlan(args.bytes,args.options);break;
      case 'integrityInspect':result=integrityInventory(args.bytes);break;
      case 'integrityVerify':result=await verifyIntegrity(args.bytes,integrityContext(store,[...materials.values()]));break;
      case 'integrityPrepare': {
        integritySessions.clear();
        const pending=await prepareIntegrity(args.bytes,store.signingIdentity(args.certificateId));
        integritySessions.set(args.sessionId,pending);result={request:pending.request,inventory:pending.inventory};break;
      }
      case 'integrityFinish': {
        const pending=integritySessions.get(args.sessionId);
        if(!pending)throw Error('完整性保护会话已取消或文档已切换。');
        result=await finishIntegrity(pending,args.response,integrityContext(store,[...materials.values()]));
        integritySessions.delete(args.sessionId);break;
      }
      case 'integrityCancel':integritySessions.delete(args.sessionId);result=null;break;
      case 'encryptionInfo': result=encryptionInfo(args.bytes);break;
      case 'encryptionOpen': {
        for(const session of unlockSessions.values())session.destroy();
        unlockSessions.clear();
        const session=new EncryptedOfd(args.bytes);
        if(!session.operations.length){session.destroy();result={encrypted:false};break;}
        unlockSessions.set(args.sessionId,session);
        result={encrypted:true,...session.advance()};
        break;
      }
      case 'encryptionUnlock': {
        const session=unlockSessions.get(args.sessionId);
        if(!session)throw Error('解密会话已取消。');
        result=session.advance({...args,identity:args.certificateId?store.entries.get(args.certificateId):undefined});
        if(result.bytes)unlockSessions.delete(args.sessionId);
        break;
      }
      case 'encryptionAvailable': {
        const session=unlockSessions.get(args.sessionId);
        if(!session)throw Error('解密会话已取消。');
        result=session.available();unlockSessions.delete(args.sessionId);break;
      }
      case 'encryptionCancel':
        unlockSessions.get(args.sessionId)?.destroy();unlockSessions.delete(args.sessionId);result=null;break;
      case 'encrypt':
        result=encryptOfd(args.bytes,{...args.options,recipients:args.options.recipients.map(r=>({...r,identity:r.certificateId?store.entries.get(r.certificateId):undefined}))});
        break;
      case "import": {
        if(!args.format||args.format==='certificate') {
          const pem=readCertificateBundle(args.bytes).map(c=>`-----BEGIN CERTIFICATE-----\n${certificateKey(c)}\n-----END CERTIFICATE-----`).join('\n');
          result=await store.import({...args,bytes:new TextEncoder().encode(pem)});
        } else result = await store.import(args);
        break;
      }
      case "list":
        result = store.list();
        break;
      case "remove":
        result = store.remove(args.id);
        break;
      case "lock":
        result = store.lock(args.id);
        break;
      case "create":
        result = await createCertificate(store, args);
        break;
      case "sealList":
        result = seals.list();
        break;
      case "sealCreate": {
        const id = await seals.create(store.signingIdentity(args.makerId), {
          ...args.options,
          certificates: args.authorizedIds.map((id) => {
            const cert = store.list().find((c) => c.id === id);
            if (!cert) throw Error("授权证书不存在。");
            return fromBase64(cert.der);
          }),
        });
        result = { id, seals: seals.list(), ...seals.get(id) };
        break;
      }
      case "sealImport": {
        const id = await seals.import(args.bytes);
        result = { id, seals: seals.list(), ...seals.get(id) };
        break;
      }
      case "sealGet":
        result = seals.get(args.id);
        break;
      case "sealRemove":
        result = seals.remove(args.id);
        break;
      case "trust":
        result = store.trust(args.id, args.trusted);
        break;
      case "evidence": {
        const info = await evidenceInfo(args.bytes, args.type, args.name);
        if (materials.size >= 100 && !materials.has(info.id))
          throw Error("最多导入 100 份验证材料。");
        materials.set(info.id, { ...info, bytes: args.bytes });
        result = [...materials.values()].map(({ bytes, ...info }) => info);
        break;
      }
      case "removeEvidence":
        materials.delete(args.id);
        result = [...materials.values()].map(({ bytes, ...info }) => info);
        break;
      case "verify":
        result = await verifyTrustedDocument(
          new OfdDocument(args.bytes, args.selection),
          store,
          [...materials.values()],
        );
        break;
      case "sign":
        result = await signOfd(args.bytes, store.signingIdentity(args.id), {
          selection: args.selection,
          stamp: args.sealId
            ? {
                seal: seals.get(args.sealId).bytes,
                placements: args.placements,
              }
            : undefined,
        });
        break;
      default:
        throw Error("未知证书请求。");
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
}
self.postMessage({ ready: true });
