import { removeWhiteBackground } from "../shared/stamp-image.js";
export function mountSealImage(host, changed) {
  host.innerHTML = `<label>印章图片<input id="ofdStampImage" type="file" accept="image/png,image/jpeg"></label>
    <label class="ofdCheck"><input id="ofdStampRemoveWhite" type="checkbox">去除白底</label>
    <label id="ofdStampToleranceRow" hidden>近白色容差<input id="ofdStampTolerance" type="number" min="0" max="80" value="10"></label>
    <div class="ofdTransparency"><span aria-hidden="true">透明效果预览 · 文字 ABC 123</span><img id="ofdStampImagePreview" alt="制章图像的透明效果" hidden></div>
    <p id="ofdStampImageStatus" role="status" aria-live="polite"></p>`;
  const $ = (id) => host.querySelector("#" + id);
  let source,
    image,
    url,
    revision = 0;
  async function process() {
    const ticket = ++revision;
    image = undefined;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    $("ofdStampImagePreview").hidden = true;
    $("ofdStampToleranceRow").hidden = !$("ofdStampRemoveWhite").checked;
    $("ofdStampImageStatus").textContent = source
      ? "正在处理图片…"
      : "请选择印章图片。";
    changed();
    try {
      if (!source) return;
      if (
        source.size > 4 * 1048576 ||
        !["image/png", "image/jpeg"].includes(source.type)
      )
        throw Error("请选择不超过 4 MB 的 PNG 或 JPEG 图片。");
      const bitmap = await createImageBitmap(source);
      try {
        if (bitmap.width * bitmap.height > 16000000)
          throw Error("图片不能超过 1600 万像素。");
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if ($("ofdStampRemoveWhite").checked) {
          data.data.set(
            removeWhiteBackground(
              data.data,
              Number($("ofdStampTolerance").value),
            ),
          );
          ctx.putImageData(data, 0, 0);
        }
        let transparent = 0;
        for (let i = 3; i < data.data.length; i += 4)
          if (data.data[i] < 255) transparent++;
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob || blob.size > 4 * 1048576)
          throw Error("处理后的 PNG 超过 4 MB。");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (ticket !== revision) return;
        image = bytes;
        url = URL.createObjectURL(blob);
        $("ofdStampImagePreview").src = url;
        $("ofdStampImagePreview").hidden = false;
        $("ofdStampImageStatus").textContent = transparent
          ? `含透明／半透明像素：${((100 * transparent) / (canvas.width * canvas.height)).toFixed(1)}%。`
          : "图像不透明，可勾选“去除白底”。";
      } finally {
        bitmap.close();
      }
    } catch (e) {
      if (ticket === revision) $("ofdStampImageStatus").textContent = e.message;
    } finally {
      if (ticket === revision) changed();
    }
  }
  $("ofdStampImage").onchange = () => {
    source = $("ofdStampImage").files[0];
    process();
  };
  $("ofdStampRemoveWhite").onchange = process;
  $("ofdStampTolerance").oninput = process;
  return {
    ready: () => !!image,
    bytes() {
      if (!image) throw Error("请先载入并预览制章图像。");
      return image;
    },
    setImage(bytes) {
      $("ofdStampRemoveWhite").checked = false;
      source = new Blob([bytes], { type: "image/png" });
      return process();
    },
  };
}
