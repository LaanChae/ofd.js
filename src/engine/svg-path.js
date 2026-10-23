import svgpath from "svgpath";
import { fmt } from "./ofd-write-utils.js";

export function pathData(data) {
  const path = svgpath(data).abs().unshort().unarc();
  if (path.err) throw new Error(`PDF 路径无效：${path.err}`);
  const result = [];
  path.iterate((s, i, x, y) => {
    if (s[0] === "H") result.push(`L ${fmt(s[1])} ${fmt(y)}`);
    else if (s[0] === "V") result.push(`L ${fmt(x)} ${fmt(s[1])}`);
    else
      result.push(
        [{ C: "B", Z: "C" }[s[0]] || s[0], ...s.slice(1).map(fmt)].join(" "),
      );
  });
  return result.join(" ");
}
