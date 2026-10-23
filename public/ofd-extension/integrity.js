import {nativeDialog,line} from './dialogs.js';
import {certificateLabel,certificateIdentity,propertyRows} from './certificate-view.js';
const $=id=>document.getElementById(id);

export async function requestTimestamp(url,request,signal) {
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password)throw Error('请使用不含用户名密码的 HTTPS 时间戳服务地址。');
  const response=await fetch(target,{method:'POST',body:request,headers:{'Content-Type':'application/timestamp-query','Accept':'application/timestamp-reply'},credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal});
  if(!response.ok)throw Error(`时间戳服务返回 HTTP ${response.status}。`);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16*1048576)throw Error('时间戳响应超过 16 MB。');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}

export function mountIntegrity({security,getCurrent,download,status}) {
  let doc=null,pending=null,busy=false,controller=null,revision=0;
  const dialog=document.createElement('dialog');dialog.id='ofdIntegrityDialog';dialog.setAttribute('aria-labelledby','ofdIntegrityTitle');
  dialog.innerHTML=`<h2 id="ofdIntegrityTitle">防夹带完整性保护</h2>
    <p class="ofdMuted">按 GM/T 0099-2020 §7.4 签名包内文件清单并附加时间戳，检查未登记或缺失的文件。正文内容是否被修改，仍需使用“签名验证”检查数字签名。</p>
    <div class="ofdForm"><label id="ofdIntegrityTargetRow">保护对象<select id="ofdIntegrityTarget"><option value="original">原始加密包</option><option value="current">当前解密内容</option></select></label></div>
    <p id="ofdIntegritySummary"></p><details><summary>包内文件清单</summary><ul id="ofdIntegrityFiles"></ul></details>
    <div class="actions"><button id="ofdIntegrityVerify" type="button">验证完整性保护</button><button id="ofdIntegrityManage" type="button">证书与验证材料</button></div>
    <div id="ofdIntegrityReport" aria-live="polite"></div>
    <details id="ofdIntegrityCreate"><summary>创建完整性保护副本</summary><div class="ofdForm">
      <label>签名证书<select id="ofdIntegrityCertificate"></select></label>
      <label>时间戳来源<select id="ofdIntegrityMode"><option value="offline">下载请求并导入响应</option><option value="online">连接时间戳服务</option></select></label>
      <label id="ofdIntegrityUrlRow" hidden>时间戳服务<input id="ofdIntegrityUrl" type="url" placeholder="https://…"></label>
      <p class="ofdMuted">在线请求仅发送签名值的 SM3 摘要及随机数，需要服务允许浏览器跨域访问。离线模式请将 .tsq 请求交给时间戳服务，再导入其 .tsr 响应；保持此窗口打开。</p>
      <div class="actions"><button id="ofdIntegrityPrepare" type="button">生成签名与时间戳请求</button></div>
      <label id="ofdIntegrityResponseRow" hidden>时间戳响应<input id="ofdIntegrityResponse" type="file" accept=".tsr,application/timestamp-reply"></label>
      <div class="actions"><button id="ofdIntegrityFinish" type="button" hidden>验证响应并下载 OFD</button></div>
    </div></details>
    <p id="ofdIntegrityMessage" role="status" aria-live="polite"></p>
    <div class="actions"><button id="ofdIntegrityClose" type="button">关闭</button></div>`;
  document.body.append(dialog);nativeDialog(dialog,['ofdIntegrityPrepare','ofdIntegrityFinish']);
  const message=(s,error=false)=>{$('ofdIntegrityMessage').textContent=s;$('ofdIntegrityMessage').classList.toggle('ofdError',error);};
  const call=(method,args)=>security.encryptionCall(method,args);
  const bytes=()=>doc?.sourceOriginal&&$('ofdIntegrityTarget').value==='original'?doc.sourceOriginal:doc.original;
  function clearPending(){controller?.abort();controller=null;if(pending)call('integrityCancel',{sessionId:pending.id}).catch(()=>{});pending=null;$('ofdIntegrityResponse').value='';$('ofdIntegrityResponseRow').hidden=true;$('ofdIntegrityFinish').hidden=true;}
  function cancel(){revision++;clearPending();doc=null;dialog.close();busy=false;}
  function setBusy(value){busy=value;for(const el of dialog.querySelectorAll('button,input,select'))if(el.id!=='ofdIntegrityClose')el.disabled=value;}
  function showReport(report){
    const output=$('ofdIntegrityReport');output.replaceChildren();
    const label={passed:'通过',failed:'失败',incomplete:'未完全确认',absent:'未设置',unknown:'未确认','not-checked':'未检查'};
    line(output,`验证结果：${label[report.status]||report.status}`,'p',report.status==='failed'?'ofdError':'');
    line(output,report.reason||'');
    if(report.status==='absent')return;
    propertyRows(output,[['文件清单',label[report.inventory]||report.inventory],['清单签名',label[report.signature]||report.signature],['登记文件数量',String(report.count??0)],['创建者',report.creator],['创建日期',report.date]]);
    for(const [title,paths] of [['未登记文件',report.extra],['缺失文件',report.missing],['已登记但未被文档引用',report.references?.unreferenced]])if(paths?.length){const detail=line(output,'','details');line(detail,`${title}（${paths.length}）`,'summary');for(const p of paths)line(detail,p);}
    if(report.references?.status==='unavailable')line(output,`引用关系未检查：${report.references.reason}`,'p','ofdMuted');
    const revocation={good:'未吊销',revoked:'已吊销',unknown:'未确认','not-applicable':'不适用'};
    for(const signer of report.signers||[]){certificateIdentity(output,signer.certificate);propertyRows(output,[['证书信任',signer.validation.trust==='trusted'?'可信':signer.validation.trust==='failed'?'失败':'未确认'],['吊销状态',revocation[signer.validation.revocation]||signer.validation.revocation],['说明',signer.validation.reason]]);}
    for(const timestamp of report.timestamps||[])propertyRows(output,[['时间戳',label[timestamp.status]],['时间戳时间',timestamp.time],['时间戳说明',timestamp.reason]]);
  }
  async function load(preserveRequest=false){
    const owner=doc,rev=revision,certificateId=$('ofdIntegrityCertificate').value;
    if(!preserveRequest)clearPending();$('ofdIntegrityReport').replaceChildren();message('');
    const [info,certs]=await Promise.all([call('integrityInspect',{bytes:bytes()}),security.encryptionCertificates()]);
    if(doc!==owner||revision!==rev||doc!==getCurrent())return;
    $('ofdIntegrityFiles').replaceChildren(...info.files.map(p=>{const li=document.createElement('li');li.textContent=p;return li;}));
    $('ofdIntegritySummary').textContent=`${info.files.length} 个包内文件；${info.present?'已有完整性保护，可验证，不能覆盖旧清单。':'尚未设置完整性保护。'}${info.references.unreferenced?.length?` 检出 ${info.references.unreferenced.length} 个未被引用的文件，需先处理。`:''}${info.references.status==='unavailable'?` ${info.references.reason}`:''}`;
    $('ofdIntegrityCertificate').replaceChildren(...certs.filter(c=>c.canSign&&c.algorithm.startsWith('SM2')).map(c=>new Option(certificateLabel(c),c.id)));
    if(!$('ofdIntegrityCertificate').options.length)$('ofdIntegrityCertificate').add(new Option('请创建或导入 SM2 签名证书和私钥',''));
    if([...$('ofdIntegrityCertificate').options].some(o=>o.value===certificateId))$('ofdIntegrityCertificate').value=certificateId;
    if(preserveRequest&&$('ofdIntegrityCertificate').value!==certificateId)clearPending();
    $('ofdIntegrityCreate').hidden=info.present;
  }
  async function finish(response,owner,id,rev){
    const result=await call('integrityFinish',{sessionId:id,response});
    if(doc!==owner||doc!==getCurrent()||pending?.id!==id||revision!==rev)return;
    pending=null;$('ofdIntegrityResponse').value='';$('ofdIntegrityResponseRow').hidden=true;$('ofdIntegrityFinish').hidden=true;
    download(result.bytes,owner.name.replace(/\.ofd$/i,'-protected.ofd'),'application/ofd');showReport(result.report);
    message(`已下载完整性保护副本。${result.timestamp.status==='passed'?'时间戳验证通过。':'时间戳密码学验证通过，但信任链或吊销状态未完全确认。'}`);
  }
  $('ofdIntegrityMode').onchange=()=>{$('ofdIntegrityUrlRow').hidden=$('ofdIntegrityMode').value!=='online';clearPending();};
  $('ofdIntegrityTarget').onchange=()=>load().catch(e=>message(e.message,true));
  $('ofdIntegrityCertificate').onchange=clearPending;
  $('ofdIntegrityClose').onclick=cancel;dialog.addEventListener('cancel',e=>{e.preventDefault();cancel();});
  $('ofdIntegrityManage').onclick=async()=>{
    const owner=doc;dialog.close();await security.manageCertificates();
    if(doc===owner&&doc===getCurrent()){dialog.showModal();try{await load(true);}catch(e){message(e.message,true);}}
  };
  $('ofdIntegrityVerify').onclick=async()=>{
    if(busy||!doc)return;const owner=doc,rev=revision;setBusy(true);message('正在检查清单、签名及时间戳…');
    try{const report=await call('integrityVerify',{bytes:bytes()});if(doc===owner&&revision===rev){showReport(report);message('验证完成。');}}
    catch(e){if(doc===owner)message(e.message,true);}finally{if(revision===rev)setBusy(false);}
  };
  $('ofdIntegrityPrepare').onclick=async()=>{
    if(busy||!doc)return;
    const owner=doc,rev=revision,id=crypto.randomUUID();clearPending();pending={id};setBusy(true);message('正在签名文件清单…');
    try{
      const result=await call('integrityPrepare',{bytes:bytes(),certificateId:$('ofdIntegrityCertificate').value,sessionId:id});
      if(doc!==owner||revision!==rev||pending?.id!==id)return;
      if($('ofdIntegrityMode').value==='offline'){
        download(result.request,owner.name.replace(/\.ofd$/i,'-integrity.tsq'),'application/timestamp-query');
        $('ofdIntegrityResponseRow').hidden=false;$('ofdIntegrityFinish').hidden=false;message('已下载时间戳请求。请导入本次请求对应的 .tsr 响应；此时尚未生成保护副本。');
      }else{
        controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),30000);
        try{message('正在请求时间戳服务…');const response=await requestTimestamp($('ofdIntegrityUrl').value,result.request,controller.signal);await finish(response,owner,id,rev);}
        finally{clearTimeout(timeout);controller=null;}
      }
    }catch(e){if(doc===owner&&revision===rev)message(e.message,true);}
    finally{if(revision===rev)setBusy(false);}
  };
  $('ofdIntegrityFinish').onclick=async()=>{
    if(busy||!pending)return;const owner=doc,id=pending.id,rev=revision,file=$('ofdIntegrityResponse').files[0];
    if(!file||file.size>16*1048576){message('请选择不超过 16 MB 的时间戳响应文件。',true);return;}
    setBusy(true);message('正在验证时间戳响应…');
    try{await finish(new Uint8Array(await file.arrayBuffer()),owner,id,rev);}catch(e){if(doc===owner&&revision===rev)message(e.message,true);}finally{if(revision===rev)setBusy(false);}
  };
  $('ofdIntegrity').onclick=async()=>{
    if(getCurrent()?.type!=='ofd'||getCurrent().partial)return;
    cancel();doc=getCurrent();setBusy(false);$('ofdIntegrityTargetRow').hidden=!doc.sourceOriginal;$('ofdIntegrityTarget').value=doc.sourceOriginal?'original':'current';
    dialog.showModal();try{await load();}catch(e){message(e.message,true);status(e.message);}
  };
  return {cancel};
}
