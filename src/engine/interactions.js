import { protectedFiles, sharedVersionFile } from "./annotation-edit.js";
import * as m from "mupdf";
import { attr, bool, child, children, name, numbers, text, resolve } from "./archive.js";
import { MM, multiply, translate, transformPoint, ofdPath } from "./geometry.js";
import { actionReader, pdfAction } from "./navigation.js";

const rect = (box, matrix) => {
  const [x, y, w, h] = box, points = [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([x,y]) => transformPoint(matrix,x,y));
  return [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])), Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))];
};
const intersect = (a,b) => [Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
function appearanceBounds(appearance, matrix) {
  if (appearance.hasAttribute("Boundary")) return rect(numbers(attr(appearance,"Boundary"),4),matrix);
  // An unbounded Appearance is a page block, not a page-sized clickable
  // annotation. Derive its hit rectangle from the visible child objects.
  let bounds=null;
  function visit(node,depth=0) {
    if(depth>64)throw Error("注释容器嵌套过深。");
    if(!bool(node,"Visible",true))return;
    if(["TextObject","PathObject","ImageObject","CompositeObject"].includes(name(node))) {
      const box=rect(numbers(attr(node,"Boundary"),4),matrix);
      bounds=bounds?[Math.min(bounds[0],box[0]),Math.min(bounds[1],box[1]),Math.max(bounds[2],box[2]),Math.max(bounds[3],box[3])]:box;
    } else if(["Appearance","PageBlock"].includes(name(node))) {
      for(const entry of children(node))visit(entry,depth+1);
    }
  }
  visit(appearance);
  return bounds||[0,0,0,0];
}
function regionQuads(region, matrix, bounds) {
  // PDF link hit regions are quadrilaterals. Sample curved OFD areas into shared
  // horizontal strips (at most 0.5 pt for ordinary pages), used by both viewers.
  const step = Math.max(.5, Math.sqrt((bounds[2]-bounds[0])*(bounds[3]-bounds[1])/1000000));
  const w = Math.ceil((bounds[2]-bounds[0])/step), h = Math.ceil((bounds[3]-bounds[1])/step);
  if (w <= 0 || h <= 0) return [];
  const pix = new m.Pixmap(m.ColorSpace.DeviceGray,[0,0,w,h],false),
    device = new m.DrawDevice([1/step,0,0,1/step,-bounds[0]/step,-bounds[1]/step],pix);
  pix.clear(0);
  try {
    for (const area of children(region,"Area")) {
      const start = numbers(attr(area,"Start"),2);
      let current=start, subpathStart=start, data = `M ${start.join(" ")} `;
      for (const n of children(area)) {
        const p = k => numbers(attr(n,k),2);
        switch(name(n)) {
          case "Move": current=p("Point1");subpathStart=current; data += `M ${current.join(" ")} `; break;
          case "Line": current=p("Point1"); data += `L ${current.join(" ")} `; break;
          case "QuadraticBezier": {
            const control=p("Point1");current=p("Point2");
            data += `Q ${control.join(" ")} ${current.join(" ")} `;break;
          }
          case "CubicBezier": {
            const end=p("Point3"), first=n.hasAttribute("Point1")?p("Point1"):current,
              second=n.hasAttribute("Point2")?p("Point2"):end;
            data += `B ${first.join(" ")} ${second.join(" ")} ${end.join(" ")} `;
            current=end;break;
          }
          case "Arc":
            current=p("EndPoint");
            // §9.3.5 explicitly defines an empty EllipseSize as a line.
            data += attr(n,"EllipseSize").trim()
              ? `A ${p("EllipseSize").join(" ")} ${attr(n,"RotationAngle")} ${bool(n,"LargeArc",false)?1:0} ${bool(n,"SweepDirection",false)?1:0} ${current.join(" ")} `
              : `L ${current.join(" ")} `;
            break;
          case "Close": data += "C ";current=subpathStart;break;
          default: throw Error("未知动作区域路径。");
        }
      }
      const path = ofdPath(data + "C");
      try { device.fillPath(path,false,matrix,m.ColorSpace.DeviceGray,[1],1); }
      finally { path.destroy(); }
    }
    device.close();
    const pixels = pix.getPixels(), quads = [], active = new Map();
    for(let y=0;y<h;y++) {
      const next = new Map();
      for(let x=0;x<w;x++) {
        if(pixels[y*w+x]<128) continue;
        const start=x; while(x+1<w && pixels[y*w+x+1]>=128)x++;
        const key=`${start}:${x}`, prior=active.get(key);
        if(prior!==undefined) { quads[prior+1]=quads[prior+3]=Math.min(bounds[3],bounds[1]+(y+1)*step); next.set(key,prior); }
        else {
          const left=bounds[0]+start*step,right=Math.min(bounds[2],bounds[0]+(x+1)*step),bottom=bounds[1]+y*step,top=Math.min(bounds[3],bottom+step);
          next.set(key,quads.length);quads.push(left,top,right,top,left,bottom,right,bottom);
        }
      }
      active.clear();for(const [key,value] of next)active.set(key,value);
    }
    return quads;
  } finally {device.destroy();pix.destroy();}
}
const date = value => value ? `D:${value.replace(/[^0-9]/g,"").padEnd(14,"0")}Z` : null;
const base = (id, pageIndex, bounds) => ({ id, pageIndex, rect:bounds, rotation:0, borderStyle:{width:0,style:1},color:null,hasAppearance:true });
const models = new WeakMap();
export function readPageInteractions(doc, pageIndex, defer = false) {
  let cache = models.get(doc);
  if (!cache) models.set(doc, cache = [new Map(), new Map()]);
  const pages = cache[Number(defer)];
  if (pages.has(pageIndex)) return pages.get(pageIndex);
  const page = doc.page(pageIndex), { action } = actionReader(doc, defer);
  let protectedPaths, protectionError;
  try { protectedPaths = protectedFiles(doc); } catch(error) { protectionError = error.message; }
    const templates = page.templateIds.map(id => doc.templates.get(id)).filter(t => t?.hasActions);
    const source = doc.annotations.get(page.id);
    if (!page.hasActions && !templates.length && !source) {
      const result = { annotations: [], openAction: [] };
      pages.set(pageIndex, result);
      return result;
    }
    const root = page.hasActions ? page.root : null;
    const [x,y,w,h]=page.box, matrix=[MM,0,0,-MM,-x*MM,(y+h)*MM], clip=rect(page.applicationBox,matrix), annotations=[];
    let serial=0;
    const addActions=(node,parent,bounds)=>{
      // Actions with different regions remain separate clickable areas. Actions
      // sharing a region form a sequence, in XML order.
      const groups = new Map();
      for(const entry of children(child(node,"Actions"),"Action").filter(a=>attr(a,"Event")==="CLICK")) {
        const container=node.ownerDocument.createElement("Actions");container.appendChild(entry.cloneNode(true));
        const wrapper=node.ownerDocument.createElement("Object");wrapper.appendChild(container);
        const actions=action(wrapper,"CLICK").actions;
        if(!actions?.length)continue;
        const region=child(entry,"Region"), key=region?.toString()||"";
        if(!groups.has(key))groups.set(key,{region,actions:[]});groups.get(key).actions.push(...actions);
      }
      for(const {region,actions} of groups.values()) {
        const box=intersect(bounds,clip); if(box[2]<=box[0]||box[3]<=box[1])continue;
        let quadPoints=null;
        try { if(region)quadPoints=regionQuads(region,parent,box); }
        catch(error) {
          doc.warnings.add(`第 ${pageIndex+1} 页图元 ${attr(node,"ID")||name(node)} 的动作区域无效，已停用该区域：${error.message}`);
          continue;
        }
        if(quadPoints && !quadPoints.length)continue;
        annotations.push({...base(`ofd-action-${pageIndex}-${++serial}`,pageIndex,box),annotationType:2,actions,
          ...(quadPoints?{quadPoints:new Float32Array(quadPoints)}:{}),...actions[0],
          ...(actions[0].attachment?{attachmentId:actions[0].attachment.id}:{})});
      }
    };
    function walk(node,parent,depth=0,parentClip=clip) {
      if(depth>64)throw Error("动作容器嵌套过深。");
      if(!bool(node,"Visible",true))return;
      const boundary=attr(node,"Boundary"), box=boundary?numbers(boundary,4):null;
      const bounds=box?intersect(rect(box,parent),parentClip):parentClip;
      if(bounds[2]<=bounds[0]||bounds[3]<=bounds[1])return;
      const local=box?multiply(parent,multiply(translate(box[0],box[1]),numbers(attr(node,"CTM","1 0 0 1 0 0"),6))):parent;
      addActions(node,local,bounds);
      if(name(node)==="CompositeObject") {
        const resource=doc.resources.composites.get(attr(node,"ResourceID"));
        if(!resource)throw Error("复合图元引用了不存在的资源。");
        const size=numbers(`${attr(resource.node,"Width")} ${attr(resource.node,"Height")}`,2);
        const content=child(resource.node,"Content");
        if(content)walk(content,local,depth+1,intersect(bounds,rect([0,0,...size],local)));
      }
      for(const entry of children(node)) if(["Content","Layer","PageBlock","PathObject","TextObject","ImageObject","CompositeObject"].includes(name(entry))) walk(entry,local,depth+1,bounds);
    }
    for (const template of templates) walk(doc.archive.xml(template.file), matrix);
    if (root) walk(root, matrix);
    for(const annot of children(source?.root,"Annot")) {
      if(!bool(annot,"Visible",true))continue;
      const appearance=child(annot,"Appearance");if(!appearance)continue;
      const bounds=appearanceBounds(appearance,matrix), id=`ofd-annot-${pageIndex}-${attr(annot,"ID")}`;
      const remark=text(annot,"Remark");
      annotations.push({...base(id,pageIndex,bounds),annotationType:13,ofdId:attr(annot,"ID"),ofdType:attr(annot,"Type"),
        contentsObj:{str:remark,dir:"ltr"},titleObj:{str:attr(annot,"Creator"),dir:"ltr"},modificationDate:date(attr(annot,"LastModDate")),
        readOnly:bool(annot,"ReadOnly",true),
        editBlocked: protectionError || (protectedPaths.has(source.file) ? "该注释文件受数字签名保护。" : sharedVersionFile(doc,source.file) ? "该注释文件被其他版本共用，不能原地修改历史内容。" : ""),noRotate:bool(annot,"NoRotate",false),noZoom:bool(annot,"NoZoom",false),print:bool(annot,"Print",true),
        hasPopup:!!remark,popupRef:remark?`${id}-popup`:null,isEditable:false});
      if(remark) annotations.push({...base(`${id}-popup`,pageIndex,bounds),annotationType:16,parentId:id,parentType:"Stamp",parentRect:bounds,
        contentsObj:{str:remark,dir:"ltr"},titleObj:{str:attr(annot,"Creator"),dir:"ltr"},modificationDate:date(attr(annot,"LastModDate")),open:false});
      walk(appearance,matrix);
    }
    const result = {annotations, openAction: root ? action(root,"PO").actions||[] : []};
    pages.set(pageIndex, result);
    return result;
}
export function readInteractions(doc) {
  return { pages: doc.pages.map((_, index) => readPageInteractions(doc, index)) };
}

export function writePdfInteractions(pdf,model,attachmentTargets) {
  const owned=[], keep=o=>(owned.push(o),o), string=s=>keep(pdf.newString(s));
  try {
    model.pages.forEach((entry,index)=>{
      const page=keep(pdf.findPage(index)), refs=new Map();
      const annots=entry.annotations.map(a=>{
        const ref=keep(pdf.addObject({Type:"Annot",Subtype:a.annotationType===2?"Link":a.annotationType===16?"Popup":"Stamp",Rect:a.rect,P:page,NM:string(a.id)}));
        refs.set(a.id,ref);return ref;
      });
      entry.annotations.forEach((a,i)=>{
        const ref=annots[i];
        if(a.annotationType===2) {
          ref.put("Border",[0,0,0]);ref.put("A",pdfAction(pdf,a.actions,keep,attachmentTargets));
          if(a.quadPoints)ref.put("QuadPoints",Array.from(a.quadPoints));
        } else if(a.annotationType===16) {ref.put("Parent",refs.get(a.parentId));ref.put("Open",false);}
        else {
          ref.put("Contents",string(a.contentsObj.str));ref.put("T",string(a.titleObj.str));
          if(a.modificationDate)ref.put("M",string(a.modificationDate));
          ref.put("F",(a.print?4:0)|(a.noZoom?8:0)|(a.noRotate?16:0)|(a.readOnly?64:0));
          if(a.popupRef)ref.put("Popup",refs.get(a.popupRef));
          // Appearance is already rendered in page content. An empty AP avoids
          // an arbitrary PDF viewer stamp icon replacing the OFD appearance.
          ref.put("AP",{N:keep(pdf.addStream("",{Type:"XObject",Subtype:"Form",BBox:[0,0,a.rect[2]-a.rect[0],a.rect[3]-a.rect[1]],Resources:{}}))});
        }
      });
      if(annots.length) {
        const existing=keep(page.get("Annots"));
        if(existing.isArray())annots.forEach(ref=>existing.push(ref));else page.put("Annots",annots);
      }
      if(entry.openAction.length)page.put("AA",{O:pdfAction(pdf,entry.openAction,keep,attachmentTargets)});
    });
  } finally {owned.reverse().forEach(o=>o.destroy());}
}
