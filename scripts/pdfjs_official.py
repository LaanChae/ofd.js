"""Small, checked integration hooks for the native OFD official-document view."""
HTML_HOOKS = [
    ('<button id="layersViewMenu"', '<button id="officialViewMenu" role="option" type="button" tabindex="-1" hidden><span>公文结构</span></button>\n                          <button id="layersViewMenu"'),
    ('<div id="layersView" class="treeView hidden"></div>', '<div id="layersView" class="treeView hidden"></div>\n                    <div id="officialView" class="treeView hidden"></div>'),
]
VIEWER_HOOKS = [
    ('class ViewsManager extends Sidebar {', 'const OFD_OFFICIAL_VIEW = 5;\nclass ViewsManager extends Sidebar {'),
    ('this.layersView = layersView;', '''this.layersView = layersView;
    this.officialView = document.getElementById("officialView");
    this.officialButton = document.getElementById("officialViewMenu");
    this.officialButton.addEventListener("click", () => this.switchView(OFD_OFFICIAL_VIEW, true));'''),
    ('[thumbnailButton, outlineButton, attachmentsButton, layersButton]);', '[thumbnailButton, outlineButton, attachmentsButton, layersButton, this.officialButton]);'),
    ('    switch (view) {\n      case SidebarView.NONE:', '''    switch (view) {
      case OFD_OFFICIAL_VIEW:
        if (this.officialButton.hidden) return;
        break;
      case SidebarView.NONE:'''),
    ('this.active = view;\n    toggleSelectedBtn(this.thumbnailButton', '''if (view === OFD_OFFICIAL_VIEW) {
      this.viewsManagerHeaderLabel.removeAttribute("data-l10n-id");
      this.viewsManagerHeaderLabel.textContent = "公文结构";
    }
    this.active = view;
    toggleSelectedBtn(this.officialButton, view === OFD_OFFICIAL_VIEW, this.officialView);
    if (view === OFD_OFFICIAL_VIEW && isViewChanged) this.eventBus.dispatch("ofdofficialview", {source:this});
    toggleSelectedBtn(this.thumbnailButton'''),
    ('      if (this.active === SidebarView.OUTLINE) {\n        eventBus.dispatch("toggleoutlinetree",', '''      if (this.active === OFD_OFFICIAL_VIEW) {
        eventBus.dispatch("toggleofficialtree", {source:this});
        return;
      }
      if (this.active === SidebarView.OUTLINE) {
        eventBus.dispatch("toggleoutlinetree",'''),
    ('export { PDFViewerApplication,', 'export { BaseTreeViewer, PDFViewerApplication,'),
]

def integrate(html, viewer):
    def apply(source, hooks):
        for before, after in hooks:
            assert source.count(before) == 1, f'PDF.js official-view hook changed: {before}'
            source = source.replace(before, after)
        return source
    return apply(html, HTML_HOOKS), apply(viewer, VIEWER_HOOKS)
