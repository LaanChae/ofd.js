// PDF date strings and xs:dateTime have different precision and zone syntax.
// Read/write their fields directly: MuPDF's JS file-parameter API truncates
// seconds to signed 32 bits and cannot represent all legal attachment dates.
export function ofdDateTimeToPdf(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  // xs:dateTime permits 24:00:00, while PDF hours stop at 23.
  if(match[4]==="24") {
    if(match[5]!=="00"||match[6]!=="00"||/\.\d*[1-9]/.test(value))return null;
    const next=new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if(!Number.isFinite(next.getTime()))return null;
    next.setUTCDate(next.getUTCDate()+1);
    if(next.getUTCFullYear()>9999)return null;
    [match[1],match[2],match[3]]=next.toISOString().slice(0,10).split('-');match[4]='00';
  }
  const zone = match[7] || "";
  return `D:${match.slice(1,7).join("")}${zone === "Z" || !zone ? zone : `${zone.slice(0,3)}'${zone.slice(4)}'`}`;
}

export function pdfDateTimeToOfd(value) {
  const match=/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?$/.exec(value);
  if(!match)return "";
  const [,year,month='01',day='01',hour='00',minute='00',second='00',utc,sign,zoneHour,zoneMinute='00']=match;
  const zone=utc?'Z':sign?`${sign}${zoneHour}:${zoneMinute}`:'';
  const date=`${year}-${month}-${day}T${hour}:${minute}:${second}.000${zone}`;
  return Number.isFinite(new Date(date).getTime())?date:"";
}
