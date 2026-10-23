import {Certificate,ContentInfo,SignedData,CertificateChainValidationEngine} from 'pkijs';
import {parseASN1,OfdCrypto} from './signatures.js';
import {decodePem,base64,fromBase64} from './certificates.js';
const der=c=>new Uint8Array(c.toSchema().toBER(false));
export const certificateKey=c=>base64(der(c));
export function uniqueCertificates(certs) {
  const result=[...new Map(certs.map(c=>[certificateKey(c),c])).values()];
  if(result.length>100)throw Error('验证涉及的证书超过 100 张。');
  return result;
}
export function readCertificateBundle(bytes) {
  const certs=[];
  for(const block of decodePem(bytes)) {
    const root=parseASN1(block.bytes);
    try {certs.push(new Certificate({schema:root}));}
    catch {
      const envelope=new ContentInfo({schema:root});
      if(!['1.2.840.113549.1.7.2','1.2.156.10197.6.1.4.2.2'].includes(envelope.contentType))throw Error('文件不是 X.509 或 SignedData 证书包。');
      certs.push(...(new SignedData({schema:envelope.content}).certificates||[]).filter(c=>c instanceof Certificate));
    }
  }
  if(!certs.length)throw Error('文件没有包含 X.509 证书。');
  return uniqueCertificates(certs);
}
export function timestampCertificates(tokens=[]) {
  const certs=[];
  for(const token of tokens)try {
    const content=new ContentInfo({schema:parseASN1(fromBase64(token))});
    if(['1.2.840.113549.1.7.2','1.2.156.10197.6.1.4.2.2'].includes(content.contentType))certs.push(...(new SignedData({schema:content.content}).certificates||[]).filter(c=>c instanceof Certificate));
  }catch{/* Invalid timestamp is reported by the timestamp verifier. */}
  return certs;
}
export async function certificateIssuers(cert,certs) {
  const chain=new CertificateChainValidationEngine({certs, trustedCerts:[]});
  return chain.findIssuer(cert,chain,new OfdCrypto());
}
