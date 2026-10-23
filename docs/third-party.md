# 第三方组件

| 组件 | 锁定版本 | 用途 | 许可 / 来源 |
| --- | --- | --- | --- |
| PDF.js | v6.4.299 | 原生阅读器界面、PDF 显示 | Apache-2.0；[Mozilla](https://github.com/mozilla/pdf.js/tree/v6.4.299)，构建 SHA 见 public/pdfjs/UPSTREAM.md |
| MuPDF.js / WASM | 1.28.1 | PDF 解释/输出、字体与图片、绘制设备 | AGPL-3.0-or-later 或 Artifex 商业许可；[官方文档](https://mupdf.readthedocs.io/en/latest/)，[源代码](https://github.com/ArtifexSoftware/mupdf/tree/1.28.1) |
| ofd.js | js 分支，参考源码于 2026-10-20 读取 | OFD 包分层和 calTextPoint 文字定位参考 | Apache-2.0；Copyright DLTech21；[项目](https://github.com/DLTech21/ofd.js/tree/js)，许可副本 licenses/ofd-js-Apache-2.0.txt |
| @xmldom/xmldom | 0.9.12 | Worker XML | MIT；https://github.com/xmldom/xmldom |
| fflate | 0.8.3 | ZIP 容器 | MIT；https://github.com/101arrowz/fflate |
| OpenType.js | 2.0.0 | 将 PDF 裸 CFF 封装为 OFD 要求的 OpenType 字体，保留原轮廓程序 | MIT；https://github.com/opentypejs/opentype.js ；许可副本 licenses/opentype-js-MIT.txt |
| fontkit | 2.0.4 | 字体集合、名称、嵌入权限与字形子集化 | MIT；https://github.com/foliojs/fontkit |
| asn1js | 3.0.10 | 签章外观及验签 ASN.1，与 PKI.js 统一版本 | BSD-3-Clause；https://github.com/PeculiarVentures/ASN1.js |
| PKI.js | 3.4.1 | CMS、X.509、P12/PKCS#8 解析与解密，WebCrypto 签名及验签 | BSD-3-Clause；https://github.com/PeculiarVentures/PKI.js |
| sm-crypto-v2 | 1.15.1 | SM2 / SM3 签名及验签 | MIT；https://github.com/Cubelrti/sm-crypto-v2 |
| @noble/hashes | 1.8.0 | 国标默认 MD5 引用摘要（标记弱算法） | MIT；https://github.com/paulmillr/noble-hashes |
| svgpath | 2.6.0 | PDF 输出路径标准化 | MIT；https://github.com/fontello/svgpath |
| SimSun / SimHei / KaiTi / FangSong / DengXian | 可选本机资源，不随仓库分发 | 原字体匹配与手动替换 | 非开源字体；网站托管或随应用分发需取得相应授权。详见 [字体说明](../public/fonts/README.md) |

没有直接使用 ofd.js 的发布 bundle；不依赖 parser_helper_x.js / 商业 parser_x.js。文字定位算法依据国标重写，保留参考来源说明，修复了 X/Y 继承、逐字位置、Unicode code point 和字形映射等问题。

构建工具为 esbuild，浏览器回归使用 Playwright；版本和完整依赖树见 package-lock.json。PDF.js 随附字体、WASM 解码器、CMap 的许可证保留在各自目录中。构建输出保留 MuPDF 的版权与许可声明。提供应用给他人时，需要满足 MuPDF 相应许可，包含对应源代码的提供义务，或使用商业许可。
