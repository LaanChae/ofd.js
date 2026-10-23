import {fmt} from './ofd-write-utils.js';

// PDF mesh samples stay in their source space until after interpolation. This
// matters for tint functions: interpolating converted corner RGB is incorrect.
export function meshShading({type,bytes,bc,bv,bf,decode,components,row,convert,color}) {
  if(![1,2,4,8,12,16,24,32].includes(bc)||![1,2,4,8,12,16].includes(bv)||
    (type!==5&&![2,4,8].includes(bf))||decode.length!==4+2*components)
    throw new Error('PDF 网格编码参数无效。');
  let bit=0;
  const read=n=>{if(bit+n>bytes.length*8)throw new Error('PDF 网格数据不完整。');let v=0;for(let j=0;j<n;j++,bit++)v=v*2+((bytes[bit>>3]>>(7-(bit&7)))&1);return v;};
  const point=()=>[0,1].map(i=>decode[2*i]+read(bc)/(2**bc-1)*(decode[2*i+1]-decode[2*i]));
  const values=()=>Array.from({length:components},(_,i)=>decode[4+2*i]+read(bv)/(2**bv-1)*(decode[5+2*i]-decode[4+2*i]));
  const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t),out=[];
  const vertex=(p,c)=>`<ofd:Point X="${fmt(p[0])}" Y="${fmt(p[1])}" EdgeFlag="0">${color(c,true)}</ofd:Point>`;
  function triangle(a,b,c,level=0){
    const mid=(x,y)=>({p:lerp(x.p,y.p,.5),v:lerp(x.v,y.v,.5)});
    const ab=mid(a,b),bc=mid(b,c),ca=mid(c,a),corners=[a,b,c].map(x=>convert(x.v));
    const mids=[ab,bc,ca],curved=mids.some((x,i)=>convert(x.v).some((v,k)=>Math.abs(v-(corners[i][k]+corners[(i+1)%3][k])/2)>1.2/255));
    if(curved){if(level>=10)throw new Error('PDF 网格颜色函数无法在精度限制内转换。');triangle(a,ab,ca,level+1);triangle(ab,b,bc,level+1);triangle(ca,bc,c,level+1);triangle(ab,bc,ca,level+1);}
    else out.push(vertex(a.p,corners[0]),vertex(b.p,corners[1]),vertex(c.p,corners[2]));
    if(out.length>100000)throw new Error('PDF 渐变网格超过十万个顶点。');
  }
  if(type===4||type===5){
    const vertices=[],record=(type===4?bf:0)+2*bc+components*bv;
    let previous,pending=[];
    while(bit+record<=bytes.length*8){
      const flag=type===4?read(bf):0,v={p:point(),v:values()};vertices.push(v);
      if(type===4){
        if(!pending.length&&flag){if(!previous||flag>2)throw new Error('PDF 三角网格边标记无效。');pending=flag===1?[previous[1],previous[2]]:[previous[0],previous[2]];}
        pending.push(v);if(pending.length===3){triangle(...pending);previous=pending;pending=[];}bit=Math.ceil(bit/8)*8;
      }
    }
    if(type===4&&pending.length)throw new Error('PDF 三角网格未闭合。');
    if(type===5){
      if(!Number.isInteger(row)||row<2||vertices.length<2*row||vertices.length%row)throw new Error('PDF 网格行数无效。');
      for(let i=0;i<vertices.length-row;i++)if((i+1)%row){triangle(vertices[i],vertices[i+1],vertices[i+row]);triangle(vertices[i+1],vertices[i+row],vertices[i+row+1]);}
    }
  }else{
    let previous;
    const cubic=(p,t)=>{const s=1-t,w=[s*s*s,3*s*s*t,3*s*t*t,t*t*t];return [0,1].map(k=>p.reduce((v,c,i)=>v+w[i]*c[k],0));};
    while(bytes.length*8-bit>=bf+8*2*bc+2*components*bv){
      const flag=read(bf);if(flag>3||flag&&!previous)throw new Error('PDF 曲面网格边标记无效。');
      const points=flag?Array.from({length:4},(_,i)=>previous.points[(flag*3+i)%12]):[];
      while(points.length<(type===6?12:16))points.push(point());
      const colors=flag?[previous.colors[flag],previous.colors[(flag+1)%4]]:[];
      while(colors.length<4)colors.push(values());
      const at=(u,v)=>{
        let p;
        if(type===6){
          const l=cubic(points.slice(0,4),v),r=cubic([9,8,7,6].map(i=>points[i]),v),t=cubic([0,11,10,9].map(i=>points[i]),u),b=cubic(points.slice(3,7),u);
          p=[0,1].map(k=>(1-u)*l[k]+u*r[k]+(1-v)*t[k]+v*b[k]-((1-u)*(1-v)*points[0][k]+(1-u)*v*points[3][k]+u*v*points[6][k]+u*(1-v)*points[9][k]));
        }else{
          const rows=[[0,11,10,9],[1,12,15,8],[2,13,14,7],[3,4,5,6]];
          p=cubic(rows.map(row=>cubic(row.map(i=>points[i]),u)),v);
        }
        return {p,v:lerp(lerp(colors[0],colors[3],u),lerp(colors[1],colors[2],u),v)};
      };
      // Uniform parameter splits preserve shared patch edges. Select density
      // from control-polygon curvature rather than a fixed output bitmap DPI.
      let curvature=0;
      for(let i=0;i<12;i+=3)for(let k=0;k<2;k++)curvature=Math.max(curvature,Math.hypot(...points[(i+k)%12].map((v,d)=>v-2*points[(i+k+1)%12][d]+points[(i+k+2)%12][d])));
      if(type===7)curvature=Math.max(curvature,...points.slice(12).map(p=>Math.hypot(p[0]-points[0][0],p[1]-points[0][1])));
      const n=Math.max(8,Math.min(96,Math.ceil(Math.sqrt(curvature/.01))));
      const grid=Array.from({length:n+1},(_,y)=>Array.from({length:n+1},(_,x)=>at(x/n,y/n)));
      for(let y=0;y<n;y++)for(let x=0;x<n;x++){triangle(grid[y][x],grid[y][x+1],grid[y+1][x]);triangle(grid[y][x+1],grid[y+1][x],grid[y+1][x+1]);}
      previous={points,colors};
    }
  }
  if(out.length<3)throw new Error('PDF 渐变网格没有有效三角形。');
  return `<ofd:GouraudShd>${out.join('')}</ofd:GouraudShd>`;
}
