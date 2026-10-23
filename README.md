# ofd.js

基于 PDF.js 原生界面的 OFD / PDF 阅读器。OFD 直接按页预览，支持文字选择、搜索、复制、双向转换、字体替换、签名验签、证书与电子印章管理、公文元数据及加密文档。计算在浏览器中完成，使用 JavaScript、Web Worker 和 MuPDF WASM。

## 本地运行

需要 Node.js 22 或更高版本。

```sh
npm ci --ignore-scripts
npm run build
npm start
```

打开 http://127.0.0.1:8080 。构建产物在 `dist/`，部署后不需要 Node.js 或后端服务。

## Cloudflare Pages

连接本仓库后使用以下设置：

| 设置 | 值 |
| --- | --- |
| Framework preset | None |
| Production branch | main |
| Build command | npm run build |
| Build output directory | dist |
| Root directory | 留空（仓库根目录） |

Node.js 版本由 `.node-version` 指定。根地址通过 `public/_redirects` 跳转到阅读器。应用需部署在域名根目录，签名等功能需要 HTTPS 或 localhost。

[Cloudflare Pages 构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)

## 仓库内容

首次上传仅包含运行、构建及维护 PDF.js 集成所需的文件。业务样例、公文、标准 PDF、Windows 安装程序、临时输出、依赖目录和构建产物不进入仓库。

本仓库包含 SimSun、SimHei、KaiTi、FangSong、DengXian 五种项目字体，构建时拆成静态字形分包；网站只提供索引和分包，不提供整份 TTF。阅读时下载当前已解析页面需要的分包，后续页面增量加载并复用。每包最多包含 32 个相邻字形，复合字形的组件也会自动加载。阅读器也支持内嵌字体、用户导入字体和浏览器本机字体 API。字体来源与许可说明见 [项目字体](public/fonts/README.md)。

直接预览和 PDF 导出共用浏览器内组装的字体，保留原始字形编号、轮廓、字宽及 TrueType 指令。导出前会收集所有页面（含模板、注释和印章）的字形依赖；关闭导出子集化也不会下载未使用的完整项目字体。字体分包只涉及项目字体，文档内嵌字体和用户导入字体继续按原方式处理。

字体分包回归：`npm run test:font-chunks`。

PDF 与 OFD 的混合模式、字体及动作并不完全等价，转换会提示无法原样保留的内容。数字签名不能通过格式转换保持有效。

## 第三方组件

PDF.js 的许可与修改说明保留在 `public/pdfjs/`，其他声明见 [第三方组件](docs/third-party.md) 和 `licenses/`。MuPDF 使用 AGPL-3.0-or-later 或商业许可；对外提供服务时应按所选许可履行对应义务。
