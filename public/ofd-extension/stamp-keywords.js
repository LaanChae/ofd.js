import {parsePageRange, MAX_STAMPS} from '../shared/stamp-layout.js';
import {keywordPlacements} from '../shared/stamp-keywords.js';

export function mountStampKeywords(host, changed, navigate) {
  host.className='ofdForm';
  host.innerHTML=`
    <label>关键词<input id="ofdStampKeyword" type="text" placeholder="例如：签章处" maxlength="200"></label>
    <label class="ofdCheck"><input id="ofdStampKeywordWhitespace" type="checkbox" checked>忽略空白及换行</label>
    <div class="actions"><button id="ofdStampKeywordSearch" type="button">查找关键词</button><button id="ofdStampKeywordCancel" type="button" hidden>停止查找</button><button id="ofdStampKeywordAll" type="button">全选结果</button><button id="ofdStampKeywordNone" type="button">取消选择</button></div>
    <p id="ofdStampKeywordStatus" role="status" aria-live="polite"></p>
    <ol id="ofdStampKeywordResults" aria-label="关键词匹配结果"></ol>
    <label>印章相对文字位置<select id="ofdStampKeywordAnchor"><option value="center">覆盖文字中心</option><option value="right">文字右侧</option><option value="bottom">文字下方</option></select></label>
    <label>水平偏移（毫米）<input id="ofdStampKeywordDX" type="number" step="any" value="0"></label>
    <label>垂直偏移（毫米）<input id="ofdStampKeywordDY" type="number" step="any" value="0"></label>
    <p class="ofdMuted">按原始文档文字精确查找，区分大小写；图片中的文字需先识别。正偏移向右／向下。超出页边时将印章移入页内。选中结果后点击“添加到签署位置”，再逐个拖动微调。</p>`;
  const $=id=>host.querySelector('#'+id),status=$('ofdStampKeywordStatus');
  let pages=[],readMatches,range='',results=[],revision=0,searching=false;
  const selected=()=>results.filter(r=>r.selected);
  function controls() {
    $('ofdStampKeywordSearch').disabled=searching||!readMatches;
    $('ofdStampKeywordCancel').hidden=!searching;
    $('ofdStampKeywordAll').disabled=searching||!results.length;
    $('ofdStampKeywordNone').disabled=searching||!results.length;
  }
  function list() {
    $('ofdStampKeywordResults').replaceChildren();
    results.forEach((match,i)=>{
      const row=document.createElement('li'), label=document.createElement('label'),check=document.createElement('input'),go=document.createElement('button');
      label.className='ofdCheck';check.type='checkbox';check.checked=match.selected;check.setAttribute('aria-label',`选择第 ${i+1} 个匹配`);
      check.onchange=()=>{match.selected=check.checked;changed();};
      go.type='button';go.className='secondaryButton';
      go.textContent=`第 ${match.page} 页 · 匹配 ${i+1}`;
      go.onclick=()=>navigate(match.page);
      label.append(check);row.append(label,go);$('ofdStampKeywordResults').append(row);
    });
    controls();changed();
  }
  function invalidate() {
    revision++;searching=false;results=[];status.textContent='请查找关键词。';list();
  }
  $('ofdStampKeyword').oninput=invalidate;
  $('ofdStampKeywordWhitespace').onchange=invalidate;
  $('ofdStampKeyword').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(!searching)$('ofdStampKeywordSearch').click();}};
  $('ofdStampKeywordCancel').onclick=invalidate;
  $('ofdStampKeywordSearch').onclick=async()=>{
    const ticket=++revision,query=$('ofdStampKeyword').value,ignoreWhitespace=$('ofdStampKeywordWhitespace').checked;
    results=[];searching=true;list();
    try {
      if(!query.trim())throw Error('请输入需要定位的关键词。');
      const chosen=parsePageRange(range,pages.length), found=[];
      for(const [i,page] of chosen.entries()) {
        status.textContent=`正在查找第 ${page} 页（${i+1} / ${chosen.length}）…`;
        const matches=await readMatches(page-1,query,ignoreWhitespace);
        if(ticket!==revision)return;
        if(found.length+matches.length>MAX_STAMPS)throw Error(`关键词匹配超过 ${MAX_STAMPS} 处，请缩小页码范围或使用更具体的关键词。`);
        found.push(...matches.map(match=>({...match,page,selected:true})));
      }
      results=found;
      status.textContent=results.length?`找到 ${results.length} 处匹配；可取消勾选不需要的结果。`:'没有找到匹配文字；请核对关键词和页码范围。扫描图片中的文字无法直接定位。';
      if(results.length)navigate(results[0].page);
    } catch(error) {if(ticket===revision)status.textContent=`查找失败：${error.message}`;}
    finally{if(ticket===revision){searching=false;list();}}
  };
  for(const [id,value] of [['ofdStampKeywordAll',true],['ofdStampKeywordNone',false]])$(id).onclick=()=>{results.forEach(r=>r.selected=value);list();};
  for(const id of ['ofdStampKeywordAnchor','ofdStampKeywordDX','ofdStampKeywordDY'])$(id).oninput=()=>{results.forEach(r=>delete r.moved);changed();};
  controls();
  return {
    setDocument(value,reader){pages=value;readMatches=reader;range='';invalidate();},
    setRange(value){if(value!==range){range=value;invalidate();}},
    resetMoves(){results.forEach(r=>delete r.moved);},
    move(index,placement){const result=selected()[index];if(result)result.moved=placement;},
    matches: selected,
    plan(width,height){
      if(searching)throw Error('正在查找关键词，请稍候。');
      const matches=selected();
      if(!matches.length)throw Error('请查找关键词并选择需要盖章的匹配结果。');
      const placed=keywordPlacements(pages,matches,{width,height,anchor:$('ofdStampKeywordAnchor').value,offsetX:Number($('ofdStampKeywordDX').value),offsetY:Number($('ofdStampKeywordDY').value)});
      return placed.map((p,i)=>matches[i].moved||p);
    },
  };
}
