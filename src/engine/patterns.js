import * as m from "mupdf";
import { attr, numbers } from "./archive.js";
import { IDENTITY, multiply } from "./geometry.js";
import { patternLayout, paintPatternCells } from "./pattern-layout.js";
import { localBounds } from "./gradients.js";

// Tiling must also be emitted as a native PDF resource: the PDF-writing device
// has no beginTile implementation. Render a bounded cell, then graft its vector
// resources into a PDF tiling pattern during finalization.
export function drawPattern(renderer, device, node, matrix, opacity, style) {
  const layout = patternLayout(node),
    { width, height, xstep, ystep, cellWidth, cellHeight } = layout;
  if (renderer.patternDepth >= 16) throw new Error("底纹嵌套过深。");
  const tm = multiply(
    attr(node, "RelativeTo") === "Page" ? renderer.pageMatrix : matrix,
    numbers(attr(node, "CTM", "1 0 0 1 0 0"), 6),
  );
  const box = localBounds(tm, renderer.bounds),
    buffer = new m.Buffer(),
    writer = new m.DocumentWriter(buffer, "pdf", "compress");
  const previousBounds = renderer.bounds;
  let cell, bytes;
  renderer.patternDepth = (renderer.patternDepth || 0) + 1;
  try {
    renderer.bounds = [0, 0, cellWidth, cellHeight];
    cell = writer.beginPage(renderer.bounds);
    paintPatternCells(renderer, cell, node, { ...layout, cells: [IDENTITY] }, IDENTITY, style, opacity);
    writer.endPage();
    writer.close();
    bytes = new Uint8Array(buffer.asUint8Array());
  } finally {
    renderer.patternDepth--;
    renderer.bounds = previousBounds;
    cell?.destroy();
    writer.destroy();
    buffer.destroy();
  }
  renderer.forms.paint(
    device,
    {
      matrix: tm,
      box,
      makeForm: (pdf) => {
        const source = m.Document.openDocument(bytes, "application/pdf"),
          page = source.findPage(0),
          resources = page.getInheritable("Resources"),
          contents = page.get("Contents"),
          graft = pdf.newGraftMap();
        let copied, cellForm, pattern, content;
        try {
          copied = graft.graftObject(resources);
          content = new m.Buffer(`1 0 0 -1 0 ${cellHeight} cm\n`);
          const read = (ref) => {
            const data = ref.readStream();
            try {
              content.writeBuffer(data);
              content.write("\n");
            } finally {
              data.destroy();
            }
          };
          if (contents.isArray())
            contents.forEach((ref) => {
              try {
                read(ref);
              } finally {
                ref.destroy();
              }
            });
          else read(contents);
          cellForm = pdf.addStream(content, {
            Type: "XObject",
            Subtype: "Form",
            BBox: [0, 0, cellWidth, cellHeight],
            Resources: copied,
          });
          pattern = pdf.addStream(layout.cells.map((matrix) =>
            `q ${matrix.join(" ")} cm /Cell Do Q\n`).join(""), {
            Type: "Pattern",
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, width, height],
            XStep: xstep,
            YStep: ystep,
            Resources: { XObject: { Cell: cellForm } },
          });
          const [x0, y0, x1, y1] = box,
            w = x1 - x0,
            h = y1 - y0;
          return pdf.addStream(
            `/Pattern cs /P scn ${x0} ${y0} ${w} ${h} re f`,
            {
              Type: "XObject",
              Subtype: "Form",
              BBox: box,
              Matrix: [1 / w, 0, 0, -1 / h, -x0 / w, y1 / h],
              Resources: { Pattern: { P: pattern } },
            },
          );
        } finally {
          content?.destroy();
          pattern?.destroy();
          cellForm?.destroy();
          copied?.destroy();
          graft.destroy();
          contents.destroy();
          resources.destroy();
          page.destroy();
          source.destroy();
        }
      },
    },
    false,
    1,
  );
}
