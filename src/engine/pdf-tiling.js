import {multiply,scale,translate,MM} from './geometry.js';
import {matrixText} from './ofd-write-utils.js';
import {PdfAppearanceError} from './pdf-appearance.js';

// OFD Pattern clamps steps smaller than its cell. Expand only overlapping PDF
// cells as references to one native composite; each cell keeps its own boundary.
export function overlappingTiles(pkg,content,cw,ch,{area,view,xstep,ystep,ctm},boundary,clips){
  const dx=Math.abs(xstep),dy=Math.abs(ystep),left=Math.floor((area[0]-view[2])/dx)+1,right=Math.ceil((area[2]-view[0])/dx),top=Math.floor((area[1]-view[3])/dy)+1,bottom=Math.ceil((area[3]-view[1])/dy);
  if((right-left)*(bottom-top)>10000)throw new PdfAppearanceError('重叠平铺需要超过一万个单元');
  const id=pkg.composite(content,cw,ch),objects=[];
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
    const tm=multiply(scale(1/MM),multiply(ctm,multiply(translate(view[0]+x*dx,view[1]+y*dy),scale(MM))));
    objects.push(`<ofd:CompositeObject ID="${pkg.next()}" ResourceID="${id}" Boundary="${boundary}" CTM="${matrixText(tm)}">${clips}</ofd:CompositeObject>`);
  }
  return objects.join('');
}
