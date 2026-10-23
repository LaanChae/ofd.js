import * as m from 'mupdf';
import {rasterizePaint} from './pdf-raster-paint.js';

export class PdfAppearanceError extends Error {}

// Final-page patches include the real backdrop AND subsequent overpaint. A
// Multiply group cannot be rasterized over transparent black in isolation.
// Underlying native text remains in the page and is not duplicated in patches.
export class AppearancePatches {
  constructor(pageBounds, depth=0){this.bounds=pageBounds;this.depth=depth;this.regions=[];}
  add(box,reason){
    if(this.depth)throw new PdfAppearanceError(reason);
    box=[Math.max(this.bounds[0],box[0]-0.5),Math.max(this.bounds[1],box[1]-0.5),Math.min(this.bounds[2],box[2]+0.5),Math.min(this.bounds[3],box[3]+0.5)];
    if(!box.every(Number.isFinite))throw new Error('PDF 合成区域边界无效。');
    if(box[2]>box[0]&&box[3]>box[1])this.regions.push({box,reasons:new Set([reason])});
  }
  render(page,matrix){
    const regions=[];
    for(const entry of this.regions){
      let merged=true;
      while(merged){merged=false;for(let i=0;i<regions.length;i++){
        const a=entry.box,b=regions[i].box;
        if(a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]){
          entry.box=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
          for(const reason of regions[i].reasons)entry.reasons.add(reason);regions.splice(i,1);merged=true;break;
        }
      }}regions.push(entry);
    }
    return regions.map(({box,reasons})=>{
      const image=rasterizePaint(box,[],this.bounds,device=>{
        const path=new m.Path();path.rect(...this.bounds);
        try{device.fillPath(path,false,m.Matrix.identity,m.ColorSpace.DeviceRGB,[1,1,1],1);}finally{path.destroy();}
        page.run(device,matrix);
      });
      return {...image,reasons:[...reasons]};
    });
  }
}
