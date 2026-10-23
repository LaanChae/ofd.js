import * as m from 'mupdf';
import {multiply} from './geometry.js';
import {fmt} from './ofd-write-utils.js';

// Evaluate the existing native PDF function/shading interpreter, including
// sampled and PostScript functions. Only color samples enter the OFD mesh;
// the output contains no image resource and remains resolution independent.
export function functionShading(shade, domain, matrix, space, color) {
  if(domain.length!==4||!domain.every(Number.isFinite)||domain[1]<=domain[0]||domain[3]<=domain[2])
    throw new Error('PDF 二维渐变定义域无效。');
  const count=128,inverse=m.Matrix.invert(matrix),pixels=new m.Pixmap(space,[0,0,count,count],true),points=[];
  const dx=domain[1]-domain[0],dy=domain[3]-domain[2];
  const transform=multiply([count/dx,0,0,count/dy,-domain[0]*count/dx,-domain[2]*count/dy],inverse);
  const device=new m.DrawDevice(m.Matrix.identity,pixels);
  try {
    pixels.clear();device.fillShade(shade,transform,1);device.close();
    const components=space.getNumberOfComponents(),stride=components+1,samples=pixels.getPixels();
    // Samples are at pixel centers. Add boundary vertices by extending the
    // nearest function sample; the half-step boundary error is disclosed as
    // vector approximation, rather than embedding the sampled field as PNG.
    for(let y=-1;y<=count;y++)for(let x=-1;x<=count;x++){
      const u=domain[0]+dx*(x<0?0:x===count?1:(x+.5)/count);
      const v=domain[2]+dy*(y<0?0:y===count?1:(y+.5)/count);
      let sx=Math.max(0,Math.min(count-1,x)),sy=Math.max(0,Math.min(count-1,y)),index=(sy*count+sx)*stride;
      // The native triangle rasterizer may leave the outermost sample empty
      // after floating-point matrix inversion. Never turn missing coverage into
      // a black color stop; extend an adjacent covered sample at that boundary.
      if(samples[index+components]===0){
        for(let radius=1;radius<=2&&samples[index+components]===0;radius++)
          for(let yy=Math.max(0,sy-radius);yy<=Math.min(count-1,sy+radius);yy++)
            for(let xx=Math.max(0,sx-radius);xx<=Math.min(count-1,sx+radius);xx++){
              const candidate=(yy*count+xx)*stride;
              if(samples[candidate+components])index=candidate;
            }
      }
      points.push(`<ofd:Point X="${fmt(u)}" Y="${fmt(v)}">${color(Array.from(samples.subarray(index,index+components),v=>samples[index+components]?v/samples[index+components]:0),true)}</ofd:Point>`);
    }
  } finally {device.destroy();pixels.destroy();}
  return `<ofd:LaGouraudShd VerticesPerRow="${count+2}">${points.join('')}</ofd:LaGouraudShd>`;
}
