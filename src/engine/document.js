import {
  Archive,
  name,
  child,
  children,
  text,
  attr,
  resolve,
  numbers,
} from "./archive.js";
import { readDocumentProperties } from "./properties.js";
import { selectDocument } from "./package.js";
import { readNavigation } from "./navigation.js";

export class OfdDocument {
  constructor(bytes, selection = {}) {
    this.archive = bytes instanceof Archive ? bytes : new Archive(bytes);
    this.warnings = this.archive.warnings;
    const entry = this.archive.xml("OFD.xml");
    if (name(entry) !== "OFD") throw new Error("主入口根节点不是 OFD。");
    if (attr(entry, "Version") !== "1.0")
      this.warnings.add(
        `主入口 Version=${attr(entry, "Version", "（缺失）")}，已按可解析的 OFD 结构读取。`,
      );
    if (!["OFD", "OFD-A"].includes(attr(entry, "DocType")))
      this.warnings.add(
        `DocType=${attr(entry, "DocType", "（缺失）")}，已按 OFD 结构读取。`,
      );
    const selected = selectDocument(this.archive, selection);
    Object.assign(this, selected);
    this.properties = readDocumentProperties(entry, this.body);
    this.properties.docRoot = this.docFile;
    this.root = this.archive.xml(this.docFile);
    if (name(this.root) !== "Document")
      throw new Error("DocRoot 指向的不是 Document。");
    this.common = child(this.root, "CommonData");
    this.referencedFonts = new Set();
    this.resources = {
      fonts: new Map(),
      images: new Map(),
      draws: new Map(),
      colors: new Map(),
      composites: new Map(),
    };
    this.resourceFiles = new Set();
    for (const tag of ["PublicRes", "DocumentRes"])
      for (const ref of children(this.common, tag))
        this.readResources(resolve(this.docFile, text(ref)));
    this.templates = new Map(
      children(this.common, "TemplatePage").map((n) => [
        attr(n, "ID"),
        {
          file: resolve(this.docFile, attr(n, "BaseLoc")),
          zOrder: attr(n, "ZOrder", "Background"),
        },
      ]),
    );
    this.pages = children(child(this.root, "Pages"), "Page").map((ref) => {
      const doc = this, page = {
        id: attr(ref, "ID"), file: resolve(this.docFile, attr(ref, "BaseLoc")),
        loaded: false,
        get box() { doc.loadPage(page); return page.physicalBox; },
        get root() { doc.loadPage(page); return doc.archive.xml(page.file); },
      };
      return page;
    });
    if (!this.pages.length)
      throw new Error("文档中没有页面。");
    this.annotations = new Map();
    const annots = text(this.root, "Annotations");
    if (annots) {
      const file = resolve(this.docFile, annots),
        index = this.archive.xml(file);
      for (const ref of children(index, "Page")) {
        const pageFile = resolve(file, text(ref, "FileLoc"));
        const doc = this;
        this.annotations.set(attr(ref, "PageID"), {
          file: pageFile,
          get root() { return doc.archive.xml(pageFile); },
        });
      }
    }
  }
  loadPage(page) {
    if (page.loaded) return page;
    if (page.error) throw page.error;
    try {
      const root = this.archive.xml(page.file);
      if (name(root) !== "Page") throw new Error("无效的页面资源。");
      page.hasActions = this.readPageResources(root, page.file);
      page.templateIds = children(root, "Template").map(ref => attr(ref, "TemplateID"));
      let area = child(root, "Area");
      for (const id of page.templateIds) {
        const template = this.templates.get(id);
        if (!template) throw Error("页面引用了不存在的模板。");
        const templateRoot = this.archive.xml(template.file);
        area ||= child(templateRoot, "Area");
        if (template.hasActions === undefined)
          template.hasActions = this.readPageResources(templateRoot, template.file);
      }
      area ||= child(this.common, "PageArea");
      const box = numbers(text(area, "PhysicalBox"), 4);
      if (box[2] <= 0 || box[3] <= 0 || box[2] > 5000 || box[3] > 5000)
        throw new Error("页面尺寸无效或超过 5 米。");
      const application = child(area, "ApplicationBox");
      const display = application ? numbers(text(application), 4) : box;
      const left = Math.max(box[0], display[0]), top = Math.max(box[1], display[1]);
      page.applicationBox = [left, top,
        Math.max(0, Math.min(box[0] + box[2], display[0] + display[2]) - left),
        Math.max(0, Math.min(box[1] + box[3], display[1] + display[3]) - top)];
      const annotations = this.annotations.get(page.id);
      if (annotations) this.collectFontReferences(annotations.root);
      page.physicalBox = box;
      page.loaded = true;
      return page;
    } catch (error) { page.error = error; throw error; }
  }
  page(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length)
      throw Error("页码超出范围。");
    return this.loadPage(this.pages[index]);
  }
  get signatureIndex() {
    const loc = text(this.body, "Signatures");
    if (!loc) return { file: null, entries: [] };
    const file = resolve("OFD.xml", loc), allowed = this.version && new Set(this.version.files);
    return { file, entries: children(this.archive.xml(file), "Signature").filter(entry =>
      !allowed || allowed.has(resolve(file, attr(entry, "BaseLoc")))) };
  }
  get navigation() {
    return this._navigation ??= readNavigation(this);
  }
  collectFontReferences(root, composites = null) {
    let hasActions = false;
    // Walk siblings directly: no live NodeList or intermediate array containing
    // every element of a large page is needed just to collect font references.
    for (let node = root; node;) {
      if (node.nodeType === 1) {
        const tag = name(node);
        if ((tag === "TextObject" || tag === "Text") && attr(node, "Font"))
          this.referencedFonts.add(attr(node, "Font"));
        if (tag === "Actions") hasActions = true;
        if (tag === "CompositeObject") composites?.add(attr(node, "ResourceID"));
      }
      if (node.firstChild) node = node.firstChild;
      else {
        while (node !== root && !node.nextSibling) node = node.parentNode;
        node = node === root ? null : node.nextSibling;
      }
    }
    return hasActions;
  }
  readPageResources(root, file) {
    const composites = new Set();
    const hasActions = this.collectFontReferences(root, composites);
    for (const ref of children(root, "PageRes"))
      this.readResources(resolve(file, text(ref)));
    if (hasActions) return true;
    // Inspect only resources used by this page. A resource's local metadata is
    // stable, while its referenced resources may be supplied by PageRes later.
    for (const id of composites) {
      const resource = this.resources.composites.get(id);
      if (resource?.hasActions) return true;
      for (const nested of resource?.composites || []) composites.add(nested);
    }
    return false;
  }
  readResources(file) {
    if (this.resourceFiles.has(file)) return;
    this.resourceFiles.add(file);
    const root = this.archive.xml(file);
    this.collectFontReferences(root);
    const base = resolve(file, attr(root, "BaseLoc", ".")) + "/";
    for (const [group, tag, key] of [
      ["Fonts", "Font", "fonts"],
      ["MultiMedias", "MultiMedia", "images"],
      ["DrawParams", "DrawParam", "draws"],
      ["ColorSpaces", "ColorSpace", "colors"],
      ["CompositeGraphicUnits", "CompositeGraphicUnit", "composites"],
    ]) {
      for (const node of children(child(root, group), tag)) {
        const id = attr(node, "ID");
        if (!id || this.resources[key].has(id))
          throw new Error(`重复或缺失的资源 ID：${id}`);
        const ref = text(node, tag === "Font" ? "FontFile" : "MediaFile");
        const composites = key === "composites" ? new Set() : null;
        const hasActions = composites ? this.collectFontReferences(node, composites) : false;
        this.resources[key].set(id, {
          id,
          node,
          file,
          base,
          path: ref ? resolve(base, ref) : null,
          ...(composites ? { composites, hasActions } : {}),
        });
      }
    }
  }
  drawing(node, inherited = {}) {
    let values = { ...inherited };
    const seen = new Set();
    const load = (id) => {
      if (seen.has(id)) throw new Error("DrawParam 循环引用。");
      seen.add(id);
      const ref = this.resources.draws.get(id);
      if (!ref) throw new Error(`找不到绘制参数 ${id}`);
      const relative = attr(ref.node, "Relative");
      if (relative) load(relative);
      merge(ref.node);
    };
    const merge = (n) => {
      for (const key of [
        "LineWidth",
        "Cap",
        "Join",
        "MiterLimit",
        "DashPattern",
        "DashOffset",
      ])
        if (n.hasAttribute(key)) values[key] = attr(n, key);
      for (const key of ["FillColor", "StrokeColor"])
        if (child(n, key)) values[key] = child(n, key);
    };
    if (attr(node, "DrawParam")) load(attr(node, "DrawParam"));
    merge(node);
    return values;
  }
}
