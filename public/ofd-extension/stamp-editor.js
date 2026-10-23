import { mountStampKeywords } from "./stamp-keywords.js";
import {
  planPlacements,
  validatePlacements,
  MAX_STAMPS,
  movePlacement,
} from "../shared/stamp-layout.js";

export function mountStampEditor(host, changed) {
  host.innerHTML = `<fieldset id="ofdStampEditor" class="ofdForm">
    <p class="ofdMuted">使用所选电子印章的已签名图像。同一次签章可关联多个落章位置。</p>
    <label>添加方式<select id="ofdStampMode"><option value="point">指定落章点</option><option value="each">逐页盖章</option><option value="seam">骑缝章</option><option value="keyword">关键词定位</option></select></label>
    <label id="ofdStampRangeRow" hidden>页码范围<input id="ofdStampRange" placeholder="留空为全部；例如 1,3-5"></label>
    <div id="ofdStampKeywords" hidden></div>
    <label id="ofdStampEdgeRow" hidden>骑缝位置<select id="ofdStampEdge"><option value="right">页面右侧</option><option value="left">页面左侧</option></select></label>
    <div class="ofdStampGrid">
      <label>预览／落章页码<input id="ofdStampPage" type="number" min="1" step="1" value="1"></label>
      <label id="ofdStampXRow">距左边 X（毫米）<input id="ofdStampX" type="number" min="0" step="any" inputmode="decimal" value="10"></label>
      <label id="ofdStampYRow">距上边 Y（毫米）<input id="ofdStampY" type="number" min="0" step="any" inputmode="decimal" value="10"></label>
      <label>完整章宽（毫米）<input id="ofdStampWidth" type="number" min="1" step="any" inputmode="decimal" value="30"></label>
      <label>完整章高（毫米）<input id="ofdStampHeight" type="number" min="1" step="any" inputmode="decimal" value="30"></label>
    </div>
    <p id="ofdStampSize" class="ofdMuted"></p>
    <label class="ofdCheck"><input id="ofdStampDraftVisible" type="checkbox" checked>显示待添加位置</label>
    <div class="actions ofdStampNavigation"><button id="ofdStampPrevious" type="button">上一页</button><button id="ofdStampNext" type="button">下一页</button><label>预览缩放<select id="ofdStampZoom"><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div>
    <p id="ofdStampPageStatus" role="status" aria-live="polite"></p>
    <div id="ofdStampViewport"><div id="ofdStampPreview" aria-label="文档实际页面，拖动印章调整位置"><canvas id="ofdStampPageCanvas" aria-label="原始 OFD 页面"></canvas><div id="ofdStampOverlay"></div></div></div>
    <p class="ofdMuted">原始文档页面（不应用阅读器中的临时字体替换）。虚线章待添加，实线章已添加；拖动实线章直接更新签署位置。骑缝切片沿页边上下拖动，可翻页逐页调整；选中印章后也可用方向键移动，Shift 微调。</p>
    <p id="ofdStampDragStatus" role="status" aria-live="polite"></p>
    <p id="ofdStampLayoutStatus" role="status" aria-live="polite"></p>
    <div class="actions"><button id="ofdStampAdd" type="button">添加到签署位置</button><button id="ofdStampClear" type="button">清空位置</button></div>
    <ol id="ofdStampPlacements" aria-label="本次签署的落章位置"></ol>
    <p id="ofdStampCount" class="ofdMuted"></p>
  </fieldset>`;
  const $ = (id) => host.querySelector("#" + id);
  let pages = [],
    placements = [],
    image,
    url,
    locked = false,
    renderPage,
    pageRevision = 0,
    pageKey,
    pageReady = false,
    drag;
  const stage = $("ofdStampPreview"),
    overlay = $("ofdStampOverlay"),
    canvas = $("ofdStampPageCanvas");
  const keywords = mountStampKeywords($("ofdStampKeywords"), () => {
    $("ofdStampDraftVisible").checked = true;
    update();
  }, page => {
    $("ofdStampPage").value = page;
    update();
  });
  async function drawPage(page, box) {
    const zoom = number("ofdStampZoom"),
      key = `${page}:${zoom}`;
    if (key === pageKey) return;
    pageKey = key;
    const ticket = ++pageRevision;
    pageReady = false;
    canvas.hidden = true;
    overlay.hidden = true;
    const status = $("ofdStampPageStatus");
    if (!box || !renderPage) {
      status.textContent = "等待载入文档页面…";
      return;
    }
    status.textContent = `正在绘制第 ${page} 页…`;
    const cssWidth = 480 * zoom;
    stage.style.width = `${cssWidth}px`;
    stage.style.aspectRatio = `${box[2]} / ${box[3]}`;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(
      (density * cssWidth) / box[2],
      Math.sqrt(4000000 / (box[2] * box[3])),
    );
    const width = Math.max(1, Math.ceil(box[2] * scale)),
      height = Math.max(1, Math.ceil((box[3] * width) / box[2]));
    try {
      const result = await renderPage(page - 1, width, height);
      if (ticket !== pageRevision) return;
      canvas.width = result.width;
      canvas.height = result.height;
      canvas
        .getContext("2d")
        .putImageData(
          new ImageData(
            new Uint8ClampedArray(result.pixels),
            result.width,
            result.height,
          ),
          0,
          0,
        );
      pageReady = true;
      canvas.hidden = false;
      overlay.hidden = false;
      status.textContent = `第 ${page} / ${pages.length} 页 · 可直接拖动印章${result.warnings?.length ? "；页面含渲染提示，请在阅读器核对" : ""}`;
    } catch (e) {
      if (ticket === pageRevision)
        status.textContent = `页面预览失败：${e.message}。可切换页码或缩放重试。`;
    }
  }
  const number = (id) => Number($(id).value);
  const draft = () => ({
    mode: $("ofdStampMode").value,
    page: number("ofdStampPage"),
    range: $("ofdStampRange").value,
    edge: $("ofdStampEdge").value,
    x: number("ofdStampX"),
    y: number("ofdStampY"),
    width: number("ofdStampWidth"),
    height: number("ofdStampHeight"),
  });
  function plan() {
    if ($("ofdStampMode").value === "keyword")
      return keywords.plan(number("ofdStampWidth"), number("ofdStampHeight"));
    return planPlacements(pages, draft());
  }
  function ready() {
    return !!image && placements.length > 0;
  }
  function previewPlacement(p, pending, index = -1) {
    const box = pages[p.page - 1].box,
      [x, y, w, h] = p.boundary,
      c = p.clip || [0, 0, w, h];
    const visible = document.createElement("div");
    visible.className = "ofdStampMark" + (pending ? " ofdStampPending" : "");
    Object.assign(visible.style, {
      left: `${((x + c[0] - box[0]) / box[2]) * 100}%`,
      top: `${((y + c[1] - box[1]) / box[3]) * 100}%`,
      width: `${(c[2] / box[2]) * 100}%`,
      height: `${(c[3] / box[3]) * 100}%`,
    });
    // Do not paint an unchanged draft over the same saved placement.
    const alreadyPainted =
      pending &&
      placements.some(
        (other) =>
          other.page === p.page &&
          other.boundary.every((v, i) => v === p.boundary[i]) &&
          JSON.stringify(other.clip) === JSON.stringify(p.clip),
      );
    if (alreadyPainted) return;
    visible.dataset.index = index;
    visible.dataset.pending = String(pending);
    visible.tabIndex = 0;
    visible.setAttribute("role", "button");
    visible.setAttribute(
      "aria-label",
      `${pending ? "待添加印章" : `落章位置 ${index + 1}`}，第 ${p.page} 页，${p.clip ? "骑缝切片，上下拖动" : "可拖动"}`,
    );
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = pending ? "待添加印章" : "已添加印章";
      Object.assign(img.style, {
        width: `${(w / c[2]) * 100}%`,
        height: `${(h / c[3]) * 100}%`,
        left: `${(-c[0] / c[2]) * 100}%`,
        top: `${(-c[1] / c[3]) * 100}%`,
      });
      visible.append(img);
    }
    overlay.append(visible);
  }
  function update() {
    const mode = $("ofdStampMode").value;
    $("ofdStampRangeRow").hidden = mode === "point";
    $("ofdStampEdgeRow").hidden = mode !== "seam";
    $("ofdStampXRow").hidden = mode === "seam" || mode === "keyword";
    $("ofdStampYRow").hidden = mode === "keyword";
    $("ofdStampKeywords").hidden = mode !== "keyword";
    const page = number("ofdStampPage"),
      box = pages[page - 1]?.box;
    overlay.replaceChildren();
    drawPage(page, box);
    $("ofdStampPrevious").disabled = locked || page <= 1;
    $("ofdStampNext").disabled = locked || page >= pages.length;
    if (box) {
      $("ofdStampSize").textContent =
        `第 ${page} 页：${box[2].toFixed(1)} × ${box[3].toFixed(1)} 毫米`;
      if (mode === "keyword") for (const match of keywords.matches()) {
        if (match.page !== page) continue;
        const [x0,y0,x1,y1] = match.bounds, hit = document.createElement("div");
        hit.className = "ofdStampKeywordHit";
        Object.assign(hit.style, {left:`${(x0-box[0])/box[2]*100}%`, top:`${(y0-box[1])/box[3]*100}%`, width:`${(x1-x0)/box[2]*100}%`, height:`${(y1-y0)/box[3]*100}%`});
        overlay.append(hit);
      }
      placements.forEach((p, i) => {
        if (p.page === page) previewPlacement(p, false, i);
      });
    } else $("ofdStampSize").textContent = "请选择有效的预览页码。";
    try {
      const pending = plan();
      pending.forEach((p, i) => {
        if ($("ofdStampDraftVisible").checked && p.page === page) previewPlacement(p, true, i);
      });
      $("ofdStampLayoutStatus").textContent =
        `待添加 ${pending.length} 个位置。`;
      $("ofdStampLayoutStatus").className = "ofdMuted";
      $("ofdStampAdd").disabled =
        locked || placements.length + pending.length > MAX_STAMPS;
    } catch (e) {
      $("ofdStampLayoutStatus").textContent = e.message;
      $("ofdStampLayoutStatus").className = "ofdError";
      $("ofdStampAdd").disabled = true;
    }
    $("ofdStampClear").disabled = locked || !placements.length;
    $("ofdStampCount").textContent =
      `已添加 ${placements.length} 个位置；签署只使用列表中的位置。`;
    changed();
  }
  function list() {
    $("ofdStampPlacements").replaceChildren();
    placements.forEach((p, i) => {
      const row = document.createElement("li"),
        go = document.createElement("button"),
        remove = document.createElement("button");
      const [x, y, w, h] = p.boundary,
        c = p.clip || [0, 0, w, h],
        box = pages[p.page - 1].box;
      go.type = remove.type = "button";
      go.className = remove.className = "secondaryButton";
      go.textContent = `第 ${p.page} 页 · X ${Number((x + c[0] - box[0]).toFixed(6))} / Y ${Number((y + c[1] - box[1]).toFixed(6))} · ${p.clip ? "骑缝切片" : "完整章"}`;
      go.onclick = () => {
        $("ofdStampPage").value = p.page;
        update();
      };
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除第 ${i + 1} 个落章位置`);
      remove.onclick = () => {
        if (locked) return;
        placements.splice(i, 1);
        list();
        update();
      };
      row.append(go, remove);
      $("ofdStampPlacements").append(row);
    });
  }
  for (const id of [
    "ofdStampMode",
    "ofdStampRange",
    "ofdStampEdge",
    "ofdStampPage",
    "ofdStampX",
    "ofdStampY",
    "ofdStampWidth",
    "ofdStampHeight",
    "ofdStampZoom",
  ])
    $(id).oninput = () => {
      if (id === "ofdStampRange") keywords.setRange($(id).value);
      if (["ofdStampWidth", "ofdStampHeight"].includes(id)) keywords.resetMoves();
      if (!["ofdStampPage", "ofdStampZoom"].includes(id))
        $("ofdStampDraftVisible").checked = true;
      update();
    };
  $("ofdStampDraftVisible").onchange = update;
  $("ofdStampAdd").onclick = () => {
    if (locked) return;
    try {
      const next = [...placements, ...plan()];
      validatePlacements(pages, next);
      placements = next;
      $("ofdStampDraftVisible").checked = false;
      list();
      update();
    } catch (e) {
      $("ofdStampLayoutStatus").textContent = e.message;
    }
  };
  $("ofdStampClear").onclick = () => {
    if (locked) return;
    placements = [];
    $("ofdStampDraftVisible").checked = true;
    list();
    update();
  };
  for (const [id, step] of [
    ["ofdStampPrevious", -1],
    ["ofdStampNext", 1],
  ]) {
    $(id).onclick = () => {
      if (locked) return;
      $("ofdStampPage").value = Math.max(
        1,
        Math.min(pages.length, number("ofdStampPage") + step),
      );
      $("ofdStampViewport").scrollTop = 0;
      update();
    };
  }
  function applyMove(original, index, pending, dx, dy) {
    const box = pages[original.page - 1].box,
      moved = movePlacement(original, box, dx, dy);
    if (pending) {
      $("ofdStampDraftVisible").checked = true;
      if ($("ofdStampMode").value === "keyword") keywords.move(index, moved);
      else {
        if (!original.clip) $("ofdStampX").value = (moved.boundary[0] - box[0]).toFixed(2);
        $("ofdStampY").value = (moved.boundary[1] - box[1]).toFixed(2);
      }
    } else {
      placements[index] = moved;
      list();
      $("ofdStampDragStatus").textContent =
        `已更新位置 ${index + 1}：第 ${moved.page} 页，X ${(moved.boundary[0] + (moved.clip?.[0] || 0) - box[0]).toFixed(2)} / Y ${(moved.boundary[1] - box[1]).toFixed(2)} 毫米。`;
    }
    update();
  }
  stage.onpointerdown = (event) => {
    if (locked || !pageReady || event.button !== 0 || !event.isPrimary) return;
    const mark = event.target.closest(".ofdStampMark"),
      page = number("ofdStampPage");
    if (!mark) {
      try {
        const pending = plan(), index = pending.findIndex(p => p.page === page), p = pending[index];
        if (!p) return;
        const rect = stage.getBoundingClientRect(),
          box = pages[page - 1].box,
          c = p.clip || [0, 0, p.boundary[2], p.boundary[3]];
        applyMove(
          p,
          index,
          true,
          ((event.clientX - rect.left) / rect.width) * box[2] +
            box[0] -
            (p.boundary[0] + c[0] + c[2] / 2),
          ((event.clientY - rect.top) / rect.height) * box[3] +
            box[1] -
            (p.boundary[1] + c[1] + c[3] / 2),
        );
      } catch {}
      return;
    }
    const index = Number(mark.dataset.index),
      pending = mark.dataset.pending === "true";
    let original;
    try {
      original = structuredClone(
        pending ? plan()[index] : placements[index],
      );
    } catch {
      return;
    }
    if (!original) return;
    event.preventDefault();
    mark.focus();
    drag = {
      original,
      index,
      pending,
      x: event.clientX,
      y: event.clientY,
      rect: stage.getBoundingClientRect(),
      id: event.pointerId,
    };
    stage.setPointerCapture(event.pointerId);
  };
  stage.onpointermove = (event) => {
    if (!drag || drag.id !== event.pointerId || locked) return;
    const box = pages[drag.original.page - 1].box;
    applyMove(
      drag.original,
      drag.index,
      drag.pending,
      ((event.clientX - drag.x) / drag.rect.width) * box[2],
      ((event.clientY - drag.y) / drag.rect.height) * box[3],
    );
  };
  stage.onpointerup = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const selector = `[data-pending="${drag.pending}"][data-index="${drag.index}"]`;
    drag = undefined;
    if (stage.hasPointerCapture(event.pointerId))
      stage.releasePointerCapture(event.pointerId);
    overlay.querySelector(selector)?.focus({ preventScroll: true });
  };
  stage.onpointercancel = () => {
    drag = undefined;
  };
  stage.onkeydown = (event) => {
    if (locked || !pageReady || !event.target.matches(".ofdStampMark")) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const mark = event.target,
      index = Number(mark.dataset.index),
      pending = mark.dataset.pending === "true",
      step = event.shiftKey ? 0.1 : 1;
    try {
      const original = pending
        ? plan()[index]
        : placements[index];
      applyMove(
        original,
        index,
        pending,
        direction[0] * step,
        direction[1] * step,
      );
      overlay
        .querySelector(
          `[data-pending="${pending}"][data-index="${index}"]`,
        )
        ?.focus({ preventScroll: true });
    } catch {}
  };
  return {
    ready,
    setSeal(seal) {
      if (url) URL.revokeObjectURL(url);
      image = seal?.image;
      url = image
        ? URL.createObjectURL(new Blob([image], { type: "image/png" }))
        : undefined;
      placements = [];
      keywords.resetMoves();
      if (seal) {
        $("ofdStampWidth").value = seal.metadata.width;
        $("ofdStampHeight").value = seal.metadata.height;
      }
      list();
      update();
    },
    setPages(value, painter, readMatches) {
      pageRevision++;
      pageKey = undefined;
      renderPage = painter;
      drag = undefined;
      $("ofdStampDragStatus").textContent = "";
      pages = value;
      placements = [];
      $("ofdStampDraftVisible").checked = true;
      $("ofdStampPage").max = pages.length;
      $("ofdStampPage").value = 1;
      $("ofdStampRange").value = "";
      keywords.setDocument(pages, readMatches);
      list();
      update();
    },
    setBusy(value) {
      locked = value;
      $("ofdStampEditor").disabled = value;
    },
    options() {
      if (!ready()) throw Error("请先选择有效的电子印章并添加落章位置。");
      validatePlacements(pages, placements);
      return {
        placements: structuredClone(placements),
      };
    },
  };
}
