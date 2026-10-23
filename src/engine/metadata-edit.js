import {XMLSerializer} from '@xmldom/xmldom';
import {zipSync,strToU8} from 'fflate';
import {attr,child,children,name,NS,resolve,text,xmlParse} from './archive.js';
import {protectedFiles} from './annotation-edit.js';
import {metadataFields,metadataText,validateMetadataField} from '../../public/shared/metadata-fields.js';
const order=[...metadataFields.map(([key])=>key)];order.splice(order.indexOf('Creator'),0,'Keywords');order.push('CustomDatas');
function element(parent,tag){return parent.ownerDocument.createElementNS(parent.namespaceURI||NS,`${parent.prefix||'ofd'}:${tag}`);}
function field(info,tag){let node=child(info,tag);if(!node){node=element(info,tag);info.insertBefore(node,children(info).find(n=>order.indexOf(name(n))>order.indexOf(tag))||null);}return node;}
export function documentEditBlocked(doc){
  const edit=child(child(doc.root,'Permissions'),'Edit');
  if(edit){const value=text(edit);if(!['true','1','false','0'].includes(value))return '文档 Edit 权限值无效。';if(value==='false'||value==='0')return '文档权限禁止编辑。';}
  return doc.version&&!doc.version.current?'历史版本不能原地编辑。':'';
}
export function metadataEditBlocked(doc){
  const blocked=documentEditBlocked(doc);if(blocked)return blocked;
  if(doc.documents[doc.selection.documentIndex].versions.length)return '文档元数据由多个版本共享，不能原地修改。';
  try{return protectedFiles(doc).has('OFD.xml')?'文档元数据受数字签名保护，不能修改。':'';}catch(error){return error.message;}
}
export function readMetadata(doc){
  const info=child(doc.body,'DocInfo');
  return {info:Object.fromEntries(metadataFields.map(([key])=>[key,child(info,key)?.textContent||''])),
    keywords:children(child(info,'Keywords'),'Keyword').map(n=>n.textContent),
    customData:children(child(info,'CustomDatas'),'CustomData').map((n,index)=>({index,name:attr(n,'Name'),value:n.textContent})),
    blocked:metadataEditBlocked(doc)};
}
// Shared by the general editor and official-field synchronization. Operates on
// a cloned OFD.xml so failures never mutate an open document or signed bytes.
export function updateDocInfo(doc,entry,patch){
  const blocked=metadataEditBlocked(doc);if(blocked)throw Error(blocked);
  const body=children(entry,'DocBody')[doc.selection.documentIndex];
  let info=child(body,'DocInfo');if(!info){info=element(body,'DocInfo');body.insertBefore(info,child(body,'DocRoot'));field(info,'DocID').textContent=crypto.randomUUID().replaceAll('-','');}
  for(const [key,value] of Object.entries(patch.info||{})){
    validateMetadataField(key,value);
    if(key==='Cover'&&value&&!doc.archive.has(resolve('OFD.xml',value)))throw Error('封面路径未指向包内已有文件。');
    if(value===''){for(const n of children(info,key))info.removeChild(n);}
    else field(info,key).textContent=value;
  }
  if(patch.keywords!==undefined){
    if(!Array.isArray(patch.keywords))throw Error('关键词列表无效。');
    const list=field(info,'Keywords');for(const n of children(list,'Keyword'))list.removeChild(n);
    for(const value of patch.keywords){metadataText(value);if(!value.trim())continue;const n=element(list,'Keyword');n.textContent=value;list.appendChild(n);}
    if(!list.hasChildNodes())info.removeChild(list);
  }
  if(patch.customData!==undefined){
    if(!Array.isArray(patch.customData)||patch.customData.length>10000)throw Error('自定义元数据列表无效或超过 10000 项。');
    const list=field(info,'CustomDatas'),old=children(list,'CustomData'),used=new Set(),next=[];
    for(const item of patch.customData){
      metadataText(item.name);metadataText(item.value);if(!item.name.trim())throw Error('自定义元数据名称不能为空。');
      let n;
      if(item.index!==undefined){if(!Number.isInteger(item.index)||!old[item.index]||used.has(item.index))throw Error('自定义元数据条目已失效或重复。');used.add(item.index);n=old[item.index].cloneNode(true);}else n=element(list,'CustomData');
      n.setAttribute('Name',item.name);if(n.textContent!==item.value)n.textContent=item.value;next.push(n);
    }
    for(const n of old)list.removeChild(n);for(const n of next)list.appendChild(n);
    if(!list.hasChildNodes())info.removeChild(list);
  }
  if(patch.customValues){
    const list=field(info,'CustomDatas');
    for(const [key,value] of Object.entries(patch.customValues)){
      metadataText(key);metadataText(value);
      for(const n of children(list,'CustomData'))if(attr(n,'Name')===key)list.removeChild(n);
      if(value.trim()){const n=element(list,'CustomData');n.setAttribute('Name',key);n.textContent=value.trim();list.appendChild(n);}
    }
    if(!list.hasChildNodes())info.removeChild(list);
  }
}
export function editMetadata(doc,patch){
  if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['info','keywords','customData'].includes(k)))throw Error('元数据修改请求无效。');
  const entry=xmlParse(doc.archive.read('OFD.xml'));updateDocInfo(doc,entry,patch);
  const files=Object.fromEntries(doc.archive.materialize());files['OFD.xml']=strToU8(new XMLSerializer().serializeToString(entry));return zipSync(files);
}
