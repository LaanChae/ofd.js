import {sha256} from "@noble/hashes/sha256";
import {zipSync, strToU8} from "fflate";
import {NS, MAX_FILE} from "./archive.js";
import {fmt} from "./ofd-write-utils.js";

export const xml = (content) =>
  strToU8('<?xml version="1.0" encoding="UTF-8"?>' + content);

export class PdfPackageLimitError extends Error {}

export class PackageWriter {
  constructor() {
    this.files = {};
    this.id = 0;
    this.pages = [];
    this.resources = [];
    this.imageIds = new Map();
    this.binaryFiles = new Map();
    this.colorIds = new Map();
    this.pageIds = [];
    this.documentExtras = "";
    this.docInfo = "";
    this.fonts = [];
    this.colors = [];
    this.composites = [];
    this.notices = new Map();
    this.documentWarnings = new Set();
    this.expanded = 0;
    this.rasterized = new Map();
  }
  noteRasterization(kind, page, dpi) {
    if (!this.rasterized.has(kind)) this.rasterized.set(kind, new Map());
    const pages = this.rasterized.get(kind);
    pages.set(page, Math.min(dpi, pages.get(page) ?? dpi));
  }
  warnings() {
    return [...this.documentWarnings, ...[...this.notices].map(([message,pages])=>`第 ${[...pages].join('、')} 页：${message}`), ...[...this.rasterized].map(([kind, pages]) => {
      const dpi = Math.floor(Math.min(...pages.values()));
      return `第 ${[...pages.keys()].join("、")} 页：${kind}已保存为 OFD 图像资源（300 DPI，受尺寸限制时降低，本次最低 ${dpi} DPI），按最终页面合成，保留背景、裁剪和绘制顺序；放大后清晰度受图片分辨率限制，正常文字仍可选择、搜索和复制。`;
    })];
  }
  note(message, page) {
    if (!this.notices.has(message)) this.notices.set(message, new Set());
    this.notices.get(message).add(page);
  }
  colorSpace(type, profile) {
    const key = type + ":" + (profile ? sha256(profile).join(",") : "");
    if (this.colorIds.has(key)) return this.colorIds.get(key);
    const id=this.next(), file=profile ? this.binary(profile, "icc") : "";
    this.colorIds.set(key, id);
    this.colors.push(`<ofd:ColorSpace ID="${id}" Type="${type}" BitsPerComponent="16"${profile?` Profile="${file}"`:''}/>`);
    return id;
  }
  binary(bytes, extension) {
    const key = extension + ":" + sha256(bytes).join(",");
    if (this.binaryFiles.has(key)) return this.binaryFiles.get(key);
    const file = `${this.next()}.${extension}`;
    this.add(`Doc_0/Res/${file}`, bytes);
    this.binaryFiles.set(key, file);
    return file;
  }
  composite(content,w,h) {
    if(strToU8(content).length>14*1048576)throw new Error('单个复合图元超过 XML 大小限制。');
    const id=this.next();
    this.composites.push(`<ofd:CompositeGraphicUnit ID="${id}" Width="${fmt(w)}" Height="${fmt(h)}"><ofd:Content>${content}</ofd:Content></ofd:CompositeGraphicUnit>`);
    return id;
  }
  next() {
    return ++this.id;
  }
  // A failed appearance must not leave its images/composites in the archive.
  // Fonts and colour spaces stay registered: native caches retain their IDs.
  checkpoint() {
    return {id:this.id, resources:this.resources.length, composites:this.composites.length,
      notices:new Map([...this.notices].map(([key,pages])=>[key,new Set(pages)])),
      rasterized:new Map([...this.rasterized].map(([key,pages])=>[key,new Map(pages)]))};
  }
  rollback(checkpoint) {
    this.resources.length=checkpoint.resources;
    this.composites.length=checkpoint.composites;
    for(const [key,id] of this.imageIds)if(id>checkpoint.id) {
      this.imageIds.delete(key);
      for(const ext of ['png','jpg']) {
        const path=`Doc_0/Res/${id}.${ext}`;
        if(this.files[path]){this.expanded-=this.files[path].length;delete this.files[path];}
      }
    }
    this.notices=checkpoint.notices;this.rasterized=checkpoint.rasterized;
  }
  add(path, bytes) {
    if (path.endsWith(".xml") && bytes.length > 16 * 1048576)
      throw new Error(`XML ${path} 为 ${bytes.length} 字节，超过 16 MB。`);
    const expanded=this.expanded+bytes.length-(this.files[path]?.length||0);
    if (expanded > 480 * 1024 * 1024)
      throw new PdfPackageLimitError("转换内容超过 480 MB，请拆分 PDF 后再转换。");
    this.expanded=expanded;
    this.files[path] = bytes;
  }
  image(bytes) {
    const digest=sha256(bytes).join(',');
    if(this.imageIds.has(digest))return this.imageIds.get(digest);
    const id = this.next(),
      jpeg = bytes[0] === 255 && bytes[1] === 216,
      extension = jpeg ? "jpg" : "png";
    this.add(`Doc_0/Res/${id}.${extension}`, bytes);
    this.resources.push(
      `<ofd:MultiMedia ID="${id}" Type="Image" Format="${jpeg ? "JPEG" : "PNG"}"><ofd:MediaFile>${id}.${extension}</ofd:MediaFile></ofd:MultiMedia>`,
    );
    this.imageIds.set(digest,id);
    return id;
  }
  page(w, h, objects, actions = "") {
    this.defaultBox ??= `0 0 ${fmt(w)} ${fmt(h)}`;
    const index = this.pages.length, id = this.pageIds[index] ?? this.next();
    this.pageIds[index] = id;
    this.pages.push(
      `<ofd:Page ID="${id}" BaseLoc="Pages/${index}/Content.xml"/>`,
    );
    this.add(
      `Doc_0/Pages/${index}/Content.xml`,
      xml(
        `<ofd:Page xmlns:ofd="${NS}"><ofd:Area><ofd:PhysicalBox>0 0 ${fmt(w)} ${fmt(h)}</ofd:PhysicalBox></ofd:Area><ofd:Content><ofd:Layer ID="${this.next()}">${objects}</ofd:Layer></ofd:Content>${actions?`<ofd:Actions>${actions}</ofd:Actions>`:""}</ofd:Page>`,
      ),
    );
  }
  finish() {
    // GB/T 33190 allows multiple DocumentRes references. Bound each XML file
    // independently, including documents with thousands of clipped composites.
    const resourceFiles=[];let groups={},size=0;
    const flush=()=>{
      const name=resourceFiles.length?`DocumentRes_${resourceFiles.length}.xml`:'DocumentRes.xml';
      const body=Object.entries(groups).map(([tag,entries])=>`<ofd:${tag}>${entries.join('')}</ofd:${tag}>`).join('');
      this.add(`Doc_0/${name}`,xml(`<ofd:Res xmlns:ofd="${NS}" BaseLoc="Res">${body}</ofd:Res>`));
      resourceFiles.push(name);groups={};size=0;
    };
    for(const [tag,entries] of [['ColorSpaces',this.colors],['CompositeGraphicUnits',this.composites],['Fonts',this.fonts],['MultiMedias',this.resources]])
      for(const entry of entries){
        const length=strToU8(entry).length;
        if(size&&size+length>14*1048576)flush();
        (groups[tag]??=[]).push(entry);size+=length;
      }
    if(size||!resourceFiles.length)flush();
    this.add(
      "OFD.xml",
      xml(
        `<ofd:OFD xmlns:ofd="${NS}" Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocInfo><ofd:DocID>${crypto.randomUUID().replaceAll("-", "")}</ofd:DocID>${this.docInfo}<ofd:Creator>Paperdesk JS</ofd:Creator></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
      ),
    );
    this.add(
      "Doc_0/Document.xml",
      xml(
        `<ofd:Document xmlns:ofd="${NS}"><ofd:CommonData><ofd:MaxUnitID>${this.id}</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>${this.defaultBox}</ofd:PhysicalBox></ofd:PageArea>${resourceFiles.map(name=>`<ofd:DocumentRes>${name}</ofd:DocumentRes>`).join('')}</ofd:CommonData><ofd:Pages>${this.pages.join("")}</ofd:Pages>${this.documentExtras}</ofd:Document>`,
      ),
    );
    if(Object.keys(this.files).length>20000)
      throw new PdfPackageLimitError("转换结果超过 20000 个包内文件，请拆分 PDF 后再转换。");
    const result = zipSync(this.files, { level: 6 });
    if (result.length > MAX_FILE)
      throw new PdfPackageLimitError(`转换结果为 ${(result.length/1048576).toFixed(1)} MB，超过 100 MB，请拆分 PDF 后再转换。`);
    return result;
  }
}

