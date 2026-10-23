// GB/T 33480—2016 short names; GB/T 33476.1 structure leaf paths.
export const OFFICIAL_NS = 'http://www.nits.org.cn/eGovDoc/2013';
export const officialFields = [
  ['GWBS','公文标识',true],['WZ','文种'],['FH','份号'],['MJHBMQX','密级和保密期限',true],
  ['JJCD','紧急程度'],['FWJGBZ','发文机关标志'],['FWZH','发文字号'],['QFR','签发人'],
  ['BT','标题',true],['ZSJG','主送机关'],['FJSM','附件说明'],['FWJGSM','发文机关或签发人署名'],
  ['CWRQ','成文日期',true],['FZ','附注'],['CSJG','抄送机关'],['YFJG','印发机关'],['YFRQ','印发日期'],['FBCC','发布层次'],
].map(([key,label,required=false])=>({key,label,required}));
export const semanticFields = [
  ['版头/份号','FH'],['版头/密级和保密期限/密级'],['版头/密级和保密期限/保密期限'],['版头/紧急程度','JJCD'],
  ['版头/发文机关标志/发文机关名称'],['版头/发文机关标志/标志'],
  ['版头/发文字号/发文机关代字'],['版头/发文字号/年份'],['版头/发文字号/发文顺序号'],['版头/签发人','QFR'],
  ['主体/标题','BT'],['主体/主送机关','ZSJG'],['主体/正文'],['主体/附件说明','FJSM'],
  ['主体/发文机关或签发人署名/发文机关署名','FWJGSM'],['主体/发文机关或签发人署名/签发人职务'],
  ['主体/成文日期','CWRQ'],['主体/附注','FZ'],['主体/附件/标题'],['主体/附件/正文'],
  ['版记/主送机关','ZSJG'],['版记/抄送机关','CSJG'],['版记/印发机关和印发日期/印发机关','YFJG'],['版记/印发机关和印发日期/印发日期','YFRQ'],
].map(([path,key])=>({path,key,label:path.replaceAll('/',' · ')}));
export function officialIdError(value) {
  const match=/^1\.2\.156\.10\.([0-9A-Z]{18})-([0-9A-Z]{3})-([0-9]{4})-([0-9A-Z]{2})-([0-9A-Z]{5})-([0-9A-Z])$/.exec(value);
  if(!match)return '应为 1.2.156.10.统一社会信用代码-内设机构代码-年份-代字编码-流水号-校验位（字母大写）。';
  let product=36;
  for(const c of match.slice(1,-1).join(''))product=((product+parseInt(c,36))%36||36)*2%37;
  if((product+parseInt(match.at(-1),36))%36!==1)return '公文标识校验位不符合 MOD 37,36。';
  return '';
}
function dateError(value) {
  const m=/^([1-9]\d{3})年([1-9]|1[0-2])月([1-9]|[12]\d|3[01])日$/.exec(value);
  if(!m)return '应使用 YYYY年M月D日，月、日不补零。';
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  return d.getUTCMonth()!==+m[2]-1?'日期不存在。':'';
}
export function validateOfficialMetadata(entries) {
  const issues=[],values={};
  const add=(field,message,severity='error')=>issues.push({field,message,severity});
  for(const {name,value} of entries) {
    if(!officialFields.some(f=>f.key===name))continue;
    if(Object.hasOwn(values,name))add(name,'同名公文元数据重复。');
    values[name]=String(value).trim();
  }
  for(const f of officialFields) {
    const v=values[f.key];
    if(!v){if(f.required)add(f.key,`${f.label}为必填项。`);continue;}
    let error='';
    switch(f.key) {
      case 'GWBS':error=officialIdError(v);break;
      case 'FH':if(!/^\d{6}$/.test(v)||Number(v)===0)error='份号应为六位数字表示的正整数。';break;
      case 'CWRQ':case 'YFRQ':error=dateError(v);break;
      case 'WZ':if(!['决议','决定','命令','令','命令（令）','命令(令)','公报','公告','通告','意见','通知','通报','报告','请示','批复','议案','函','纪要','其他'].includes(v))error='文种不在规范规定的值域中。';break;
      case 'JJCD':if(!['特提','特急','加急','平急','无'].includes(v))error='应为特急、加急、无；电报还可使用特提、平急。';break;
      case 'MJHBMQX':if(/[☆|]/.test(v)||!/^(无|(?:绝密|机密|秘密)(?:\s*★?\s*[^★]+)?)$/.test(v))error='应以绝密、机密、秘密或无表示密级，期限在后，分隔符使用 ★。';break;
      case 'FWZH':if(!/^.+〔\d{4}〕\s*[1-9]\d*\s*号$/.test(v))error='应包含机关代字、六角括号中的四位年份及正整数顺序号，例如某发〔2026〕1号。';break;
      case 'QFR':case 'ZSJG':case 'CSJG':case 'FJSM':if(v.split('^').some(x=>!x.trim()))error='多值使用 ^ 分隔，不能包含空项。';break;
    }
    if(error)add(f.key,error);
  }
  for(const field of ['FH','JJCD','FWZH'])if(!values[field])add(field,'规范建议设置此项。','warning');
  return issues;
}
