import {BaseTreeViewer} from '../pdfjs/web/viewer.mjs';

// Reuse PDF.js's outline primitives and CSS; all document edits stay in official.js.
export class OfficialTreeViewer extends BaseTreeViewer {
  constructor(app,container,onSelect,onContext) {
    super({container,eventBus:app.eventBus,l10n:app.l10n});
    this.onSelect=onSelect;this.onContext=onContext;
    container.addEventListener('click',event=>{
      const toggler=event.target.closest('.treeItemToggler');
      if(!toggler)return;
      event.stopPropagation();toggler.classList.toggle('treeItemsHidden');
      if(event.shiftKey)this._toggleTreeItem(toggler.parentNode,!toggler.classList.contains('treeItemsHidden'));
    });
    app.eventBus.on('toggleofficialtree',()=>this._toggleAllTreeItems());
  }
  render(trees) {
    const selectedKey=this._currentTreeItem?.dataset.key;
    this.reset();
    const fragment=document.createDocumentFragment();
    const append=(parent,node)=>{
      const row=document.createElement('div');row.className='treeItem';row.dataset.key=node.key;
      const link=document.createElement('a');link.className='ofdOfficialNode';link.href='#';link.textContent=this._normalizeTextContent(node.name);link.title=node.text||node.name;
      link.onclick=event=>{event.preventDefault();this._updateCurrentTreeItem(row);this.onSelect(node);};
      link.oncontextmenu=event=>{event.preventDefault();this._updateCurrentTreeItem(row);this.onContext(event,node);};
      link.onkeydown=event=>{
        const toggle=row.querySelector(':scope > .treeItemToggler');
        if(event.key==='ArrowRight'&&toggle){toggle.classList.remove('treeItemsHidden');event.preventDefault();}
        if(event.key==='ArrowLeft'&&toggle){toggle.classList.add('treeItemsHidden');event.preventDefault();}
        if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const r=link.getBoundingClientRect();this.onContext({clientX:r.left,clientY:r.bottom},node);}
      };
      row.append(link);
      if(node.children.length){this._addToggleButton(row);const group=document.createElement('div');group.className='treeItems';node.children.forEach(n=>append(group,n));row.append(group);}
      parent.append(row);
    };
    trees.forEach(n=>append(fragment,n));
    this.container.classList.toggle('withNesting',!!trees.length);this.container.append(fragment);
    if(selectedKey)this._updateCurrentTreeItem([...this.container.querySelectorAll(".treeItem")].find(n=>n.dataset.key===selectedKey));
  }
}
