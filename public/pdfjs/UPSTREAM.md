# PDF.js upstream

Source: https://github.com/mozilla/pdf.js/tree/v6.4.299
Source tree SHA: d0991a0d53f3bb3a7307e3b83f279c1d117aafb3

Built with the official `npm ci --ignore-scripts` and `npx gulp generic` tasks.
Only en-US and zh-CN locales are included.
This source-only build has the upstream default build label 6.4.0 because it was built without Git history. All source files were checked against GitHub git-blob hashes.

The integration changes to web/viewer.html and build/pdf.mjs are reproducible with
`scripts/integrate-pdfjs.py <official-generic-build>`.
The text layer's minimum-font-size probe is clamped to at least 1 CSS pixel.
Safari at reduced browser zoom can report zero for the 1px probe, causing
infinite transforms and preventing text selection in both PDF and OFD previews.
Larger measured minimum font sizes remain respected. The bundled source map
describes the upstream build, before this local patch.
The upstream demonstration PDF was omitted. License: Apache-2.0, see LICENSE.

The OFD page adapter reuses PageViewport, AnnotationStorage, DOMFilterFactory and
PagesMapper, exported by a small integration patch. The viewer always consults
the OFD provider's permissions so PDF-only editors stay disabled for OFD, even
when PDF permission enforcement is disabled by preferences. Both changes are
reproduced by integrate-pdfjs.py; PDF loading/rendering keeps its upstream path.

The native `documentproperties` action routes OFD documents to the extension's
`ofddocumentproperties` event. PDF documents keep the upstream properties dialog.
`scripts/integrate-pdfjs.py` reproduces this exact routing change.
The TextLayerBuilder and PDFPageView call the OFD page provider's
`getTextLayerViewport` hook. It keeps glyph layout in page coordinates and applies
the display viewport to the text-layer container, including during CSS zoom.
The native highlighter, selection/copy and accessibility mapping are retained.
The image-description dialog uses `altTextLoading` instead of the generic
`loading` class: its descendant selectors otherwise invalidate every glyph in
an OFD page when `.page.loading` changes. The dialog's appearance is unchanged.
Both patches are reproduced by `scripts/integrate-pdfjs.py`.
The five upstream `#documentPropertiesDialog` CSS selectors also apply to
`#ofdPropertiesDialog` and the certificate field tables (`.ofdFields`); the OFD
properties DOM uses the original row/separator/buttonRow layout
and OverlayManager. No separate property-dialog theme is maintained.
Font, signature, certificate and signing windows reuse the upstream compact
`dialog`, `toolbarField`, `buttonRow`, `primaryButton` and `secondaryButton` styles.
Their extension CSS only supplies layout; colors follow PDF.js's color scheme.

The official-document structure view is registered with the native ViewsManager.
The extension's OfficialTreeViewer subclasses the exported BaseTreeViewer and uses
its original treeItem/treeItems/treeItemToggler nodes, selection and theme styles.
The HTML view slot, sidebar switching/title handling, heading toggle event and
BaseTreeViewer export are reproduced by scripts/pdfjs_official.py, called from
integrate-pdfjs.py. Editing dialogs and context-menu actions remain in the extension.
