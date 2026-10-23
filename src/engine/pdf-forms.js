import * as m from "mupdf";
import { multiply } from "./geometry.js";

// The MuPDF PDF-writing device drops mesh shades. Native PDF forms preserve both
// mesh data and analytic gradient functions. A private random image token carries
// each form through the device's clipping/stacking/transform pipeline; finalizePdf
// replaces every token resource with its vector form before exposing the result.
export class PdfForms {
  constructor() {
    this.entries = new Map();
    this.installed = new Set();
  }
  paintImage(device,image,matrix,opacity){
    // Snapshot the compressed image resource while nested seal renderers are
    // alive. Retaining decoded images until finalization exhausts WASM memory
    // on long documents. This small PDF is only an internal resource envelope.
    const source=new m.PDFDocument();let bytes,ref,page,buffer;
    try{
      ref=source.addImage(image);page=source.addPage([0,0,1,1],0,{XObject:{I:ref}},'/I Do');source.insertPage(-1,page);
      buffer=source.saveToBuffer('compress');bytes=buffer.asUint8Array().slice();
    }finally{buffer?.destroy();page?.destroy();ref?.destroy();source.destroy();}
    this.paint(device,{matrix,box:[0,0,1,1],makeForm(pdf){
      const source=m.Document.openDocument(bytes,'application/pdf'),page=source.findPage(0),image=page.get('Resources','XObject','I');let resource;
      try{
        resource=pdf.graftObject(image);
        return pdf.addStream('/A gs /I Do',{Type:'XObject',Subtype:'Form',BBox:[0,0,1,1],Group:{S:'Transparency',I:true,CS:'DeviceRGB'},Resources:{XObject:{I:resource},ExtGState:{A:{ca:opacity,CA:opacity}}}});
      }finally{resource?.destroy();image.destroy();page.destroy();source.destroy();}
    }},false,1);
  }
  paint(device, plan, alpha, opacity) {
    const token = crypto.getRandomValues(new Uint8Array(48));
    const key = Array.from(token, (n) => n.toString(16).padStart(2, "0")).join(
      "",
    );
    const pixmap = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, 16, 1], false);
    let image;
    try {
      pixmap.getPixels().set(token);
      image = new m.Image(pixmap);
      this.entries.set(key, { plan, alpha, opacity });
      const [x0, y0, x1, y1] = plan.box;
      device.fillImage(
        image,
        multiply(plan.matrix, [x1 - x0, 0, 0, y1 - y0, x0, y0]),
        1,
      );
    } finally {
      image?.destroy();
      pixmap.destroy();
    }
  }
  replace(pdf, resource) {
    const subtype = resource.get("Subtype"),
      width = resource.get("Width"),
      height = resource.get("Height");
    try {
      if (
        subtype.asName() !== "Image" ||
        width.asNumber() !== 16 ||
        height.asNumber() !== 1
      )
        return null;
    } finally {
      subtype.destroy();
      width.destroy();
      height.destroy();
    }
    const image = pdf.loadImage(resource),
      pixmap = image.toPixmap();
    let key;
    try {
      key = Array.from(pixmap.getPixels(), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
    } finally {
      pixmap.destroy();
      image.destroy();
    }
    const entry = this.entries.get(key);
    if (!entry) return null;
    const { plan, alpha, opacity } = entry,
      [x0, y0, x1, y1] = plan.box,
      w = x1 - x0,
      h = y1 - y0;
    if (plan.makeForm) {
      const form = plan.makeForm(pdf);
      this.installed.add(key);
      return form;
    }
    const shade = plan.make(pdf, alpha);
    try {
      const form = pdf.addStream(
        `q ${1 / w} 0 0 ${-1 / h} ${-x0 / w} ${y1 / h} cm /A gs /Sh sh Q`,
        {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, 1, 1],
          Resources: {
            Shading: { Sh: shade },
            ExtGState: { A: { ca: opacity, CA: opacity } },
          },
        },
      );
      this.installed.add(key);
      return form;
    } finally {
      shade?.destroy?.();
    }
  }
  assertInstalled() {
    if (this.installed.size !== this.entries.size)
      throw new Error("未能完整写入 PDF 渐变资源，已停止输出。");
  }
}
