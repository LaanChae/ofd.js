// PDF one-input color functions. Return explicit breakpoints so stitching
// boundaries (including discontinuities) are never hidden by adaptive sampling.
export function colorFunction(spec, depth = 0) {
  if (depth > 32) throw new Error('PDF 颜色函数嵌套过深。');
  if (Array.isArray(spec)) {
    const functions = spec.map(f => colorFunction(f, depth + 1));
    return { breaks: functions.flatMap(f => f.breaks), approximate: functions.some(f => f.approximate),
      at: x => functions.flatMap(f => f.at(x)) };
  }
  const domain = spec.Domain || [0, 1];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let at, breaks = [...domain], approximate = false;
  if (spec.FunctionType === 2) {
    const from = spec.C0 || [0], to = spec.C1 || [1], exponent = spec.N;
    if (!Number.isFinite(exponent) || from.length !== to.length) throw new Error('PDF 指数颜色函数无效。');
    at = x => from.map((v, i) => v + (to[i] - v) * x ** exponent);
    approximate = exponent !== 1;
  } else if (spec.FunctionType === 3) {
    const functions = spec.Functions.map(f => colorFunction(f, depth + 1)), bounds = [domain[0], ...(spec.Bounds || []), domain[1]], encode = spec.Encode;
    if (bounds.length !== functions.length + 1 || encode.length !== 2 * functions.length || bounds.some((v,i)=>i && v<=bounds[i-1])) throw new Error('PDF 分段颜色函数无效。');
    breaks = [...bounds];
    functions.forEach((f,i)=>{for(const x of f.breaks){const t=(x-encode[2*i])/(encode[2*i+1]-encode[2*i]);if(t>0&&t<1)breaks.push(bounds[i]+t*(bounds[i+1]-bounds[i]));}});
    approximate = functions.some(f => f.approximate);
    at = x => {
      let i = 0; while(i < functions.length-1 && x >= bounds[i+1]) i++;
      return functions[i].at(encode[2*i] + (x-bounds[i])/(bounds[i+1]-bounds[i])*(encode[2*i+1]-encode[2*i]));
    };
  } else if (spec.FunctionType === 0) {
    const size=spec.Size?.[0],bits=spec.BitsPerSample,range=spec.Range,decode=spec.Decode||range,encode=spec.Encode||[0,size-1],data=spec.samples;
    if(spec.Size?.length!==1||!Number.isInteger(size)||size<1||size>65536||!range||!data||![1,2,4,8,12,16,24,32].includes(bits)||(spec.Order||1)!==1)throw new Error('PDF 采样颜色函数的维度或插值方式尚未实现。');
    const count=range.length/2, samples=[];let bit=0;
    if(size*count*bits>data.length*8)throw new Error('PDF 采样颜色函数数据不完整。');
    for(let n=0;n<size;n++)samples.push(Array.from({length:count},(_,i)=>{let v=0;for(let b=0;b<bits;b++,bit++)v=v*2+((data[bit>>3]>>(7-(bit&7)))&1);return decode[2*i]+v/(2**bits-1)*(decode[2*i+1]-decode[2*i]);}));
    for(let i=0;i<size;i++){const x=domain[0]+(i-encode[0])/(encode[1]-encode[0])*(domain[1]-domain[0]);if(x>domain[0]&&x<domain[1])breaks.push(x);}
    at=x=>{const t=clamp(encode[0]+(x-domain[0])/(domain[1]-domain[0])*(encode[1]-encode[0]),0,size-1),i=Math.floor(t),j=Math.min(i+1,size-1);return samples[i].map((v,k)=>v+(samples[j][k]-v)*(t-i));};
  } else throw new Error(`PDF FunctionType ${spec.FunctionType} 尚不能转换为原生色标。`);
  return { breaks, approximate, at(x) {
    const values = at(clamp(x, domain[0], domain[1]));
    if (values.some(v=>!Number.isFinite(v))) throw new Error('PDF 颜色函数产生非有限数值。');
    return values.map((v,i)=>spec.Range ? clamp(v,spec.Range[i*2],spec.Range[i*2+1]) : v);
  }};
}

export function functionStops(fn, domain, tolerance=1/2048) {
  const [a,b]=domain;
  if (!(b>a)) throw new Error('PDF 渐变函数定义域无效。');
  const knots=[...new Set([a,...fn.breaks.filter(x=>x>a&&x<b),b])].sort((a,b)=>a-b), stops=[];
  function add(x,y,colorA,colorB,depth=0){
    if(stops.length>4096)throw new Error('PDF 颜色函数需要过多色标。');
    const checks=[0.25,0.5,0.75];
    const curved=checks.some(t=>fn.at(x+(y-x)*t).some((v,i)=>Math.abs(v-(colorA[i]+(colorB[i]-colorA[i])*t))>tolerance));
    if(curved&&depth<16){const mid=(x+y)/2,cm=fn.at(mid);add(x,mid,colorA,cm,depth+1);add(mid,y,cm,colorB,depth+1);}
    else {if(curved)throw new Error('PDF 颜色函数无法在精度限制内转换。');stops.push({position:(x-a)/(b-a),values:colorA});}
  }
  for(let i=1;i<knots.length;i++){
    const x=knots[i-1],y=knots[i],end=fn.at(i===knots.length-1?y:y-(y-x)*1e-10);
    add(x,y,fn.at(x),end);stops.push({position:(y-a)/(b-a),values:end});
  }
  return stops.filter((s,i)=>!i || s.position!==stops[i-1].position || s.values.some((v,j)=>Math.abs(v-stops[i-1].values[j])>1e-8));
}
