import * as m from 'mupdf';

// OFD stores image samples without PDF's Interpolate preference. Use the pixel
// grid consistently in the direct and PDF backends, including low-res masks.
export function pixelImage(image) {
 const doc=new m.PDFDocument(),ref=doc.addImage(image);
 try{ref.put('Interpolate',false);return doc.loadImage(ref);}finally{ref.destroy();doc.destroy();}
}
