#!/usr/bin/env python3
"""Copy an official generic PDF.js build and add our isolated integration hooks."""
import pathlib
import shutil
import sys
from pdfjs_attachment_targets import patch_worker

project = pathlib.Path(__file__).resolve().parents[1]
source = pathlib.Path(sys.argv[1])
target = project / "public/pdfjs"
if target.exists():
    shutil.rmtree(target)
shutil.copytree(source, target)
worker = target / "build/pdf.worker.mjs"
worker.write_text(patch_worker(worker.read_text()))
core = target / "build/pdf.mjs"
core_text = core.read_text()
probe = "this.#minFontSize = div.getBoundingClientRect().height;"
assert core_text.count(probe) == 1, "Upstream text-layer font probe changed"
core.write_text(core_text.replace(probe, """// Safari can round this 1px probe to zero at reduced browser zoom.
    // The reciprocal used by the text layer must stay finite.
    this.#minFontSize = Math.max(1, div.getBoundingClientRect().height);"""))
with core.open("a") as output:
    output.write("\n// OFD viewer integration: shared display primitives.\nexport { PageViewport, AnnotationStorage, DOMFilterFactory, PagesMapper };\n")
html = target / "web/viewer.html"
text = html.read_text()
text = text.replace("<title>PDF.js viewer</title>", "<title>OFD / PDF 阅读器</title>")
text = text.replace('<script src="viewer.mjs" type="module"></script>', """
<link rel="stylesheet" href="/ofd-extension/extension.css" />
<script src="/ofd-extension/extension.js"></script>
<script src="viewer.mjs" type="module"></script>""")
marker = '<div id="outerContainer">'
assert marker in text, "Upstream viewer DOM changed"
text = text.replace(marker, """
<input id="ofdInput" type="file" hidden />
<div id="ofdWelcome">
  <h1>OFD / PDF 阅读器</h1>
  <p>打开本机文档，阅读或转换格式。</p>
  <button id="ofdWelcomeOpen" type="button">选择文件</button>
  <small>也可以将文件拖到这里 · PDF.js 阅读界面</small>
</div>
<div id="ofdFooter">
  <span id="ofdStatus" role="status" aria-live="polite">正在初始化阅读器…</span>
  <span id="ofdNotice" hidden title="OFD 在本机直接绘制，外观不代表签名验证结果。">OFD 直接预览 · 未验证数字签名</span>
</div>
<dialog id="ofdConversionDialog" aria-labelledby="ofdConversionTitle">
  <h2 id="ofdConversionTitle">转换原始文档</h2>
  <p id="ofdConversionNote"></p>
  <p>转换不包含 PDF.js 中新增的批注或编辑。请核对转换后的版式。</p>
  <div class="actions">
    <button id="ofdCancel" type="button">取消</button>
    <button id="ofdConfirm" type="button">转换并下载</button>
  </div>
</dialog>
""" + marker)
assert 'src="/ofd-extension/extension.js"' in text, "Upstream script tag changed"
html.write_text(text)
# This project opens the user's file; do not distribute the upstream demo PDF.
(target / "web/compressed.tracemonkey-pldi-09.pdf").unlink(missing_ok=True)
print("Integrated PDF.js:", target)

viewer = target / "web/viewer.mjs"
viewer_text = viewer.read_text()
permission_hook = "const permissionsPromise = this.#enablePermissions ? pdfDocument.getPermissions() : Promise.resolve();"
assert viewer_text.count(permission_hook) == 1, "Upstream viewer permissions changed"
viewer.write_text(viewer_text.replace(permission_hook,
    "const permissionsPromise = (this.#enablePermissions || pdfDocument.isOFD) ? pdfDocument.getPermissions() : Promise.resolve();"))

# Route the native Properties action to the document format's own metadata UI.
properties_hook = 'eventBus.on("documentproperties", () => pdfDocumentProperties?.open(), opts);'
viewer_text = viewer.read_text()
assert viewer_text.count(properties_hook) == 1, "Upstream properties action changed"
viewer.write_text(viewer_text.replace(properties_hook,
    'eventBus.on("documentproperties", () => this.pdfDocument?.isOFD ? eventBus.dispatch("ofddocumentproperties", { source: this }) : pdfDocumentProperties?.open(), opts);'))

# OFD selection geometry stays in page coordinates across zoom and rotation.
viewer_text = viewer.read_text()
text_viewport_hook = """    textContentParams = null
  }) {
    if (this.#renderingDone && this.#textLayer) {"""
assert viewer_text.count(text_viewport_hook) == 1, "Upstream text-layer builder changed"
viewer.write_text(viewer_text.replace(text_viewport_hook, """    textContentParams = null
  }) {
    viewport = this.pdfPage.getTextLayerViewport?.(this.div, viewport) ?? viewport;
    if (this.#renderingDone && this.#textLayer) {"""))

viewer_text = viewer.read_text()
stable_text_zoom = """    if (this.textLayer) {
      if (hideTextLayer) {"""
assert viewer_text.count(stable_text_zoom) == 1, "Upstream text-layer transform changed"
viewer.write_text(viewer_text.replace(stable_text_zoom, """    if (this.textLayer) {
      this.pdfPage.getTextLayerViewport?.(this.textLayer.div, this.viewport);
      if (hideTextLayer) {"""))

# OFD properties reuse the upstream property dialog styles without a second design.
css = target / "web/viewer.css"
css_text = css.read_text()
assert css_text.count("#documentPropertiesDialog") == 5, "Upstream properties styles changed"
css.write_text(css_text.replace("#documentPropertiesDialog", ":is(#documentPropertiesDialog, #ofdPropertiesDialog, .ofdFields)"))

# The generic `.loading` descendant rules of the alt-text dialog invalidate
# every glyph under `.page.loading` when the page renderer starts/finishes.
viewer_text = viewer.read_text()
alt_loading = 'this.#descriptionContainer.classList.toggle("loading", value);'
assert viewer_text.count(alt_loading) == 1, "Upstream alt-text loading state changed"
viewer.write_text(viewer_text.replace(alt_loading, 'this.#descriptionContainer.classList.toggle("altTextLoading", value);'))
css_text = css.read_text()
assert css_text.count("          &.loading {") == 1, "Upstream alt-text loading style changed"
css.write_text(css_text.replace("          &.loading {", "          &.altTextLoading {"))

# Official documents share PDF.js's sidebar manager and actual outline primitives.
from pdfjs_official import integrate as integrate_official
html_text, viewer_text = integrate_official(html.read_text(), viewer.read_text())
html.write_text(html_text)
viewer.write_text(viewer_text)
