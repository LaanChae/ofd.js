import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as m from 'mupdf';
import * as asn from 'asn1js';
import * as fontkit from 'fontkit';
import {zipSync, strToU8} from 'fflate';
import {createFontChunks, ChunkedFont, glyphComponents} from '../src/engine/font-chunks.js';
import {bundledFonts} from '../src/engine/font-catalog.js';
import {FontStore} from '../src/engine/fonts.js';
import {loadBundledFonts} from '../src/engine/bundled-fonts.js';
import {OfdDocument} from '../src/engine/document.js';
import {DirectDocument} from '../src/engine/direct-document.js';
import {ofdToPdf} from '../src/engine/render.js';

const assets = new Map();
function asset(id) {
  if (!assets.has(id)) {
    const descriptor = bundledFonts.find(f => f.id === id);
    const bytes = fs.readFileSync(`public/fonts/${descriptor.file}`);
    assets.set(id, {bytes, ...createFontChunks(bytes)});
  }
  return assets.get(id);
}
function bundle(id) {
  const data = asset(id), requests = [];
  const font = new ChunkedFont(data.index, async path => {
    requests.push(path);
    assert.equal(path.split('/')[0], data.revision);
    return data.chunks[Number(path.split('/')[1].split('.')[0])];
  });
  return {font, requests, data};
}
function renderGlyph(bytes, code, size) {
  const font = new m.Font('GlyphTest', bytes), text = new m.Text();
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0,0,100,100], false), dev = new m.DrawDevice(m.Matrix.identity,pix);
  try {
    pix.clear(255);text.showGlyph(font,[size,0,0,-size,8,80],font.encodeCharacter(code),code);
    dev.fillText(text,m.Matrix.identity,m.ColorSpace.DeviceRGB,[0,0,0],1);dev.close();
    return pix.getPixels().slice();
  } finally {dev.destroy();pix.destroy();text.destroy();font.destroy();}
}
const codes = text => new Set(Array.from(text,c=>c.codePointAt(0)));
for (const descriptor of bundledFonts) test(`${descriptor.name}: incremental original glyphs, widths and raster output`, async () => {
  const {font,requests,data} = bundle(descriptor.id);
  const source = fontkit.create(data.bytes), characters = codes('中国文件 Aéǻ');
  const native = new m.Font(descriptor.name, data.bytes);
  try { for (const code of source.characterSet) assert.equal(source.glyphForCodePoint(code).id, native.encodeCharacter(code)); } finally { native.destroy(); }
  const supplementary = source.characterSet.find(code=>code>0xffff);
  if (supplementary) characters.add(supplementary);
  const partial = await font.ensure(characters), parsed = fontkit.create(partial);
  for (const code of characters) {
    const original = source.glyphForCodePoint(code), actual = parsed.glyphForCodePoint(code);
    assert.equal(actual.id,original.id);assert.equal(actual.advanceWidth,original.advanceWidth);
    for (const size of [9,12,36]) assert.deepEqual(renderGlyph(partial,code,size),renderGlyph(data.bytes,code,size),`${descriptor.name} U+${code.toString(16)} at ${size}px`);
    for (const dep of glyphComponents(font.glyphBytes(original.id))) assert.ok(font.loadedGlyphs.has(dep));
  }
  const received = data.index.length + requests.reduce((n,path)=>n+data.chunks[Number(path.split('/')[1].split('.')[0])].length,0);
  assert.ok(received<data.bytes.length/10, `${received} / ${data.bytes.length}`);
  assert.ok(partial.length<data.bytes.length/3);
  const before=requests.length;
  assert.equal(await font.ensure(characters),null);assert.equal(requests.length,before);
  const extended=await font.ensure(codes('新增字符测试'));
  assert.ok(extended);assert.ok(requests.length>before);
  for(const code of characters) assert.deepEqual(renderGlyph(extended,code,12),renderGlyph(partial,code,12));
  console.log(`${descriptor.name}: ${received} bytes initially vs ${data.bytes.length} full`);
});

