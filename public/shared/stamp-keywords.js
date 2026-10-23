import { MAX_STAMPS, movePlacement, validatePlacements } from './stamp-layout.js';

const MM_PER_POINT = 25.4 / 72;
const compact = (value, ignoreWhitespace) => ignoreWhitespace ? value.replace(/\s/gu, '') : value;

// Use the same authored origins/advances and font metrics as the selectable
// text layer. Coordinates are returned in OFD page millimetres, including its
// PhysicalBox origin; viewer zoom and rotation never enter this calculation.
function itemBox(item, styles, pageBox) {
  const [a,b,,,x,y] = item.transform, size = Math.hypot(a,b);
  const {ascent = 1, descent = 0} = styles[item.fontName] || {};
  const dx = a / size, dy = -b / size, ox = x, oy = pageBox[3] / MM_PER_POINT - y;
  const points = [ascent, descent].flatMap(v => [0, item.width].map(w =>
    [ox + dy*v*size + dx*w, oy - dx*v*size + dy*w]));
  if (!size || !points.flat().every(Number.isFinite)) throw Error('关键词的文字坐标无效。');
  const xs = points.map(p=>p[0]*MM_PER_POINT+pageBox[0]), ys = points.map(p=>p[1]*MM_PER_POINT+pageBox[1]);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}

export function findKeywordMatches(content, pageBox, query, ignoreWhitespace = true) {
  const needle = compact(query, ignoreWhitespace);
  if (!needle.trim()) throw Error('请输入需要定位的关键词。');
  let text = '';const spans = [];
  for (const item of content.items) {
    if (!item.str) continue;
    const value = compact(item.str, ignoreWhitespace);
    if (value) {
      spans.push({start:text.length,end:text.length+value.length,item});
      text += value;
    }
    if (item.hasEOL && !ignoreWhitespace) text += '\n';
  }
  const matches=[];let cursor=0, first=0;
  while ((cursor=text.indexOf(needle,cursor))!==-1) {
    if (matches.length>=MAX_STAMPS) throw Error(`关键词匹配超过 ${MAX_STAMPS} 处，请缩小页码范围或使用更具体的关键词。`);
    const end=cursor+needle.length, boxes=[];
    while(first<spans.length && spans[first].end<=cursor)first++;
    for(let i=first;i<spans.length&&spans[i].start<end;i++)boxes.push(itemBox(spans[i].item,content.styles,pageBox));
    if(boxes.length)matches.push({bounds:[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))]});
    cursor=end;
  }
  return matches;
}

export function keywordPlacements(pages, matches, {width,height,anchor,offsetX,offsetY}) {
  if (![width,height,offsetX,offsetY].every(Number.isFinite) || width<1 || height<1) throw Error('印章尺寸或关键词偏移无效（单位毫米）。');
  if (!['center','right','bottom'].includes(anchor)) throw Error('未知关键词落章方向。');
  const placements=matches.map(({page,bounds:b})=>{
    const box=pages[page-1]?.box;
    if(!box || width>box[2] || height>box[3])throw Error(`第 ${page} 页无法容纳该尺寸的印章。`);
    const x=(anchor==='right'?b[2]:(b[0]+b[2]-width)/2)+offsetX;
    const y=(anchor==='bottom'?b[3]:(b[1]+b[3]-height)/2)+offsetY;
    return movePlacement({page,boundary:[x,y,width,height]},box,0,0);
  });
  return validatePlacements(pages,placements);
}
