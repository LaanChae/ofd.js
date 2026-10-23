import {OfficialTreeViewer} from './official-tree.js';
import {nativeDialog,line} from './dialogs.js';
import {officialFields,semanticFields,validateOfficialMetadata} from '../shared/official-fields.js';

export async function mountOfficial(app,save,status) {
  const $=id=>document.getElementById(id), panel=$('officialView');
  let owner=null,data=null,request=0,selection=null,highlights=[];
  function button(parent,label,id,action) {const n=line(parent,label,'button');n.type='button';if(id)n.id=id;n.onclick=action;return n;}
  function field(parent,label,id,tag='input') {const l=line(parent,label,'label');l.htmlFor=id;const n=document.createElement(tag);n.id=id;n.className='toolbarField';parent.append(n);return n;}
  async function dialog(id,title) {const n=document.createElement('dialog');n.id=id;line(n,title,'h2');n.setAttribute('aria-label',title);document.body.append(n);await app.overlayManager.register(n);return n;}
  const metadataDialog=await dialog('ofdOfficialDialog','公文元数据与校验');
  line(metadataDialog,'按 GB/T 33480 填写。修改元数据不会改变页面文字；未知自定义字段会原样保留。','p','ofdMuted');
  const form=line(metadataDialog,'','div','ofdOfficialFields'),inputs=new Map();
  for(const f of officialFields) {const input=field(form,`${f.label}（${f.key}）${f.required?' *':''}`,`ofdOfficial_${f.key}`);input.maxLength=10000;inputs.set(f.key,input);}
  for(const key of ['QFR','ZSJG','CSJG','FJSM'])inputs.get(key).title='多个值使用 ^ 分隔。';
  inputs.get('FWJGBZ').title='多个机关使用 ^ 分隔，标志前使用 ^^，例如某机关^^文件。';
  inputs.get('GWBS').placeholder='1.2.156.10.…';inputs.get('CWRQ').placeholder='2026年10月23日';inputs.get('FWZH').placeholder='某发〔2026〕1号';
  const other=line(metadataDialog,'','p','ofdMuted'),issues=line(metadataDialog,'','ul','ofdOfficialIssues');issues.setAttribute('aria-live','polite');
  const feedback=line(metadataDialog,'','p','ofdMuted');feedback.setAttribute('role','status');
  const actions=line(metadataDialog,'','div','buttonRow');
  button(actions,'关闭','ofdOfficialClose',()=>app.overlayManager.close(metadataDialog));
  button(actions,'校验','ofdOfficialValidate',()=>validateForm());
  const metadataSave=button(actions,'保存到 OFD','ofdOfficialSave',async()=>{
    const currentOwner=owner;validateForm();metadataSave.disabled=true;
    try {await app.overlayManager.close(metadataDialog);await save({values:formValues()});await refresh();await showMetadata();}
    catch(error){status(error.message,true);if(app.pdfDocument===currentOwner){feedback.textContent=error.message;await app.overlayManager.open(metadataDialog);}}
    finally{metadataSave.disabled=false;}
  });
  nativeDialog(metadataDialog,[metadataSave.id]);
  function formValues(){return Object.fromEntries([...inputs].map(([key,input])=>[key,input.value]));}
  function showIssues(list,items) {
    list.replaceChildren();
    if(!items.length)line(list,'所检查的元数据及标引规则未发现问题；此结果不代表完整公文格式认证。','li');
    for(const issue of items){const li=line(list,`${issue.severity==='error'?'错误':'提示'} · ${issue.field}：${issue.message}`,'li',issue.severity==='error'?'ofdError':'');if(inputs.has(issue.field)){li.tabIndex=0;li.onclick=()=>inputs.get(issue.field).focus();}}
  }
  function validateForm(){const entries=Object.entries(formValues()).map(([name,value])=>({name,value})),result=[...validateOfficialMetadata(entries),...(data?.issues||[]).filter(i=>!officialFields.some(f=>f.key===i.field))];showIssues(issues,result);metadataSave.textContent=result.some(i=>i.severity==='error')?'保存草稿到 OFD':'保存到 OFD';feedback.textContent=result.some(i=>i.severity==='error')?'仍有缺项或格式错误，保存后保留为待完善的草稿。':'元数据校验完成。';return result;}
  async function refresh(){const doc=app.pdfDocument;if(!doc?.isOFD)return null;const serial=++request;const result=await doc.engine.call('official');if(app.pdfDocument!==doc||serial!==request)return null;owner=doc;data=result;renderTree();return result;}
  async function showMetadata(){if(!await refresh())return;const values=new Map(data.metadata.map(n=>[n.name,n.value]));for(const [key,input] of inputs){input.value=values.get(key)||'';input.disabled=!!data.metadataBlocked;}
    const unknown=data.metadata.filter(n=>!inputs.has(n.name));other.textContent=unknown.length?`另有 ${unknown.length} 项其他自定义元数据，保存时保留。`:'';
    validateForm();showIssues(issues,data.issues);feedback.textContent=data.metadataBlocked||'可先保存未完成的草稿，再继续标注和完善。';metadataSave.disabled=!!data.metadataBlocked;await app.overlayManager.open(metadataDialog);
  }
  async function showStructure(){if(!await refresh())return;app.viewsManager.switchView(5,true);}
  const tree = new OfficialTreeViewer(app,panel,node=>navigate(node).catch(report),(event,node)=>showNodeMenu(event,node));
  function renderTree(){tree.render(data.trees);if(!data.trees.length)line(panel,'尚无公文结构。选择页面文字后，可右键标记为公文要素。','p','ofdOfficialEmpty');}
  async function navigate(node){
    const valid=node.refs.filter(r=>!r.error);
    if(!valid.length){const next=node.children.find(n=>n.refs.some(r=>!r.error)||n.children.length);if(next)return navigate(next);status('该要素尚未关联页面对象；右键可查看详情。');return;}
    const refsByPage=new Map();for(const ref of valid){if(!refsByPage.has(ref.pageIndex))refsByPage.set(ref.pageIndex,new Set());refsByPage.get(ref.pageIndex).add(ref.objectId);}
    const doc=app.pdfDocument, marks=[];
    for(const [index,ids] of refsByPage){const objects=await doc.engine.call('officialObjects',{index});if(doc!==app.pdfDocument)return;for(const object of objects)if(ids.has(object.objectId))marks.push(...object.rects.map(rect=>({index,rect})));}
    highlights=marks;app.pdfViewer.scrollPageIntoView({pageNumber:valid[0].pageIndex+1});paintHighlights();
  }
  const detailDialog=await dialog('ofdOfficialDetailDialog','公文要素');
  const detailName=line(detailDialog,'','p'),detailText=field(detailDialog,'关联文字','ofdOfficialDetailText','textarea');detailText.readOnly=true;detailText.rows=5;
  const detailPages=line(detailDialog,'','div','buttonRow');
  const detailActions=line(detailDialog,'','div','buttonRow');button(detailActions,'关闭','ofdOfficialDetailClose',()=>app.overlayManager.close(detailDialog));nativeDialog(detailDialog);
  async function showDetail(node){detailName.textContent=node.path;detailText.value=node.text;detailPages.replaceChildren();
    for(const index of [...new Set(node.refs.filter(r=>!r.error).map(r=>r.pageIndex))]){const b=button(detailPages,`第 ${index+1} 页`,'',async()=>{await app.overlayManager.close(detailDialog);await navigate(node);app.page=index+1;paintHighlights();});b.className='secondaryButton';}
    await app.overlayManager.open(detailDialog);
  }
  const nodeMenu=document.createElement('menu');nodeMenu.id='ofdOfficialNodeMenu';nodeMenu.className='popupMenu';nodeMenu.hidden=true;nodeMenu.setAttribute('role','menu');document.body.append(nodeMenu);
  function showNodeMenu(event,node){nodeMenu.replaceChildren();
    const action=(label,fn)=>{const b=button(nodeMenu,'','',()=>{nodeMenu.hidden=true;Promise.resolve().then(fn).catch(report);});b.className='noIcon';b.setAttribute('role','menuitem');line(b,label,'span');};
    action('查看要素详情',()=>showDetail(node));action('公文元数据与校验',showMetadata);
    const path=node.path.replace(/^电子公文\/公文体\//,'');
    if(!data.editBlocked&&!node.children.length&&semanticFields.some(f=>f.path===path)){
      action('用所选文字替换关联',()=>showMark(node));
      if(node.refs.length)action('移除此要素关联',async()=>{await save({remove:node.key});await showStructure();});
    }
    nodeMenu.hidden=false;nodeMenu.style.left=`${Math.min(event.clientX,innerWidth-220)}px`;nodeMenu.style.top=`${Math.min(event.clientY,innerHeight-150)}px`;nodeMenu.firstElementChild.focus();
  }
  function paintHighlights(){document.querySelectorAll('.ofdOfficialHighlight').forEach(n=>n.remove());for(const {index,rect} of highlights){const view=app.pdfViewer.getPageView(index);if(!view?.div||!view.viewport)continue;const r=[...view.viewport.convertToViewportPoint(rect[0],rect[1]),...view.viewport.convertToViewportPoint(rect[2],rect[3])],n=document.createElement('div');n.className='ofdOfficialHighlight';Object.assign(n.style,{left:`${Math.min(r[0],r[2])}px`,top:`${Math.min(r[1],r[3])}px`,width:`${Math.abs(r[2]-r[0])}px`,height:`${Math.abs(r[3]-r[1])}px`});view.div.append(n);}}
  function captureSelection(){const doc=app.pdfDocument,s=window.getSelection();if(!doc?.isOFD||!s||s.isCollapsed||!s.rangeCount)return;
    const range=s.getRangeAt(0),pages=[];let selectedText='';
    for(const page of document.querySelectorAll('#viewer .page')){
      const layer=page.querySelector('.textLayer');if(!layer||!range.intersectsNode(layer))continue;
      const index=Number(page.dataset.pageNumber)-1,view=app.pdfViewer.getPageView(index),base=page.getBoundingClientRect(),rects=[];
      const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        if(!range.intersectsNode(node)||!node.textContent||node.parentElement.closest('.endOfContent'))continue;
        const part=document.createRange();part.selectNodeContents(node);
        if(range.startContainer===node)part.setStart(node,range.startOffset);
        if(range.endContainer===node)part.setEnd(node,range.endOffset);
        if(part.collapsed)continue;selectedText+=part.toString();
        for(const r of part.getClientRects()){
          if(!r.width||!r.height)continue;
          const sx=view.viewport.width/page.clientWidth,sy=view.viewport.height/page.clientHeight;
          const points=[[r.left,r.top],[r.right,r.top],[r.left,r.bottom],[r.right,r.bottom]].map(([x,y])=>view.viewport.convertToPdfPoint((x-base.left-page.clientLeft)*sx,(y-base.top-page.clientTop)*sy));
          rects.push([Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]);
          if(rects.length>10000)throw Error('选区过大，请分批追加标注。');
        }
      }
      if(rects.length)pages.push({index,rects});
    }
    if(pages.length)selection={owner:doc,pages,text:selectedText};
  }
  const markDialog=await dialog('ofdOfficialMarkDialog','标记公文要素');
  const select=field(markDialog,'公文要素','ofdOfficialElement','select');
  for(const f of semanticFields){const option=document.createElement('option');option.value=f.path;option.textContent=f.label;select.append(option);}select.value='主体/标题';
  const selectionInfo=line(markDialog,'','p','ofdMuted'),preview=field(markDialog,'实际关联的完整文字图元','ofdOfficialText','textarea');preview.readOnly=true;preview.rows=6;
  const syncLabel=line(markDialog,'','label'),sync=document.createElement('input');sync.type='checkbox';sync.id='ofdOfficialSync';sync.checked=true;syncLabel.append(sync,document.createTextNode(' 同步对应的公文元数据（如标题 BT、成文日期 CWRQ）'));
  const appendLabel=line(markDialog,'','label'),append=document.createElement('input');append.type='checkbox';append.id='ofdOfficialAppend';appendLabel.append(append,document.createTextNode(' 追加到该要素现有关联（用于跨页正文或分次选择）'));
  line(markDialog,'标引关联完整图元。只选中图元中的部分字时，会关联这里展示的完整文字；不会修改页面外观。同步会更新相应元数据，请核对已有值。','p','ofdMuted');
  const markFeedback=line(markDialog,'','p','ofdMuted');markFeedback.setAttribute('role','status');
  const markActions=line(markDialog,'','div','buttonRow');button(markActions,'取消','ofdOfficialMarkCancel',()=>app.overlayManager.close(markDialog));
  let pending=null;
  const markSave=button(markActions,'标注并保存到 OFD','ofdOfficialMarkSave',async()=>{
    if(!pending||pending.owner!==app.pdfDocument)return;markSave.disabled=true;
    try{const patch={mark:{path:select.value,refs:pending.refs,target:pending.target,append:append.checked,sync:sync.checked}};await app.overlayManager.close(markDialog);await save(patch);await showStructure();}
    catch(error){report(error);if(pending?.owner===app.pdfDocument){markFeedback.textContent=error.message;await app.overlayManager.open(markDialog);}}
    finally{markSave.disabled=false;}
  });nativeDialog(markDialog,[markSave.id]);
  async function showMark(target=null){captureSelection();const selected=selection,doc=app.pdfDocument;if(!selected||selected.owner!==doc)throw Error('请先在 OFD 页面中选择文字，再执行标注。');
    const refs=[];for(const page of selected.pages){const objects=await doc.engine.call('officialObjects',{index:page.index});if(doc!==app.pdfDocument)return;
      for(const object of objects)if(object.rects.some(b=>page.rects.some(r=>{const x=(b[0]+b[2])/2,y=(b[1]+b[3])/2;return x>=r[0]-.25&&x<=r[2]+.25&&y>=r[1]-.25&&y<=r[3]+.25;})))refs.push(object);
    }
    if(!refs.length)throw Error('选区中没有可关联的页面文字图元。图像、印章和注释文字不能按此方式标注。');
    if(!await refresh()||doc!==app.pdfDocument)return;if(data.editBlocked)throw Error(data.editBlocked);
    pending={owner:doc,refs:refs.map(({pageId,objectId})=>({pageId,objectId})),target:target?.key};
    select.disabled=!!target;if(target)select.value=target.path.replace(/^电子公文\/公文体\//,'');
    if(!select.value)throw Error('该扩展要素不在手动标注的公文要素列表中。');
    selectionInfo.textContent=`所选文字：${selected.text.slice(0,240)}；关联 ${refs.length} 个文字图元、${selected.pages.length} 页。`;
    preview.value=refs.map(r=>r.text).join('');append.checked=false;markFeedback.textContent='';markSave.disabled=false;await app.overlayManager.open(markDialog);
  }
  function report(error){status(error.message||String(error),true);}
  $('ofdOfficialMetadata').onclick=()=>showMetadata().catch(report);
  $('ofdOfficialStructure').onclick=()=>showStructure().catch(report);
  $('ofdOfficialMark').onclick=()=>showMark().catch(report);
  const context=document.createElement('div');context.id='ofdOfficialContext';context.className='popupMenu';context.hidden=true;
  const contextButton=button(context,'','ofdOfficialContextMark',()=>{context.hidden=true;showMark().catch(report);});line(contextButton,'标记为公文要素…','span');contextButton.className='noIcon';contextButton.setAttribute('role','menuitem');context.setAttribute('role','menu');document.body.append(context);
  context.addEventListener('pointerdown',e=>e.preventDefault());
  $('viewerContainer').addEventListener('pointerup',()=>{try{captureSelection();}catch(error){report(error);}});
  $('viewerContainer').addEventListener('keyup',()=>{try{captureSelection();}catch(error){report(error);}});
  $('viewerContainer').addEventListener('contextmenu',e=>{if(!app.pdfDocument?.isOFD||!e.target.closest('.textLayer')||window.getSelection()?.isCollapsed)return;try{captureSelection();if(selection?.owner!==app.pdfDocument)return;e.preventDefault();context.hidden=false;context.style.left=`${Math.min(e.clientX,innerWidth-220)}px`;context.style.top=`${Math.min(e.clientY,innerHeight-60)}px`;contextButton.focus();}catch(error){report(error);}});
  document.addEventListener('pointerdown',e=>{if(!context.contains(e.target))context.hidden=true;if(!nodeMenu.contains(e.target))nodeMenu.hidden=true;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){context.hidden=true;nodeMenu.hidden=true;}});
  for(const menu of [context,nodeMenu])menu.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();});
  app.eventBus.on('ofdofficialview',()=>refresh().catch(report));
  app.eventBus.on('pagerendered',paintHighlights);
  app.eventBus.on('pagesdestroy',()=>{++request;owner=null;data=null;selection=null;pending=null;highlights=[];context.hidden=true;nodeMenu.hidden=true;tree.reset();app.overlayManager.closeIfActive(detailDialog);app.overlayManager.closeIfActive(metadataDialog);app.overlayManager.closeIfActive(markDialog);});
}