const ns='xmlns:ofd="http://www.ofdspec.org/2016"';
const text=(id,value,font='10')=>`<ofd:TextObject ID="${id}" Font="${font}" Size="5" Boundary="10 ${id} 80 15"><ofd:TextCode X="0" Y="8" DeltaX="5">${value}</ofd:TextCode></ofd:TextObject>`;
function fixture({embedded=false, complex=false}={}) {
  const files={
    'OFD.xml':`<ofd:OFD ${ns} Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocRoot>Doc.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
    'Doc.xml':`<ofd:Document ${ns}><ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 100 100</ofd:PhysicalBox></ofd:PageArea><ofd:PublicRes>Res.xml</ofd:PublicRes>${complex?'<ofd:TemplatePage ID="20" BaseLoc="Template.xml"/>':''}</ofd:CommonData><ofd:Pages><ofd:Page ID="1" BaseLoc="P1.xml"/><ofd:Page ID="2" BaseLoc="P2.xml"/></ofd:Pages>${complex?'<ofd:Annotations>Annotations.xml</ofd:Annotations>':''}</ofd:Document>`,
    'Res.xml':`<ofd:Res ${ns} BaseLoc="."><ofd:Fonts><ofd:Font ID="10" FontName="SimSun">${embedded?'<ofd:FontFile>font.ttf</ofd:FontFile>':''}</ofd:Font><ofd:Font ID="11" FontName="KaiTi"/></ofd:Fonts><ofd:DrawParams><ofd:DrawParam ID="41"><ofd:FillColor><ofd:Pattern Width="10" Height="10"><ofd:CellContent>${text(44,'底纹')}</ofd:CellContent></ofd:Pattern></ofd:FillColor></ofd:DrawParam><ofd:DrawParam ID="40" Relative="41"/></ofd:DrawParams><ofd:CompositeGraphicUnits><ofd:CompositeGraphicUnit ID="42" Width="100" Height="100"><ofd:Content>${text(45,'复合')}</ofd:Content></ofd:CompositeGraphicUnit><ofd:CompositeGraphicUnit ID="43" Width="100" Height="100"><ofd:Content>${text(46,'不用','11')}</ofd:Content></ofd:CompositeGraphicUnit></ofd:CompositeGraphicUnits></ofd:Res>`,
    'P1.xml':`<ofd:Page ${ns}>${complex?'<ofd:Template TemplateID="20"/>':''}<ofd:Content><ofd:Layer ID="3">${text(4,'中国 Aé')}${complex?'<ofd:CompositeObject ID="47" Boundary="0 0 100 100" ResourceID="42"/><ofd:PathObject ID="48" Boundary="0 0 10 10" DrawParam="40"><ofd:Clips><ofd:Clip><ofd:Area><ofd:Text Font="10" Size="5"><ofd:TextCode X="0" Y="5">裁剪</ofd:TextCode></ofd:Text></ofd:Area></ofd:Clip></ofd:Clips><ofd:AbbreviatedData>M 0 0 L 10 10</ofd:AbbreviatedData></ofd:PathObject>':''}</ofd:Layer></ofd:Content></ofd:Page>`,
    'P2.xml':`<ofd:Page ${ns}><ofd:Content><ofd:Layer ID="6">${text(7,'后页新增')}</ofd:Layer></ofd:Content></ofd:Page>`,
    'Template.xml':`<ofd:Page ${ns}><ofd:Content><ofd:Layer ID="21">${text(22,'模板')}</ofd:Layer></ofd:Content></ofd:Page>`,
    'Annotations.xml':`<ofd:Annotations ${ns}><ofd:Page PageID="1"><ofd:FileLoc>Annot.xml</ofd:FileLoc></ofd:Page></ofd:Annotations>`,
    'Annot.xml':`<ofd:PageAnnot ${ns}><ofd:Annot ID="31" Type="Stamp"><ofd:Appearance Boundary="0 0 100 100">${text(32,'注释')}</ofd:Appearance></ofd:Annot></ofd:PageAnnot>`,
  };
  const zip=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,strToU8(v)]));
  if(embedded)zip['font.ttf']=asset('windows-simsun').bytes;
  return new OfdDocument(zipSync(zip));
}
function mockFetch(t) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{
    const path=url.pathname.split('/fonts/')[1];requests.push(path);
    const [id,,file]=path.split('/'),data=asset(id);
    return new Response(path.endsWith('/index.zip')?data.index:data.chunks[Number(file.split('.')[0])]);
  });
  return requests;
}
test('only loaded page dependencies, including templates, clips, patterns, annotations and composites',async t=>{
  const requests=mockFetch(t),doc=fixture({complex:true}),store=new FontStore();
  try {
    await loadBundledFonts(doc,store);assert.equal(requests.length,0);
    doc.page(0);
    const chars=doc.fontCharacters.get('10');
    for(const code of codes('中国 Aé模板裁剪底纹复合注释'))assert.ok(chars.has(code));
    assert.ok(!doc.fontCharacters.has('11'));assert.ok(!chars.has('后'.codePointAt(0)));
    await loadBundledFonts(doc,store);
    assert.ok(requests.every(path=>path.startsWith('windows-simsun/')));
    const before=requests.length;await loadBundledFonts(doc,store);assert.equal(requests.length,before);
    doc.page(1);await loadBundledFonts(doc,store);assert.ok(requests.length>before);
  }finally{store.destroy();}
});

test('preview, PDF export with subsetting on/off and text extraction match complete fonts after incremental loading',async t=>{
  mockFetch(t);const doc=fixture(),store=new FontStore(),full=new FontStore();let direct,reference;
  try{
    full.import(asset('windows-simsun').bytes,'windows-simsun');
    doc.page(0);await loadBundledFonts(doc,store);direct=new DirectDocument(doc,store);reference=new DirectDocument(doc,full);
    const matrix=[2,0,0,2,0,0],width=567,height=567;
    const first=direct.render(0,matrix,width,height).pixels;
    assert.deepEqual(first,reference.render(0,matrix,width,height).pixels);
    assert.match(direct.textContent(0).items.map(i=>i.str).join(''),/中国 Aé/);
    doc.page(1);await loadBundledFonts(doc,store);direct.destroy();direct=new DirectDocument(doc,store);
    assert.deepEqual(first,direct.render(0,matrix,width,height).pixels);
    assert.deepEqual(direct.render(1,matrix,width,height).pixels,reference.render(1,matrix,width,height).pixels);
    for(const subsetFonts of [true,false]){
      const output=ofdToPdf(doc,store,{},()=>{},{subsetFonts}),baseline=ofdToPdf(doc,full,{},()=>{},{subsetFonts});
      const a=m.Document.openDocument(output.bytes,'application/pdf'),b=m.Document.openDocument(baseline.bytes,'application/pdf');
      try{
        for(let i=0;i<2;i++){
          const page=a.loadPage(i),other=b.loadPage(i),pix=page.toPixmap(matrix,m.ColorSpace.DeviceRGB,false),expected=other.toPixmap(matrix,m.ColorSpace.DeviceRGB,false),text=page.toStructuredText();
          try{assert.deepEqual(pix.getPixels(),expected.getPixels());assert.match(text.asText().replace(/\s/g,''),i===0?/中国Aé/:/后页新增/);}finally{text.destroy();pix.destroy();expected.destroy();page.destroy();other.destroy();}
        }
      }finally{a.destroy();b.destroy();}
    }
  }finally{direct?.destroy();reference?.destroy();store.destroy();full.destroy();}
});

test('embedded and imported fonts skip network; manual replacement requests only the selected family',async t=>{
 const requests=mockFetch(t),doc=fixture({embedded:true}),store=new FontStore();
 try{
  doc.page(0);await loadBundledFonts(doc,store);assert.equal(requests.length,0);
  const local=fixture();local.page(0);store.import(asset('windows-simsun').bytes);await loadBundledFonts(local,store);assert.equal(requests.length,0);
  await loadBundledFonts(doc,store,{'10':'windows-kaiti'});assert.ok(requests.every(p=>p.startsWith('windows-kaiti/')));
  const output=ofdToPdf(doc,store,{'10':'windows-kaiti'});assert.ok(output.bytes.length>1000);
 }finally{store.destroy();}
});

test('missing or damaged chunks fail visibly and a subsequent attempt can retry',async()=>{
 const data=asset('windows-simsun');let fail=true;
 const font=new ChunkedFont(data.index,async path=>{if(fail)throw Error('HTTP 404');return data.chunks[Number(path.split('/')[1].split('.')[0])];});
 await assert.rejects(font.ensure(codes('中')),/404/);assert.equal(font.installed,false);
 fail=false;assert.ok(await font.ensure(codes('中')));
 const damaged=new ChunkedFont(data.index,async()=>new Uint8Array([1,2,3]));
 await assert.rejects(damaged.ensure(codes('中')));
});


test('nested OFD seals load their own unembedded glyphs and retain clipped placements', async t => {
  const requests=mockFetch(t), outer=Object.fromEntries(fixture().archive.materialize()), inner=Object.fromEntries(fixture().archive.materialize());
  inner['Res.xml']=strToU8(new TextDecoder().decode(inner['Res.xml']).replace('FontName="SimSun"','FontName="KaiTi"'));
  inner['P1.xml']=strToU8(new TextDecoder().decode(inner['P1.xml']).replace('中国 Aé','印章专用'));
  const seq=(...value)=>new asn.Sequence({value});
  const picture=seq(new asn.IA5String({value:'ofd'}),new asn.OctetString({valueHex:zipSync(inner)}));
  outer['Value.dat']=new Uint8Array(seq(seq(new asn.Integer({value:4}),seq(seq(seq(),seq(),seq(),picture)))).toBER(false));
  outer['OFD.xml']=strToU8(new TextDecoder().decode(outer['OFD.xml']).replace('</ofd:DocBody>','<ofd:Signatures>Signs.xml</ofd:Signatures></ofd:DocBody>'));
  outer['Signs.xml']=strToU8(`<ofd:Signatures ${ns}><ofd:Signature ID="s1" BaseLoc="Signature.xml"/></ofd:Signatures>`);
  outer['Signature.xml']=strToU8(`<ofd:Signature ${ns}><ofd:SignedInfo><ofd:StampAnnot ID="s2" PageRef="1" Boundary="10 30 40 40"/><ofd:StampAnnot ID="s3" PageRef="1" Boundary="50 30 40 40" Clip="20 0 20 40"/></ofd:SignedInfo><ofd:SignedValue>Value.dat</ofd:SignedValue></ofd:Signature>`);
  const doc=new OfdDocument(zipSync(outer)),store=new FontStore(),full=new FontStore();let direct,reference;
  try {
    doc.page(0);await loadBundledFonts(doc,store);
    assert.ok(requests.some(path=>path.startsWith('windows-kaiti/')));
    for(const id of ['windows-simsun','windows-kaiti'])full.import(asset(id).bytes,id);
    direct=new DirectDocument(doc,store);reference=new DirectDocument(doc,full);
    const matrix=[2,0,0,2,0,0];
    assert.deepEqual(direct.render(0,matrix,567,567).pixels,reference.render(0,matrix,567,567).pixels);
    const bytes=ofdToPdf(doc,store).bytes,other=ofdToPdf(doc,full).bytes;
    const pdf=m.Document.openDocument(bytes,'application/pdf'),baseline=m.Document.openDocument(other,'application/pdf');
    const page=pdf.loadPage(0),expected=baseline.loadPage(0),pixels=page.toPixmap(matrix,m.ColorSpace.DeviceRGB,false),target=expected.toPixmap(matrix,m.ColorSpace.DeviceRGB,false);
    try{assert.deepEqual(pixels.getPixels(),target.getPixels());}finally{pixels.destroy();target.destroy();page.destroy();expected.destroy();pdf.destroy();baseline.destroy();}
  }finally{direct?.destroy();reference?.destroy();store.destroy();full.destroy();}
});
