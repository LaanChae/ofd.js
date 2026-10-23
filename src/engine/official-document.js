import {documentEditBlocked, metadataEditBlocked, updateDocInfo} from './metadata-edit.js';
import { XMLSerializer } from '@xmldom/xmldom';
import { zipSync, strToU8 } from 'fflate';
import { attr, child, children, name, NS, resolve, text, xmlParse } from './archive.js';
import { protectedFiles, sharedVersionFile } from './annotation-edit.js';
import { officialFields, semanticFields, OFFICIAL_NS, validateOfficialMetadata } from '../../public/shared/official-fields.js';

const namespaces = new Set([OFFICIAL_NS, `${OFFICIAL_NS}/body`]); // Both appear in GB/T 33476.1 (§6.1 / Annex A).
const compact = value => value.replace(/\s/gu,'');
function element(parent, tag, ns = parent.namespaceURI || NS) {
  const prefix = ns === NS ? (parent.prefix || 'ofd') : (parent.prefix || 'od');
  return parent.ownerDocument.createElementNS(ns,`${prefix}:${tag}`);
}
function setChild(parent,tag,value,before=null) {
  let node=child(parent,tag);
  if(!node){node=element(parent,tag);parent.insertBefore(node,before);}
  node.textContent=value;return node;
}
function tagFiles(doc) {
  const location=text(doc.root,'CustomTags');if(!location)return [];
  const index=resolve(doc.docFile,location);
  return children(doc.archive.xml(index),'CustomTag').filter(n=>attr(n,'TypeID')==='od').map(n=>({index,file:resolve(index,text(n,'FileLoc'))}));
}
export function pageOfficialObjects(doc,index) {
  doc._officialObjects ??= new Map();
  if(doc._officialObjects.has(index))return doc._officialObjects.get(index);
  const page=doc.page(index),objects=new Map(),active=new Set();
  function walk(node,depth=0) {
    if(!node||depth>64)throw Error('公文图元引用嵌套过深。');
    const kind=name(node),id=attr(node,'ID');
    if(['TextObject','PathObject','ImageObject','CompositeObject'].includes(kind)&&id) {
      const old=objects.get(id);
      if(old&&old.node!==node)old.duplicate=true;
      else if(!old)objects.set(id,{node,text:kind==='TextObject'?children(node,'TextCode').map(n=>n.textContent).join(''):'',kind});
    }
    if(kind==='CompositeObject') {
      const key=attr(node,'ResourceID');if(active.has(key))throw Error('复合图元存在循环引用。');
      const resource=doc.resources.composites.get(key);if(resource){active.add(key);walk(child(resource.node,'Content'),depth+1);active.delete(key);}
    }
    if(['Page','Content','Layer','PageBlock'].includes(kind))for(const n of children(node))if(['Content','Layer','PageBlock','TextObject','PathObject','ImageObject','CompositeObject'].includes(name(n)))walk(n,depth+1);
  }
  walk(page.root);
  for(const id of page.templateIds){const template=doc.templates.get(id);if(template)walk(doc.archive.xml(template.file));}
  doc._officialObjects.set(index,objects);return objects;
}
function resolveRef(doc,ref) {
  const index=doc.pages.findIndex(p=>p.id===ref.pageId);
  if(index<0)throw Error(`页面 ID ${ref.pageId} 不存在。`);
  const object=pageOfficialObjects(doc,index).get(ref.objectId);
  if(!object||object.duplicate)throw Error(`第 ${index+1} 页图元 ${ref.objectId} ${object?'ID 重复':'不存在'}。`);
  return {...ref,pageIndex:index,text:object.text,kind:object.kind};
}
function readTree(doc,root,file,issues) {
  let count=0;
  function walk(node,indices=[],path=[]) {
    if(++count>10000||indices.length>64)throw Error('公文标引节点过多或嵌套过深。');
    const tag=name(node),parts=[...path,tag],refs=[];
    for(const n of children(node,'ObjectRef'))for(const objectId of text(n).split(',').map(s=>s.trim()).filter(Boolean)) {
      const ref={pageId:attr(n,'PageRef'),objectId};
      try{refs.push(resolveRef(doc,ref));}catch(error){issues.push({severity:'error',field:parts.join('/'),message:error.message});refs.push({...ref,error:error.message});}
    }
    const kids=children(node).filter(n=>name(n)!=='ObjectRef');
    if(!kids.length&&!refs.length&&!text(node))issues.push({severity:'warning',field:parts.join('/'),message:'要素为空，尚未关联页面图元。'});
    if(refs.length&&kids.length)issues.push({severity:'error',field:parts.join('/'),message:'ObjectRef 应关联叶子要素。'});
    const directText=Array.from(node.childNodes).filter(n=>n.nodeType===3||n.nodeType===4).map(n=>n.nodeValue).join('').trim();
    const result={key:JSON.stringify([file,indices]),name:tag,path:parts.join('/'),refs,text:refs.length?refs.map(r=>r.text||'').join(''):directText,children:kids.map((n,i)=>walk(n,[...indices,i],parts))};
    return result;
  }
  if(!namespaces.has(root.namespaceURI))issues.push({severity:'warning',field:file,message:'公文结构命名空间不符合 GB/T 33476.1，按节点名称展示。'});
  if(name(root)!=='电子公文'||attr(root,'版本号')!=='1.0')issues.push({severity:'error',field:file,message:'公文结构应以电子公文为根节点，版本号为 1.0。'});
  const tree=walk(root);
  const body=child(root,'公文体');
  for(const [parent,tag] of [[body,'版头'],[body,'主体'],[child(body,'版头'),'发文机关标志'],[child(body,'版头'),'发文字号'],[child(body,'主体'),'标题'],[child(body,'主体'),'正文'],[child(body,'主体'),'成文日期']])
    if(!child(parent,tag))issues.push({severity:'error',field:file,message:`公文结构缺少 ${tag}。`});
  for(const [parentTag,required] of [['发文机关标志',[]],['发文字号',['发文机关代字','年份','发文顺序号']],['密级和保密期限',['密级']],['印发机关和印发日期',['印发机关','印发日期']]]) {
    function check(node){if(name(node)===parentTag)for(const tag of required)if(!child(node,tag))issues.push({severity:'error',field:file,message:`${parentTag}缺少 ${tag}。`});for(const n of children(node))check(n);}
    check(root);
  }
  return tree;
}
export function readOfficial(doc) {
  const metadata=doc.properties.customData,issues=validateOfficialMetadata(metadata),trees=[];
  try {for(const {file} of tagFiles(doc))try{trees.push(readTree(doc,doc.archive.xml(file),file,issues));}catch(error){issues.push({severity:'error',field:file,message:error.message});}}
  catch(error){issues.push({severity:'error',field:'CustomTags',message:error.message});}
  if(!trees.length)issues.push({severity:'warning',field:'CustomTags',message:'尚未添加公文结构标引。'});
  const values=Object.fromEntries(metadata.map(n=>[n.name,n.value]));
  const actual=new Map();
  function collect(node){const path=node.path.replace(/^电子公文\/公文体\//,''),field=semanticFields.find(f=>f.path===path)?.key;
    if(field&&node.refs.length){if(!actual.has(field))actual.set(field,new Set());actual.get(field).add(node.text);}
    node.children.forEach(collect);
  }
  trees.forEach(collect);
  for(const [field,parts] of actual)if(values[field]&&compact(values[field]).replaceAll('^','')!==compact([...parts].join('')).replaceAll('^',''))issues.push({severity:'warning',field,message:'元数据与页面关联文字不一致，请核对。'});
  const editBlocked=documentEditBlocked(doc),metadataBlocked=metadataEditBlocked(doc);
  return {metadata,trees,issues,editBlocked,metadataBlocked};
}
function nodeByKey(root,key,file) {
  const [target,indices]=JSON.parse(key);if(target!==file||!Array.isArray(indices))throw Error('标引节点无效。');
  let node=root;for(const index of indices){if(!Number.isInteger(index))throw Error('标引节点无效。');node=children(node).filter(n=>name(n)!=='ObjectRef')[index];if(!node)throw Error('标引节点已不存在。');}
  return node;
}
function orderedChild(parent,tag) {
  let node=child(parent,tag);if(node)return node;
  const parentPath=[];for(let p=parent;p&&name(p)!=='公文体';p=p.parentNode)parentPath.unshift(name(p));
  const order=[...new Set(semanticFields.map(f=>f.path.split('/')).filter(p=>parentPath.every((v,i)=>p[i]===v)).map(p=>p[parentPath.length]).filter(Boolean))];
  node=element(parent,tag);
  parent.insertBefore(node,children(parent).find(n=>order.indexOf(name(n))>order.indexOf(tag))||null);return node;
}
export function editOfficial(doc,patch) {
  if(!patch||typeof patch!=='object')throw Error('公文修改请求无效。');
  const blocked=documentEditBlocked(doc);if(blocked)throw Error(blocked);
  const changed=new Map(), xml=new Map(), get=file=>{if(!xml.has(file))xml.set(file,xmlParse(doc.archive.read(file)));return xml.get(file);};
  const values={...(patch.values||{})};
  if(patch.mark||patch.remove) {
    let entries=tagFiles(doc),entry;
    const key=patch.remove||patch.mark?.target;
    if(key){const [file]=JSON.parse(key);entry=entries.find(e=>e.file===file);if(!entry)throw Error('公文结构文件不存在。');}
    else entry=entries[0];
    if(!entry) {
      const documentRoot=get(doc.docFile),directory=doc.docFile.slice(0,doc.docFile.lastIndexOf('/')+1);
      let index=text(documentRoot,'CustomTags')?resolve(doc.docFile,text(documentRoot,'CustomTags')):'';
      const unique=stem=>{let i=0,file;do{file=`${directory}Tags/${stem}${i||''}.xml`;i++;}while(doc.archive.has(file)||xml.has(file));return file;};
      if(!index){index=unique('CustomTags');xml.set(index,xmlParse(`<ofd:CustomTags xmlns:ofd="${NS}"/>`));setChild(documentRoot,'CustomTags',`/${index}`,child(documentRoot,'Attachments')||child(documentRoot,'Extensions')||null);}
      const file=unique('OfficialDocument'),list=xml.get(index)||get(index),tag=element(list,'CustomTag');tag.setAttribute('TypeID','od');setChild(tag,'FileLoc',`/${file}`);list.appendChild(tag);
      xml.set(file,xmlParse(`<od:电子公文 xmlns:od="${OFFICIAL_NS}" 版本号="1.0"><od:公文体><od:版头/><od:主体/></od:公文体></od:电子公文>`));
      entry={index,file};
    }
    const root=xml.get(entry.file)||get(entry.file);
    if(!child(root,'公文体'))throw Error('公文结构缺少公文体，不能自动改写。');
    if(!namespaces.has(root.namespaceURI)||name(root)!=='电子公文')throw Error('此公文标引的根节点或命名空间无效，不能自动改写。');
    if(patch.remove){const node=nodeByKey(root,patch.remove,entry.file);if(children(node).some(n=>name(n)!=='ObjectRef'))throw Error('请逐项移除叶子要素的关联。');for(const ref of children(node,'ObjectRef'))node.removeChild(ref);}
    else {
      const {path,refs,append=false,sync=true,target}=patch.mark;
      const definition=semanticFields.find(f=>f.path===path);if(!definition)throw Error('未知公文要素。');
      if(!Array.isArray(refs)||!refs.length||refs.length>10000)throw Error('请选择页面文字，最多关联 10000 个图元。');
      const checked=refs.map(ref=>resolveRef(doc,ref));if(checked.some(r=>r.kind!=='TextObject'))throw Error('手动文字标注只接受文字图元。');
      let node=target?nodeByKey(root,target,entry.file):path.split('/').reduce((p,tag)=>orderedChild(p,tag),child(root,'公文体'));
      if(!node||children(node).some(n=>name(n)!=='ObjectRef'))throw Error('只能标注公文叶子要素。');
      if(target){const names=[];for(let p=node;p&&name(p)!=='公文体';p=p.parentNode)names.unshift(name(p));if(names.join('/')!==path)throw Error('目标要素与选定类型不同。');}
      const all=append?children(node,'ObjectRef').flatMap(n=>text(n).split(',').filter(Boolean).map(objectId=>({pageId:attr(n,'PageRef'),objectId}))):[];
      all.push(...checked);
      const unique=[...new Map(all.map(r=>[`${r.pageId}/${r.objectId}`,r])).values()].map(r=>resolveRef(doc,r));
      while(node.firstChild)node.removeChild(node.firstChild);
      // Keep each page run in authored order; one element may span pages.
      let ref,lastPage;
      for(const item of unique){if(lastPage!==item.pageId){ref=element(node,'ObjectRef');ref.setAttribute('PageRef',item.pageId);node.appendChild(ref);lastPage=item.pageId;}ref.textContent+=(ref.textContent?',':'')+item.objectId;}
      if(sync&&definition.key) {
        const paths=semanticFields.filter(f=>f.key===definition.key).map(f=>f.path.split('/')),parts=[];
        function collect(parent,path){if(!path.length){const refs=children(parent,'ObjectRef');const value=refs.length?refs.flatMap(n=>text(n).split(',').filter(Boolean).map(objectId=>resolveRef(doc,{pageId:attr(n,'PageRef'),objectId}).text)).join('').trim():text(parent);if(value)parts.push(value);return;}for(const n of children(parent,path[0]))collect(n,path.slice(1));}
        for(const path of paths)collect(child(root,'公文体'),path);
        values[definition.key]=[...new Set(parts)].join(['QFR','ZSJG','CSJG','FJSM'].includes(definition.key)?'^':'');
      }
      if(sync&&!definition.key){
        const parent=node.parentNode,read=tag=>children(child(parent,tag),'ObjectRef').flatMap(n=>text(n).split(',').filter(Boolean).map(objectId=>resolveRef(doc,{pageId:attr(n,'PageRef'),objectId}).text)).join('').trim();
        if(name(parent)==='密级和保密期限'){const level=read('密级'),duration=read('保密期限');if(level)values.MJHBMQX=level+(duration?'★'+duration:'');}
        if(name(parent)==='发文机关标志'){const agency=read('发文机关名称'),logo=read('标志');values.FWJGBZ=agency+(logo?'^^'+logo:'');}
        if(name(parent)==='发文字号'){const agency=read('发文机关代字'),year=read('年份'),serial=read('发文顺序号');if(agency&&year&&serial)values.FWZH=`${agency}〔${year}〕${serial}号`;}
      }
    }
  }
  if(Object.keys(values).length) {
    for(const [key,value] of Object.entries(values))if(!officialFields.some(f=>f.key===key)||typeof value!=='string'||value.length>10000)throw Error('公文元数据字段或长度无效。');
    updateDocInfo(doc,get('OFD.xml'),{customValues:values});
  }
  if(doc.version&&xml.size) {
    const root=get(doc.version.file),list=child(root,'FileList');
    for(const file of xml.keys())if(!doc.version.files.includes(file)&&file!==doc.version.file){const n=element(list,'File');n.setAttribute('ID',`file_${crypto.randomUUID().replaceAll('-','')}`);n.textContent=`/${file}`;list.appendChild(n);}
  }
  const protectedSet=protectedFiles(doc), sharedDocuments=new Set();
  for(const other of doc.documents) {
    if(other.index===doc.selection.documentIndex)continue;
    sharedDocuments.add(other.docRoot);
    const otherRoot=doc.archive.xml(other.docRoot),location=text(otherRoot,'CustomTags');
    if(location){const index=resolve(other.docRoot,location);sharedDocuments.add(index);
      for(const ref of children(doc.archive.xml(index),'CustomTag'))if(text(ref,'FileLoc'))sharedDocuments.add(resolve(index,text(ref,'FileLoc')));
    }
  }
  for(const [file,root] of xml) {
    const bytes=strToU8(new XMLSerializer().serializeToString(root));
    if(doc.archive.has(file)&&new TextDecoder().decode(bytes)===new TextDecoder().decode(doc.archive.read(file)))continue;
    if(protectedSet.has(file))throw Error(`文件 ${file} 受数字签名保护，不能修改公文信息。`);
    if(sharedVersionFile(doc,file))throw Error(`文件 ${file} 被其他版本共用，不能修改。`);
    if(sharedDocuments.has(file))throw Error(`文件 ${file} 被其他包内文档共用，不能修改。`);
    changed.set(file,bytes);
  }
  const files=Object.fromEntries(doc.archive.materialize());for(const [file,bytes] of changed)files[file]=bytes;
  return zipSync(files);
}
