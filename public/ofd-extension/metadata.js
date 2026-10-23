import {metadataFields,metadataText,validateMetadataField} from '../shared/metadata-fields.js';
import {line,nativeDialog} from './dialogs.js';
export async function mountMetadata(app,save,status) {
  const dialog=document.createElement('dialog');dialog.id='ofdMetadataDialog';dialog.setAttribute('aria-label','编辑文档元数据');
  line(dialog,'编辑文档元数据','h2');line(dialog,'编辑当前 OFD 文档的属性和自定义字段，不改变页面正文。保存后可下载当前 OFD。','p','ofdMuted');
  const infoSection=line(dialog,'','details');infoSection.open=true;line(infoSection,'普通元数据','summary');
  const grid=line(infoSection,'','div','ofdMetadataFields'),inputs=new Map();
  function input(parent,label,id,textarea=false){const term=line(parent,label,'label');term.htmlFor=id;const control=document.createElement(textarea?'textarea':'input');control.id=id;control.className='toolbarField';if(textarea)control.rows=3;parent.append(control);return control;}
  for(const [key,label] of metadataFields){const control=input(grid,label,`ofdMetadata_${key}`,key==='Abstract');inputs.set(key,control);if(['CreationDate','ModDate'].includes(key))control.placeholder='YYYY-MM-DD';}
  const keywords=input(grid,'关键词（每行一个）','ofdMetadataKeywords',true);
  const customSection=line(dialog,'','section');line(customSection,'自定义元数据','h3');line(customSection,'名称和值均可编辑；删除条目会移除该字段。公文字段也会在这里显示。','p','ofdMuted');
  const rows=line(customSection,'','div','ofdMetadataRows');
  const add=line(customSection,'添加字段','button');add.id='ofdMetadataAdd';add.type='button';
  const feedback=line(dialog,'','p','ofdMuted');feedback.setAttribute('role','status');feedback.id='ofdMetadataFeedback';
  const actions=line(dialog,'','div','buttonRow');const cancel=line(actions,'取消','button');cancel.id='ofdMetadataCancel';const commit=line(actions,'保存到 OFD','button');commit.id='ofdMetadataSave';
  document.body.append(dialog);nativeDialog(dialog,[commit.id]);await app.overlayManager.register(dialog);
  let owner,data,serial=0,rowSerial=0;
  const entries=[];
  function addRow(item={name:'',value:''}){
    const row=line(rows,'','div','ofdMetadataRow'),id=++rowSerial;
    const name=input(row,'名称',`ofdMetadataName${id}`),value=input(row,'值',`ofdMetadataValue${id}`,true);name.value=item.name;value.value=item.value;
    const remove=line(row,'删除','button');remove.className='secondaryButton';remove.type='button';remove.setAttribute('aria-label',`删除字段 ${item.name||id}`);
    const entry={row,name,value,index:item.index};entries.push(entry);remove.onclick=()=>{entries.splice(entries.indexOf(entry),1);row.remove();add.focus();};
    for(const n of [name,value,remove])n.disabled=!!data?.blocked;
    return entry;
  }
  add.onclick=()=>addRow().name.focus();cancel.onclick=()=>app.overlayManager.close(dialog);
  async function show(){
    const doc=app.pdfDocument,request=++serial;if(!doc?.isOFD)return;
    const result=await doc.engine.call('metadata');if(app.pdfDocument!==doc||request!==serial)return;
    owner=doc;data=result;entries.length=0;rows.replaceChildren();
    for(const [key,control] of inputs){control.value=data.info[key];control.disabled=!!data.blocked;}
    keywords.value=data.keywords.join('\n');keywords.disabled=!!data.blocked;data.customData.forEach(addRow);
    add.disabled=commit.disabled=!!data.blocked;feedback.textContent=data.blocked||'';feedback.classList.remove('ofdError');await app.overlayManager.open(dialog);
  }
  commit.onclick=async()=>{
    try{
      if(owner!==app.pdfDocument)throw Error('文档已切换，请重新打开编辑窗口。');
      const patch={},info={};
      for(const [key,control] of inputs)if(control.value!==data.info[key]){validateMetadataField(key,control.value);info[key]=control.value;}
      if(Object.keys(info).length)patch.info=info;
      if(keywords.value!==data.keywords.join('\n'))patch.keywords=keywords.value.split('\n').filter(s=>s.trim());
      const customData=entries.filter(e=>e.index!==undefined||e.name.value||e.value.value).map(e=>({...(e.index!==undefined?{index:e.index}:{}),name:e.name.value,value:e.value.value}));
      if(JSON.stringify(customData)!==JSON.stringify(data.customData)){
        for(const item of customData){metadataText(item.name);metadataText(item.value);if(!item.name.trim())throw Error('请填写自定义元数据的名称。');}patch.customData=customData;
      }
      if(!Object.keys(patch).length){feedback.textContent='没有需要保存的修改。';return;}
      commit.disabled=true;await app.overlayManager.close(dialog);await save(patch);
    }catch(error){feedback.textContent=error.message;feedback.classList.add('ofdError');status(error.message,true);if(owner===app.pdfDocument&&!dialog.open)await app.overlayManager.open(dialog);}
    finally{commit.disabled=!!data?.blocked;}
  };
  document.getElementById('ofdMetadata').onclick=()=>show().catch(e=>status(e.message,true));
  app.eventBus.on('ofdeditmetadata',()=>show().catch(e=>status(e.message,true)));
  app.eventBus.on('pagesdestroy',()=>{++serial;owner=null;data=null;app.overlayManager.closeIfActive(dialog);});
}
