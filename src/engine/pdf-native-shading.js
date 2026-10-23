import * as m from 'mupdf';
import {colorFunction,functionStops} from './pdf-functions.js';
import {meshShading} from './pdf-mesh.js';
import {functionShading} from './pdf-function-shading.js';
import {multiply} from './geometry.js';
import {fmt} from './ofd-write-utils.js';
function pdfValue(obj,depth=0){
 if(depth>32)throw new Error('PDF 渐变资源存在循环或过深嵌套。');
 if(obj.isIndirect()){
  const resolved=obj.resolve();
  try{
   const result=pdfValue(resolved,depth+1);
   if(result?.FunctionType===0){const data=obj.readStream();try{result.samples=data.asUint8Array().slice();}finally{data.destroy();}}
   return result;
  }finally{resolved.destroy();}
 }
 if(obj.isDictionary()||obj.isArray()){
  const result=obj.isArray()?[]:{};
  obj.forEach((v,k)=>{try{result[k]=pdfValue(v,depth+1);}finally{v.destroy();}});return result;
 }
 return obj.asJS();
}
const value=(obj,key,fallback)=>{const v=obj.get(key);try{return v.isNull()?fallback:pdfValue(v);}finally{v.destroy();}};

// Resolve a PDF shading to its native MuPDF handle using a temporary probe
// page in the same document. Held handles keep the mapping stable; no
// heap-layout assumptions and no matching by color or approximate geometry.
export class PdfNativeShading {
 constructor(doc,pkg){this.doc=doc;this.pkg=pkg;this.handles=[];this.objects=[];this.spaces=[];this.plans=new Map();this.entries=new Map();
  try{
   const seen=new Set();
   const visit=(obj,depth=0,reference=null)=>{
    if(!obj.isDictionary()||seen.has(obj.pointer))return;
    if(depth>128)throw new Error('PDF 资源嵌套过深。');
    seen.add(obj.pointer);
    const mask=obj.get('SMask');
    try{if(mask.isDictionary()){const transfer=mask.get('TR');try{if(!transfer.isNull()&&transfer.asName()!=='Identity')this.maskTransfer=true;}finally{transfer.destroy();}}}
    finally{mask.destroy();}
    const kind=value(obj,'ShadingType',0)||value(obj,'PatternType',0)===2;
    if(kind){this.objects.push(reference?doc.newIndirect(reference.asIndirect()):obj.resolve());return;}
    obj.forEach(v=>{let resolved;try{if(v.isDictionary()){resolved=v.resolve();visit(resolved,depth+1,v.isIndirect()?v:null);}}finally{resolved?.destroy();v.destroy();}});
   };
   for(let i=0;i<doc.countPages();i++){
    const page=doc.findPage(i),resources=page.getInheritable('Resources'),annots=page.get('Annots');
    try{
     if(resources.isDictionary()){const resolved=resources.resolve();try{visit(resolved,0,resources.isIndirect()?resources:null);}finally{resolved.destroy();}}
     if(annots.isArray())annots.forEach(annotation=>{const ap=annotation.get('AP');let resolved;try{if(ap.isDictionary()){resolved=ap.resolve();visit(resolved,0,ap.isIndirect()?ap:null);}}finally{resolved?.destroy();ap.destroy();annotation.destroy();}});
    }finally{annots.destroy();resources.destroy();page.destroy();}
   }
   if(!this.objects.length)return;
   const resources={Shading:{},Pattern:{}},content=[];
   this.objects.forEach((o,i)=>{if(value(o,'PatternType')===2){resources.Pattern['S'+i]=o;content.push(`q /Pattern cs /S${i} scn 0 0 1 1 re f Q`);}else{resources.Shading['S'+i]=o;content.push(`/S${i} sh`);}});
   const pageRef=doc.addPage([0,0,1,1],0,resources,content.join('\n'));
   const index=doc.countPages();doc.insertPage(-1,pageRef);pageRef.destroy();
   let page,device,i=0;
   try{
    page=doc.loadPage(index);device=new m.Device({fillShade:(shade)=>{this.handles.push(shade);this.entries.set(shade.pointer,this.objects[i++]);}});
    page.run(device,m.Matrix.identity);device.close();
    if(i!==this.objects.length)throw new Error('PDF 渐变资源与绘制句柄不一致。');
   }finally{device?.destroy();page?.destroy();doc.deletePage(index);}
  }catch(e){this.destroy();throw e;}
 }
 destroy(){for(const x of this.handles)x.destroy();for(const x of this.objects)x.destroy();for(const x of this.spaces)x.destroy();this.handles=[];this.objects=[];this.spaces=[];}
 plan(shade){
  if(this.plans.has(shade.pointer))return this.plans.get(shade.pointer);
  let obj=this.entries.get(shade.pointer);if(!obj)throw new Error('PDF 渐变资源无法定位。');
  let matrix=m.Matrix.identity;
  if(value(obj,'PatternType')===2){matrix=value(obj,'Matrix',matrix);obj=obj.get('Shading');this.objects.push(obj);}
  const type=value(obj,'ShadingType'), cs=obj.get('ColorSpace');let space;
  try{space=this.colorSpace(cs);}finally{cs.destroy();}
  const originalGray=space.type==='GRAY';
  const fnSpec=value(obj,'Function',null);
  const requiresNative=f=>Array.isArray(f)?f.some(requiresNative):f&&(f.FunctionType===4||(f.FunctionType===0&&f.Order===3)||f.Functions?.some(requiresNative));
  let fn;const bboxMatrix=matrix;
  if(type===1){
   matrix=multiply(matrix,value(obj,'Matrix',m.Matrix.identity));
  }else if(requiresNative(fnSpec)){
   const domain=value(obj,'Domain',[0,1]),ref=obj.get('Function'),cs=obj.get('ColorSpace');
   const wrapper=this.doc.addObject({FunctionType:3,Domain:[0,1],Functions:[ref],Bounds:[],Encode:domain});
   const tint=this.doc.addObject(['Separation','OFDShading',cs,wrapper]);
   try{
    const native=this.colorSpace(tint);
    fn={breaks:domain,approximate:true,tolerance:1.1/255,at:x=>native.convert([(x-domain[0])/(domain[1]-domain[0])])};
    space={id:native.id,components:3,type:'RGB',native:m.ColorSpace.DeviceRGB};
   }finally{tint.destroy();wrapper.destroy();cs.destroy();ref.destroy();}
  }else fn=fnSpec&&colorFunction(fnSpec);
  const color=(values,converted=false)=>{
   if(space.convert&&!converted)values=space.convert(values);
   if(values.length!==space.components)throw new Error('PDF 渐变色标分量数不匹配。');
   return `<ofd:Color ColorSpace="${space.id}" Value="${values.map(x=>Math.round(Math.max(0,Math.min(1,x))*65535)).join(' ')}"/>`;
  };
  let xml,approximate=false,analytic;
  if(type===1){
   const domain=value(obj,'Domain',[0,1,0,1]);
   xml=functionShading(shade,domain,matrix,space.native,color);approximate=true;
  }else if(type===2||type===3){
   if(!fn)throw new Error('PDF 渐变缺少颜色函数。');
   const coords=value(obj,'Coords'),domain=value(obj,'Domain',[0,1]),extend=value(obj,'Extend',[false,false]);
   const stops=functionStops(space.convert?{...fn,at:x=>space.convert(fn.at(x))}:fn,domain,fn.tolerance||(space.convert?1.1/255:1/2048));approximate=fn.approximate||!!space.convert;
   for(let i=1;i<stops.length;i++)if(stops[i].position===stops[i-1].position){stops[i-1].position-=1e-8;approximate=true;}
   const radial=type===3,tag=radial?'RadialShd':'AxialShd',end=radial?3:2;
   if(coords.length!==(radial?6:4)||coords.some(x=>!Number.isFinite(x)))throw new Error('PDF 渐变坐标无效。');
   xml=`<ofd:${tag} StartPoint="${coords.slice(0,2).map(fmt).join(' ')}" EndPoint="${coords.slice(end,end+2).map(fmt).join(' ')}" Extend="${(extend[0]?1:0)+(extend[1]?2:0)}"${radial?` StartRadius="${fmt(coords[2])}" EndRadius="${fmt(coords[5])}"`:''}>${stops.map(s=>`<ofd:Segment Position="${s.position}">${color(s.values,true)}</ofd:Segment>`).join('')}</ofd:${tag}>`;
   analytic={type,coords,extend,stops,gray:originalGray,rgb:space.type==='RGB'||!!space.convert};
  }else if(type>=4&&type<=7){
   const data=obj.readStream();let bytes;try{bytes=data.asUint8Array().slice();}finally{data.destroy();}
   const convert=values=>{if(fn)values=fn.at(values[0]);return space.convert?space.convert(values):values;};
   xml=meshShading({type,bytes,bc:value(obj,'BitsPerCoordinate'),bv:value(obj,'BitsPerComponent'),bf:value(obj,'BitsPerFlag'),decode:value(obj,'Decode'),components:fn?1:(space.sourceComponents||space.components),row:value(obj,'VerticesPerRow'),convert,color});
   approximate=type>=6||!!fn?.approximate||!!space.convert;
  }else throw new Error(`PDF ShadingType ${type} 暂无直接的 OFD 渐变映射。`);
  const result={xml,matrix,analytic,space:space.native,bbox:type===1?null:value(obj,'BBox',null),clip:type===1&&value(obj,'BBox',null)?{box:value(obj,'BBox'),matrix:bboxMatrix}:null,background:value(obj,'Background',null),color,approximate};this.plans.set(shade.pointer,result);return result;
 }
 colorSpace(obj){
  let type,components,profile;
  const spec=pdfValue(obj);
  if(typeof spec==='string') {type={DeviceGray:'GRAY',DeviceRGB:'RGB',DeviceCMYK:'CMYK'}[spec];components={GRAY:1,RGB:3,CMYK:4}[type];}
  else if(spec?.[0]==='ICCBased'){
   const stream=obj.get(1),n=stream.get('N'),data=stream.readStream();try{components=n.asNumber();type={1:'GRAY',3:'RGB',4:'CMYK'}[components];profile=data.asUint8Array().slice();}finally{data.destroy();n.destroy();stream.destroy();}
  }
  if(!type){
   // Calibrated and spot color spaces have no identical OFD base-space node.
   // Keep a native vector gradient, color-managing its stops to display RGB.
   const doc=this.doc,index=doc.countPages();
   const ref=doc.addPage([0,0,1,1],0,{ColorSpace:{C:obj}},'/C cs 0 0 1 1 re f');doc.insertPage(-1,ref);ref.destroy();
   let page,device,space;
   try{page=doc.loadPage(index);device=new m.Device({fillPath:(path,eo,ctm,cs)=>{path.destroy();space=cs;}});page.run(device,m.Matrix.identity);device.close();}
   finally{device?.destroy();page?.destroy();doc.deletePage(index);}
   if(!space)throw new Error('PDF 渐变颜色空间无法解析。');this.spaces.push(space);
   const px=new m.Pixmap(m.ColorSpace.DeviceRGB,[0,0,1,1],false),path=new m.Path();path.rect(0,0,1,1);this.spaces.push(px,path);
   return {id:this.pkg.colorSpace('RGB'),components:3,native:m.ColorSpace.DeviceRGB,sourceComponents:space.getNumberOfComponents(),convert(values){
    const dev=new m.DrawDevice(m.Matrix.identity,px);
    try{dev.fillPath(path,false,m.Matrix.identity,space,values,1);dev.close();return [...px.getPixels()].map(v=>v/255);}finally{dev.destroy();}
   }};
  }
  const native=profile?new m.ColorSpace(profile,'PDF shading ICC'):{GRAY:m.ColorSpace.DeviceGray,RGB:m.ColorSpace.DeviceRGB,CMYK:m.ColorSpace.DeviceCMYK}[type];
  if(profile)this.spaces.push(native);
  return {id:this.pkg.colorSpace(type,profile),components,type,native};
 }
}
