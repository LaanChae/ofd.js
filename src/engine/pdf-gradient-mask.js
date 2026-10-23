import {PdfAppearanceError} from './pdf-appearance.js';
import * as m from 'mupdf';
import {functionStops} from './pdf-functions.js';
import {multiply} from './geometry.js';

// OFD has per-stop Alpha, not a general PDF soft-mask operator. Sample the
// luminosity transfer of a single axial/radial mask into native alpha stops.
export function gradientMask(operations, shading, maskSpace) {
 let paint=null,stack=[],area=[];
 for(const [name,args] of operations){
  if(name==='beginGroup'){if(args[3]||args[4]!=='Normal'||args[5]!==1)throw new PdfAppearanceError('软蒙版包含不能直接映射的透明组。');}
  else if(['endGroup','beginLayer','endLayer'].includes(name))continue;
  else if(name==='clipPath'||name==='clipStrokePath')stack.push([name,args]);
  else if(name==='popClip'){if(!stack.length)throw new Error('软蒙版裁剪栈不完整。');stack.pop();}
  else if(name==='fillShade'){
   if(paint)throw new PdfAppearanceError('软蒙版包含多个渐变，不能合并为单个 OFD 渐变。');
   const plan=shading.plan(args[0]);
   if(!plan.analytic||!plan.space||args[2]!==1||plan.background)throw new PdfAppearanceError('仅支持单个 Gray/RGB 轴向或径向软蒙版的原生转换。');
   const pixels=new m.Pixmap(m.ColorSpace.DeviceRGB,[0,0,1,1],true),path=new m.Path();path.rect(0,0,1,1);
   let stops;
   try {
    const fn={breaks:plan.analytic.stops.map(s=>s.position),at(t){
     pixels.clear();const device=new m.DrawDevice(m.Matrix.identity,pixels);
     try {
      device.beginMask([0,0,1,1],true,maskSpace,Array(maskSpace.getNumberOfComponents()).fill(0));
      device.fillPath(path,false,m.Matrix.identity,plan.space,interpolate(plan.analytic.stops,t),1);
      device.endMask();device.fillPath(path,false,m.Matrix.identity,m.ColorSpace.DeviceRGB,[1,1,1],1);device.popClip();device.close();
      return [pixels.getPixels()[3]/255];
     }finally{device.destroy();}
    }};
    stops=functionStops(fn,[0,1],1.1/255);
   }finally{path.destroy();pixels.destroy();}
   const maskPlan={...plan,analytic:{...plan.analytic,stops}};

   paint={plan:maskPlan,ctm:multiply(args[1],plan.matrix)};area=[...stack];
  }else if(name==='fillPath'){
   if(paint||args[3].getName()!=='DeviceGray'||args[4].some(v=>v!==0)||args[5]!==1)throw new PdfAppearanceError('软蒙版包含独立绘制，不能合并为渐变透明度。');
   // Only an opaque black rectangular clearing paint before the gradient is
   // neutral over a black luminosity background. Other shapes are not ignored.
   let curves=0,points=[];args[0].walk({moveTo:(x,y)=>points.push([x,y]),lineTo:(x,y)=>points.push([x,y]),curveTo:()=>curves++,closePath(){}});
   if(curves||points.length<4||points.length>5||points.some((p,i)=>{const q=points[(i+1)%points.length];return p[0]!==q[0]&&p[1]!==q[1];}))throw new PdfAppearanceError('软蒙版背景不是矩形。');
  }else throw new PdfAppearanceError(`软蒙版包含 ${name}`);
 }
 if(stack.length)throw new Error('软蒙版裁剪栈未闭合。');
 if(!paint)throw new PdfAppearanceError('软蒙版没有单一渐变绘制。');
 return {...paint,area};
}
export function tintGradientMask(mask, rgb) {
 const segments=mask.plan.analytic.stops.map(s=>`<ofd:Segment Position="${s.position}"><ofd:Color Value="${rgb}" Alpha="${Math.round(Math.max(0,Math.min(1,s.values[0]))*255)}"/></ofd:Segment>`).join('');
 return mask.plan.xml.replace(/<ofd:Segment[\s\S]*<\/ofd:Segment>/,segments);
}

function interpolate(stops,t){let i=0;while(i<stops.length-2&&t>stops[i+1].position)i++;const a=stops[i],b=stops[i+1],u=Math.max(0,Math.min(1,(t-a.position)/(b.position-a.position)));return a.values.map((v,k)=>v+(b.values[k]-v)*u);}
export function combineGradientMask(plan,ctm,mask){
 const a=plan.analytic,b=mask.plan.analytic;
 if(!a||a.type!==b.type||JSON.stringify(a.extend)!==JSON.stringify(b.extend)||a.coords.some((v,i)=>Math.abs(v-b.coords[i])>1e-6)||ctm.some((v,i)=>Math.abs(v-mask.ctm[i])>1e-5))throw new PdfAppearanceError('不同几何的颜色渐变和软蒙版尚不能合并为原生色标。');
 const positions=[...new Set([...a.stops,...b.stops].map(s=>s.position))].sort((a,b)=>a-b);
 const segments=positions.map(t=>`<ofd:Segment Position="${t}">${plan.color(interpolate(a.stops,t),true).replace('/>',` Alpha="${Math.round(Math.max(0,Math.min(1,interpolate(b.stops,t)[0]))*255)}"/>`)}</ofd:Segment>`).join('');
 return plan.xml.replace(/<ofd:Segment[\s\S]*<\/ofd:Segment>/,segments);
}
