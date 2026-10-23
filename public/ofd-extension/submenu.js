// Native PDF.js popup appearance; kept outside the scrollable toolbar so the
// second level is not clipped. Closing the parent always closes this menu.
export function mountSubmenu(app,trigger,items) {
  const menu=document.createElement('menu');menu.id=`${trigger.id}Menu`;menu.className='popupMenu ofdSubmenu';menu.hidden=true;menu.setAttribute('role','menu');menu.setAttribute('aria-labelledby',trigger.id);
  for(const item of items){item.setAttribute('role','menuitem');menu.append(item);}
  document.body.append(menu);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-controls',menu.id);trigger.setAttribute('aria-expanded','false');
  let timer;
  function close(focus=false){clearTimeout(timer);menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();}
  function open(focus=false){
    clearTimeout(timer);if(trigger.disabled||trigger.hidden||!app.secondaryToolbar.isOpen)return;
    menu.hidden=false;trigger.setAttribute('aria-expanded','true');
    const b=trigger.getBoundingClientRect(),m=menu.getBoundingClientRect();
    const left=b.left>=m.width+8?b.left-m.width-4:Math.min(innerWidth-m.width-8,b.right+4);
    menu.style.left=`${Math.max(8,left)}px`;menu.style.top=`${Math.max(8,Math.min(b.top,innerHeight-m.height-8))}px`;
    if(focus)items.find(n=>!n.disabled&&!n.hidden)?.focus();
  }
  trigger.onclick=()=>open();
  trigger.addEventListener('pointerenter',()=>open());
  for(const node of [trigger,menu]){node.addEventListener('pointerenter',()=>clearTimeout(timer));node.addEventListener('pointerleave',()=>{timer=setTimeout(()=>close(),250);});}
  trigger.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();open(true);}});
  menu.addEventListener('keydown',event=>{
    if(['Escape','ArrowLeft'].includes(event.key)){event.preventDefault();event.stopPropagation();close(true);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();event.stopPropagation();const enabled=items.filter(n=>!n.disabled&&!n.hidden),index=enabled.indexOf(document.activeElement);
      const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowDown'?1:enabled.length-1))%enabled.length;enabled[next]?.focus();
    }
  });
  menu.addEventListener('click',event=>{if(event.target.closest('button:not(:disabled)')){close();app.secondaryToolbar.close();}},true);
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&!trigger.contains(event.target))close();});
  document.addEventListener('focusin',event=>{if(!menu.contains(event.target)&&!trigger.contains(event.target))close();});
  const observer=new MutationObserver(()=>{if(!app.secondaryToolbar.isOpen||trigger.hidden||trigger.disabled)close();});
  observer.observe(document.getElementById('secondaryToolbarToggleButton'),{attributes:true,attributeFilter:['aria-expanded']});observer.observe(trigger,{attributes:true,attributeFilter:['hidden','disabled']});
  document.getElementById('secondaryToolbarButtonContainer').addEventListener('scroll',()=>close());window.addEventListener('resize',()=>close());window.addEventListener('blur',()=>close());
  app.eventBus.on('pagesdestroy',()=>close());
}
