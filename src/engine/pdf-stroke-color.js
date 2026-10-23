import * as m from "mupdf";
import { IDENTITY, multiply, translate } from "./geometry.js";

// The PDF device implements clipStrokePath as a filled path clip. Keep the
// actual stroke in a separate vector luminosity-mask Form instead. Fresh
// devices also prevent text/stroke/CTM state leaking into mask streams.
export function pdfStrokeColor(renderer, device, object, stroke, matrix, color, opacity, style, isText = false) {
  const box = object.getBounds(stroke, IDENTITY), [x0,y0,x1,y1] = box,
    width = x1-x0, height = y1-y0;
  if (width <= 0 || height <= 0) return;
  const local = translate(-x0,-y0);
  const capture = paint => {
    const buffer = new m.Buffer(), writer = new m.DocumentWriter(buffer,"pdf","compress");
    let target;
    try {
      target = writer.beginPage([0,0,width,height]);paint(target);
      writer.endPage();writer.close();return buffer.asUint8Array().slice();
    } finally {target?.destroy();writer.destroy();buffer.destroy();}
  };
  const maskBytes = capture(target => {
    if (isText) target.strokeText(object,stroke,local,m.ColorSpace.DeviceGray,[1],1);
    else target.strokePath(object,stroke,local,m.ColorSpace.DeviceGray,[1],1);
  });
  const bounds = renderer.bounds, pageMatrix = renderer.pageMatrix;
  let paintBytes;
  try {
    renderer.bounds = [0,0,width,height];
    renderer.pageMatrix = multiply(local,multiply(m.Matrix.invert(matrix),pageMatrix));
    paintBytes = capture(target => renderer.complexColor(target,color.complex,local,opacity*color.alpha,style));
  } finally {renderer.bounds = bounds;renderer.pageMatrix = pageMatrix;}
  renderer.forms.paint(device,{matrix,box,makeForm(pdf) {
    const owned=[], keep=o=>(owned.push(o),o);
    const form = (bytes,mask) => {
      const source=m.Document.openDocument(bytes,"application/pdf"),graft=pdf.newGraftMap();
      try {
        const page=keep(source.findPage(0)),resources=keep(graft.graftObject(keep(page.getInheritable("Resources")))),
          data=keep(keep(page.get("Contents")).readStream());
        const stream = mask && isText ? `/Span << /ActualText () >> BDC\n${data.asString()}\nEMC` : data.asUint8Array().slice();
        return keep(pdf.addStream(stream,{Type:"XObject",Subtype:"Form",BBox:[0,0,width,height],Resources:resources,
          ...(mask?{Group:{S:"Transparency",CS:"DeviceGray",I:true}}:{})}));
      } finally {graft.destroy();source.destroy();}
    };
    try {
      const mask=form(maskBytes,true),paint=form(paintBytes,false);
      return pdf.addStream("q /A gs /Paint Do Q",{Type:"XObject",Subtype:"Form",BBox:[0,0,width,height],Matrix:[1/width,0,0,1/height,0,0],
        Resources:{XObject:{Paint:paint},ExtGState:{A:{SMask:{S:"Luminosity",G:mask,BC:[0]}}}}});
    } finally {owned.reverse().forEach(o=>o.destroy());}
  }},false,1);
}
