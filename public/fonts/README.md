# 项目字体

仓库包含从本机已有安装复制的五种常规字重，未修改字体内容或名称：

| 文件 | 字体 | 来源 |
| --- | --- | --- |
| SimSun.ttf | 宋体 / SimSun | 用户字体目录 |
| SimHei.ttf | 黑体 / SimHei | 用户字体目录 |
| KaiTi.ttf | 楷体 / KaiTi | Microsoft Word 字体目录 |
| FangSong.ttf | 仿宋 / FangSong | Microsoft Word 字体目录 |
| DengXian.ttf | 等线 / DengXian Regular | Microsoft Word 字体目录 |

原文件合计约 58.7 MiB，只用于构建。`scripts/build-fonts.mjs` 生成 `dist/fonts/<字体 ID>/index.zip` 和带内容版本号的字形分包，每包最多 32 个相邻字形；完整 TTF 不进入静态发布目录。

首次使用字体时加载索引及当前页面所需的分包；翻页、搜索、换字体或导出需要新字形时增量补充，已下载的分包在当前 Worker 内复用。复合字形自动加载全部组件。原始 GID、轮廓、水平和垂直度量、TrueType 指令保持不变，浏览器重建 glyf / loca 后供 MuPDF 预览和导出。

分包使用可缩放轮廓，不携带字体内的位图字库和原字体数字签名。五种字体均有与完整字体逐像素对比、增量加载和 PDF 导出的回归验证。本机来源记录不上传。

这些字体不是开源字体，原始许可继续适用。字体的文档嵌入标志不等于网站托管或再分发许可。
