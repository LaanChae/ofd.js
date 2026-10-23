"""Narrow PDF.js patch for ISO 32000-1 table 202 GoToE P/A targets."""

def patch_worker(source):
    def replace(old, new, count=1):
        nonlocal source
        assert source.count(old) == count, "Upstream embedded attachment target hook changed"
        source = source.replace(old, new)

    replace('      docAttachments: annotationGlobals.attachments\n',
            '      docAttachments: annotationGlobals.attachments,\n      docCatalog: annotationGlobals.catalog\n', 2)
    replace('        docAttachments: this.attachments\n',
            '        docAttachments: this.attachments,\n        docCatalog: this\n')
    replace('    docAttachments = null\n  }) {',
            '    docAttachments = null,\n    docCatalog = null\n  }) {')
    replace('  get version() {\n    const version = this.#catDict', '''  // ISO 32000-1 table 202: attachment annotation targets need not be
  // published in the EmbeddedFiles name tree. Resolve metadata only here.
  getEmbeddedAttachmentTarget(target) {
    if (!(target instanceof Dict) || !isName(target.get("R"), "C") || target.has("T")) return null;
    let p = target.get("P"), page = null;
    const a = target.get("A");
    if (typeof p === "string") {
      const dest = this.getDestination(stringToPDFString(p, true));
      if (!Array.isArray(dest)) return null;
      if (dest[0] instanceof Ref) page = this.xref.fetch(dest[0]);
      else p = dest[0];
    }
    if (!page) {
      if (!Number.isInteger(p) || p < 0) return null;
      const pending = [this.toplevelPagesDict], seen = new Set();
      let visited = 0;
      while (pending.length && ++visited <= 100000) {
        const node = this.xref.fetchIfRef(pending.pop());
        if (!(node instanceof Dict) || seen.has(node)) continue;
        seen.add(node);
        const kids = node.get("Kids");
        if (isName(node.get("Type"), "Page") || !Array.isArray(kids)) {
          if (p-- === 0) { page = node; break; }
          continue;
        }
        const count = node.get("Count");
        if (Number.isInteger(count) && count >= 0 && p >= count) { p -= count; continue; }
        for (let i = kids.length - 1; i >= 0; i--) pending.push(kids[i]);
      }
    }
    if (!(page instanceof Dict)) return null;
    const annots = page.get("Annots");
    if (!Array.isArray(annots)) return null;
    let annot = null;
    if (Number.isInteger(a) && a >= 0 && a < annots.length) annot = this.xref.fetchIfRef(annots[a]);
    else if (typeof a === "string") {
      for (let i = 0; i < Math.min(annots.length, 100000); i++) {
        const candidate = this.xref.fetchIfRef(annots[i]);
        if (!(candidate instanceof Dict)) continue;
        const nm = candidate.get("NM");
        if (typeof nm === "string" && stringToPDFString(nm) === stringToPDFString(a)) { annot = candidate; break; }
      }
    }
    if (!(annot instanceof Dict) || !isName(annot.get("Subtype"), "FileAttachment")) return null;
    const fs = annot.get("FS");
    if (!(fs instanceof Dict) || !FileSpec.hasEmbeddedFile(fs)) return null;
    let ref = annot.getRaw("FS");
    if (!(ref instanceof Ref)) ref = FileSpec.pickPlatformItem(fs.get("EF"), true);
    if (!(ref instanceof Ref)) return null;
    return { attachmentId: this.getAttachmentIdForAnnotation(ref), attachment: new FileSpec(fs).serializable };
  }
  get version() {
    const version = this.#catDict''')
    replace('''          if (docAttachments && id) {
            resultObj.attachmentId = id;
            resultObj.attachment = docAttachments.get(id);
            const attachmentDest = fetchRemoteDest(action);''', '''          const embeddedTarget = id && docAttachments?.has(id)
            ? { attachmentId: id, attachment: docAttachments.get(id) }
            : docCatalog?.getEmbeddedAttachmentTarget(target);
          if (embeddedTarget) {
            Object.assign(resultObj, embeddedTarget);
            const attachmentDest = fetchRemoteDest(action);''')
    return source
