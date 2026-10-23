export const metadataFields = [
  ['DocID','文档标识'], ['Title','标题'], ['Author','作者'], ['Subject','主题'],
  ['Abstract','摘要'], ['CreationDate','创建日期'], ['ModDate','修改日期'],
  ['DocUsage','文档用途'], ['Cover','封面路径'], ['Creator','生成软件'],
  ['CreatorVersion','生成软件版本'],
];
export function metadataText(value) {
  if(typeof value!=='string'||value.length>100000||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/u.test(value))throw Error('元数据包含无效字符或超过 100000 个字符。');
  return value;
}
export function validateMetadataField(key,value) {
  metadataText(value);
  if(!metadataFields.some(([name])=>name===key))throw Error(`未知文档属性：${key}`);
  if(key==='DocID'&&!value.trim())throw Error('文档标识不能为空。');
  if(['CreationDate','ModDate'].includes(key)&&value) {
    const match=/^(\d{4})-(\d{2})-(\d{2})(Z|[+-](\d{2}):(\d{2}))?$/.exec(value);
    const year=Number(match?.[1]),month=Number(match?.[2]),day=Number(match?.[3]),hours=Number(match?.[5]||0),minutes=Number(match?.[6]||0);
    const leap=year%4===0&&(year%100!==0||year%400===0);
    if(!match||!year||month<1||month>12||day<1||day>[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]||hours>14||minutes>59||(hours===14&&minutes))throw Error('日期应为有效的 YYYY-MM-DD，可带 Z 或 ±hh:mm 时区。');
  }
}
