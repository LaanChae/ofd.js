import { nativeDialog } from './dialogs.js';
import { certificateLabel } from './certificate-view.js';
import { passwordStrengthHint } from './password-strength.js';
import {parsePageRange} from '../shared/stamp-layout.js';
const $=id=>document.getElementById(id);

export function mountEncryption({security,getCurrent,download,status,setBusy}) {
  let pending=null, sessionId=null, createDocument=null, creating=false;
  const unlock=document.createElement('dialog');
  unlock.id='ofdUnlockDialog';unlock.setAttribute('aria-labelledby','ofdUnlockTitle');
  unlock.innerHTML=`<h2 id="ofdUnlockTitle">打开加密 OFD</h2>
    <p id="ofdUnlockDescription" class="ofdMuted"></p>
    <form id="ofdUnlockForm" class="ofdForm">
      <label>接收者<select id="ofdUnlockUser"></select></label>
      <label id="ofdUnlockPasswordRow">文档密码<input id="ofdUnlockPassword" type="password" maxlength="1024" autocomplete="off"></label>
      <label id="ofdUnlockCertificateRow" hidden>解密证书<select id="ofdUnlockCertificate"></select></label>
      <p class="ofdMuted">解密仅在本机内存中进行。“下载原文件”仍保存加密文件；编辑、签署副本或导出 PDF 会生成未加密文件，可通过“文档加密”重新加密 OFD。</p>
      <p id="ofdUnlockMessage" role="status" aria-live="polite"></p>
      <div class="actions"><button id="ofdUnlockAvailable" type="button">只读公开／已解密内容</button><button id="ofdUnlockManage" type="button">证书管理</button><button id="ofdUnlockCancel" type="button">取消</button><button id="ofdUnlockConfirm" type="submit">解密并打开</button></div>
    </form>`;
  const create=document.createElement('dialog');
  create.id='ofdEncryptionDialog';create.setAttribute('aria-labelledby','ofdEncryptionTitle');
  create.innerHTML=`<h2 id="ofdEncryptionTitle">文档加密</h2>
    <p class="ofdMuted">按 GM/T 0099-2020 加密 OFD。任一接收者均可解开本次加密；管理员和用户角色不替代文档权限或签名验证。</p>
    <form id="ofdEncryptionForm" class="ofdForm">
      <label id="ofdEncryptionLayerRow" class="ofdCheck" hidden><input id="ofdEncryptionLayer" type="checkbox">在原加密文件外追加一层加密（仍需原有凭据）</label>
      <label>加密范围<select id="ofdEncryptionScope"><option value="all">整个包（包括元数据、附件及签名）</option><option value="pages">选择页面（自动收集依赖）</option><option value="files">选择包内文件</option></select></label>
      <div id="ofdEncryptionPagesRow" hidden><label>页码范围<input id="ofdEncryptionPages" placeholder="例如 1,3-5；留空表示全部页面"></label><button id="ofdEncryptionPlan" type="button">查看依赖文件</button><p id="ofdEncryptionPlanMessage" role="status"></p><details><summary>依赖文件及选择原因</summary><ul id="ofdEncryptionPlanFiles"></ul></details></div>
      <div id="ofdEncryptionFilesRow" hidden><label>待加密文件<select id="ofdEncryptionFiles" multiple size="8" aria-describedby="ofdEncryptionFilesHint"></select></label><p id="ofdEncryptionFilesHint" class="ofdMuted">按住 Command 或 Ctrl 多选。只保护所选文件；页面可能引用共享字体、图片、模板和注释，请同时选中有关资源。不确定依赖关系时请选择整个包。</p></div>
      <label id="ofdEncryptionPublicRow" class="ofdCheck" hidden><input id="ofdEncryptionPublic" type="checkbox">为所选页面保留空白占位，允许只读公开内容</label>
      <label>范围说明<input id="ofdEncryptionDescription" maxlength="1024" placeholder="可选，写入 EncryptScope"></label>
      <label class="ofdCheck"><input id="ofdEncryptionMap" type="checkbox" checked>加密文件映射表（隐藏原文件路径）</label>
      <label>加密方式<select id="ofdEncryptionScheme"><option value="1.1.1">口令加密（SM4）</option><option value="1.1.2">证书加密（SM2 + SM4）</option></select></label>
      <div id="ofdEncryptionRecipients"></div>
      <div class="actions"><button id="ofdEncryptionAdd" type="button">添加接收者</button><button id="ofdEncryptionManage" type="button">证书管理</button></div>
      <p id="ofdEncryptionMessage" role="status" aria-live="polite"></p>
      <div class="actions"><button id="ofdEncryptionCancel" type="button">取消</button><button id="ofdEncryptionConfirm" type="submit">下载加密 OFD</button></div>
    </form>`;
  document.body.append(unlock,create);
  nativeDialog(unlock,['ofdUnlockConfirm']);nativeDialog(create,['ofdEncryptionConfirm']);
  const message=(id,value,error=false)=>{$(id).textContent=value;$(id).classList.toggle('ofdError',error);};
  async function certificates(select,decrypt=false) {
    const previous=select.value,entries=await security.encryptionCertificates();
    select.replaceChildren(...entries.filter(c=>decrypt?c.canDecrypt:c.canEncrypt).map(c=>new Option(certificateLabel(c),c.id)));
    if([...select.options].some(o=>o.value===previous))select.value=previous;
    if(!select.options.length)select.add(new Option(decrypt?'请导入 SM2 证书及对应私钥':'请创建或导入允许加密的 SM2 证书',''));
  }
  async function showChallenge(challenge) {
    const request=pending;
    if(!request)return;
    $('ofdUnlockDescription').textContent=(challenge.scheme==='1.1.1'?'请选择接收者，输入对应的文档密码。':'请选择接收者及对应的 SM2 解密证书。')+` 加密范围：${challenge.scope||'未注明'}${challenge.provider?`；生成组件：${challenge.provider}`:''}`;
    $('ofdUnlockUser').replaceChildren(...challenge.users.map(u=>new Option(`${u.name} · ${u.type==='Owner'?'管理员':'用户'}`,u.name)));
    const isPassword=challenge.scheme==='1.1.1';
    $('ofdUnlockPasswordRow').hidden=!isPassword;$('ofdUnlockCertificateRow').hidden=isPassword;
    $('ofdUnlockPassword').required=isPassword;
    if(!isPassword)await certificates($('ofdUnlockCertificate'),true);
    message('ofdUnlockMessage',challenge.retry?'密码或证书不匹配，请重试。':'',challenge.retry);
    if(pending===request){request.challenge=challenge;if(!unlock.open)unlock.showModal();(isPassword?$('ofdUnlockPassword'):$('ofdUnlockCertificate')).focus();}
  }
  function cancel() {
    const old=sessionId;sessionId=null;
    if(old)security.encryptionCall('encryptionCancel',{sessionId:old}).catch(()=>{});
    const request=pending;pending=null;
    unlock.close();$('ofdUnlockPassword').value='';
    request?.reject(Error('已取消打开加密文档。'));
    create.close();createDocument=null;$('ofdEncryptionRecipients').replaceChildren();
  }
  unlock.addEventListener('cancel',event=>{event.preventDefault();cancel();});
  $('ofdUnlockCancel').onclick=cancel;
  $('ofdUnlockForm').onsubmit=async event=>{
    event.preventDefault();if(!pending)return;
    const request=pending,id=sessionId,challenge=request.challenge;
    $('ofdUnlockConfirm').disabled=true;message('ofdUnlockMessage','正在解密…');
    try {
      const result=await security.encryptionCall('encryptionUnlock',{sessionId:id,seedPath:challenge.seedPath,userName:$('ofdUnlockUser').value,
        password:challenge.scheme==='1.1.1'?$('ofdUnlockPassword').value:undefined,
        certificateId:challenge.scheme==='1.1.2'?$('ofdUnlockCertificate').value:undefined});
      $('ofdUnlockPassword').value='';
      if(pending!==request||sessionId!==id)return;
      if(result.challenge)await showChallenge(result.challenge);
      else {pending=null;sessionId=null;unlock.close();request.resolve(result);}
    }catch(error){if(pending===request)message('ofdUnlockMessage',error.message,true);}
    finally{$('ofdUnlockConfirm').disabled=false;}
  };
  $('ofdUnlockAvailable').onclick=async()=>{
    const request=pending,id=sessionId;if(!request)return;
    $('ofdUnlockAvailable').disabled=true;
    try {
      const result=await security.encryptionCall('encryptionAvailable',{sessionId:id});
      if(pending!==request||sessionId!==id)return;
      pending=null;sessionId=null;$('ofdUnlockPassword').value='';unlock.close();request.resolve(result);
    }catch(error){if(pending===request)message('ofdUnlockMessage',error.message,true);}
    finally{$('ofdUnlockAvailable').disabled=false;}
  };
  $('ofdUnlockManage').onclick=async()=>{
    const request=pending;unlock.close();await security.manageCertificates();
    if(request&&pending===request)await showChallenge(request.challenge);
  };
  async function addRecipient(role='User') {
    const box=document.createElement('fieldset');box.className='ofdEncryptionRecipient';
    box.innerHTML=`<legend>接收者</legend><label>名称<input data-field="name" required maxlength="256"></label><label>角色<select data-field="role"><option value="User">用户</option><option value="Owner">管理员</option></select></label>
      <label data-kind="password">文档密码<input data-field="password" type="password" maxlength="1024" autocomplete="new-password"></label>
      <label data-kind="password">再次输入密码<input data-field="again" type="password" maxlength="1024" autocomplete="new-password"></label>
      <p data-kind="password" class="ofdMuted" data-strength></p>
      <label data-kind="certificate">接收者证书<select data-field="certificate"></select></label><button type="button" class="secondaryButton">移除接收者</button>`;
    box.querySelector('[data-field=name]').value=role==='Owner'?'管理员':'用户';box.querySelector('[data-field=role]').value=role;
    box.querySelector('button').onclick=()=>box.remove();
    const password=box.querySelector('[data-field=password]');
    password.oninput=()=>{box.querySelector('[data-strength]').textContent=password.value?passwordStrengthHint(password.value):'请输入非空密码，无最短长度限制。';};password.oninput();
    $('ofdEncryptionRecipients').append(box);
    for(const field of box.querySelectorAll('input,select'))field.classList.add('toolbarField');
    await certificates(box.querySelector('[data-field=certificate]'));updateScheme();
  }
  function updateScheme(){
    const password=$('ofdEncryptionScheme').value==='1.1.1';
    for(const box of create.querySelectorAll('.ofdEncryptionRecipient')) {
      for(const row of box.querySelectorAll('[data-kind]'))row.hidden=(row.dataset.kind==='password')!==password;
      for(const field of box.querySelectorAll('input[type=password]')){field.disabled=!password;field.required=password;}
      box.querySelector('[data-field=certificate]').disabled=password;
    }
  }
  $('ofdEncryptionScheme').onchange=updateScheme;
  function updateScope(){
    const layer=$('ofdEncryptionLayer').checked;
    if(layer)$('ofdEncryptionScope').value='all';
    $('ofdEncryptionScope').disabled=layer;
    $('ofdEncryptionFilesRow').hidden=$('ofdEncryptionScope').value!=='files';
    $('ofdEncryptionPagesRow').hidden=$('ofdEncryptionScope').value!=='pages';
    $('ofdEncryptionPublicRow').hidden=$('ofdEncryptionScope').value!=='files';
  }
  async function pagePlan(doc){
    const pageIndices=parsePageRange($('ofdEncryptionPages').value,doc.pages).map(p=>p-1);
    const result=await security.encryptionCall('encryptionPages',{bytes:doc.original,options:{selection:doc.selection,pageIndices}});
    if(doc!==getCurrent()||doc!==createDocument)throw Error('文档已切换。');
    $('ofdEncryptionPlanFiles').replaceChildren(...result.files.map(f=>{const li=document.createElement('li');li.textContent=`${f.path} — ${f.reasons.join('；')}`;return li;}));
    message('ofdEncryptionPlanMessage',`已选 ${result.pages.length} 页、${result.paths.length} 个文件。${result.note}${result.sharedPages.length?`可能受影响的其他页：${result.sharedPages.join('、')}。`:''}`);
    return result;
  }
  $('ofdEncryptionPlan').onclick=async()=>{if(!createDocument)return;try{await pagePlan(createDocument);}catch(e){message('ofdEncryptionPlanMessage',e.message,true);}};
  $('ofdEncryptionPages').oninput=()=>{$('ofdEncryptionPlanMessage').textContent='页码已修改，请重新查看依赖文件。';$('ofdEncryptionPlanFiles').replaceChildren();};
  $('ofdEncryptionScope').onchange=updateScope;$('ofdEncryptionLayer').onchange=updateScope;
  $('ofdEncryptionAdd').onclick=()=>{if(create.querySelectorAll('fieldset').length<100)addRecipient();};
  $('ofdEncryptionManage').onclick=async()=>{
    const doc=createDocument;create.close();await security.manageCertificates();
    if(doc&&doc===getCurrent()&&doc===createDocument){for(const select of create.querySelectorAll('[data-field=certificate]'))await certificates(select);create.showModal();}
  };
  $('ofdEncryptionCancel').onclick=()=>{create.close();createDocument=null;$('ofdEncryptionRecipients').replaceChildren();};
  create.addEventListener('cancel',event=>{if(creating)event.preventDefault();else $('ofdEncryptionCancel').click();});
  $('ofdEncrypt').onclick=async()=>{
    if(creating||getCurrent()?.type!=='ofd'||getCurrent()?.partial)return;
    createDocument=getCurrent();$('ofdEncryptionRecipients').replaceChildren();message('ofdEncryptionMessage','');
    const doc=createDocument;
    $('ofdEncryptionLayerRow').hidden=!doc.sourceOriginal;$('ofdEncryptionLayer').checked=false;
    $('ofdEncryptionScope').value='all';$('ofdEncryptionDescription').value='';$('ofdEncryptionMap').checked=true;$('ofdEncryptionPublic').checked=false;updateScope();
    $('ofdEncryptionPages').value='';$('ofdEncryptionPlanMessage').textContent='';$('ofdEncryptionPlanFiles').replaceChildren();
    try{
      const info=await security.encryptionCall('encryptionInfo',{bytes:doc.original});
      if(doc!==getCurrent()||doc!==createDocument)return;
      $('ofdEncryptionFiles').replaceChildren(...info.files.map(path=>new Option(path,'/'+path)));
    }catch(error){status(error.message);return;}
    await addRecipient('Owner');await addRecipient('User');
    if(createDocument===getCurrent())create.showModal();
  };
  $('ofdEncryptionForm').onsubmit=async event=>{
    event.preventDefault();if(creating||createDocument!==getCurrent())return;
    const doc=createDocument,scheme=$('ofdEncryptionScheme').value;
    const recipients=[...create.querySelectorAll('fieldset')].map(box=>Object.fromEntries(['name','role','password','again','certificate'].map(k=>[k,box.querySelector(`[data-field=${k}]`).value])));
    if(!recipients.length)return message('ofdEncryptionMessage','请至少添加一位接收者。',true);
    if(scheme==='1.1.1'&&recipients.some(r=>r.password!==r.again))return message('ofdEncryptionMessage','接收者的两次密码不一致。',true);
    let paths=$('ofdEncryptionScope').value==='files'?[...$('ofdEncryptionFiles').selectedOptions].map(o=>o.value):undefined;
    if(paths&&!paths.length)return message('ofdEncryptionMessage','请至少选择一个包内文件。',true);
    const source=$('ofdEncryptionLayer').checked?doc.sourceOriginal:doc.original;
    const encryptMap=$('ofdEncryptionMap').checked,scope=$('ofdEncryptionDescription').value.trim()||undefined,publicPages=!!paths&&$('ofdEncryptionPublic').checked;
    creating=true;setBusy(true);for(const field of create.querySelectorAll('input,select,button'))field.disabled=true;
    message('ofdEncryptionMessage','正在加密所选内容…');
    try {
      if($('ofdEncryptionScope').value==='pages')paths=(await pagePlan(doc)).paths;
      const bytes=await security.encryptionCall('encrypt',{bytes:source,options:{scheme,paths,scope,encryptMap,publicPages,recipients:recipients.map(r=>({userName:r.name,userType:r.role,password:scheme==='1.1.1'?r.password:undefined,certificateId:scheme==='1.1.2'?r.certificate:undefined}))}});
      if(doc!==getCurrent())return;
      download(bytes,doc.name.replace(/\.ofd$/i,'-encrypted.ofd'),'application/ofd');
      create.close();$('ofdEncryptionRecipients').replaceChildren();status('已下载加密 OFD，当前打开的文档未改变。');
    }catch(error){message('ofdEncryptionMessage',error.message,true);}
    finally{recipients.forEach(r=>{r.password='';r.again='';});creating=false;if(doc===getCurrent())setBusy(false);for(const field of create.querySelectorAll('input,select,button'))field.disabled=false;updateScheme();updateScope();}
  };
  return {
    cancel,
    async open(bytes,isCurrent) {
      const id=crypto.randomUUID();sessionId=id;
      const result=await security.encryptionCall('encryptionOpen',{bytes,sessionId:id});
      if(!isCurrent()||sessionId!==id)throw Error('打开操作已取消。');
      if(!result.encrypted){sessionId=null;return {bytes,encrypted:false};}
      if(result.bytes){sessionId=null;return {bytes:result.bytes,encrypted:true};}
      const plain=await new Promise((resolve,reject)=>{pending={resolve,reject,challenge:result.challenge};showChallenge(result.challenge).catch(reject);});
      return {...plain,encrypted:true};
    },
  };
}
