import { nativeDialog, line } from "./dialogs.js";
import {
  propertyRows,
  certificateIdentity,
  certificateLabel,
} from "./certificate-view.js";
import { mountSealImage } from "./seal-image.js";
import { sealStorage } from "./seal-storage.js";

export function mountSealManager({
  worker,
  getCertificates,
  download,
  onChange,
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "ofdSealDialog";
  dialog.setAttribute("aria-labelledby", "ofdSealTitle");
  dialog.innerHTML = `<h2 id="ofdSealTitle">电子印章管理</h2>
    <details id="ofdSealCreateSection"><summary>创建电子印章</summary>
      <form id="ofdSealCreate" class="ofdForm">
        <label>制章证书<select id="ofdSealMaker" required></select></label>
        <label>授权用章证书（可多选）<select id="ofdSealAuthorized" multiple size="4" required></select></label>
        <label>印章名称<input id="ofdSealName" maxlength="128" value="个人电子印章" required></label>
        <label>印章类型<select id="ofdSealType"><option value="2">个人印章（2）</option><option value="1">单位印章（1）</option></select></label>
        <label>有效期起始<input id="ofdSealStart" type="datetime-local" step="1"></label>
        <label>有效期截止<input id="ofdSealEnd" type="datetime-local" step="1"></label>
        <p class="ofdMuted">按本地时间填写；留空时从制章时刻生效，截止于证书有效期。</p>
        <div class="ofdStampGrid"><label>图片显示宽度（毫米）<input id="ofdSealWidth" type="number" min="1" max="1000" step="1" value="30" required></label><label>图片显示高度（毫米）<input id="ofdSealHeight" type="number" min="1" max="1000" step="1" value="30" required></label></div>
        <div id="ofdSealImageEditor"></div>
        <div class="actions"><button id="ofdSealCreateConfirm" type="submit">制章并下载 ESL</button></div>
      </form>
    </details>
    <details><summary>导入已有电子印章</summary><form id="ofdSealImport" class="ofdForm"><label>印章文件<input id="ofdSealImportFile" type="file" accept=".esl,.seal,.der" required></label><p class="ofdMuted">支持 SES v4（SM2、PNG、完整授权证书列表）。</p><div class="actions"><button id="ofdSealImportConfirm" type="submit">导入印章</button></div></form></details>
    <p id="ofdSealMessage" role="status" aria-live="polite"></p><div id="ofdSealList"></div>
    <div class="actions"><button id="ofdSealClose" type="button">关闭</button></div>`;
  const $ = (id) => dialog.querySelector("#" + id);
  let seals = [],
    busy = false;
  const imageEditor = mountSealImage($("ofdSealImageEditor"), updateCreate);
  nativeDialog(dialog, ["ofdSealCreateConfirm", "ofdSealImportConfirm"]);
  document.body.append(dialog);
  function message(text, error = false) {
    $("ofdSealMessage").textContent = text;
    $("ofdSealMessage").classList.toggle("ofdError", error);
  }
  function updateCreate() {
    $("ofdSealCreateConfirm").disabled =
      busy ||
      !imageEditor.ready() ||
      !$("ofdSealMaker").value ||
      !$("ofdSealAuthorized").selectedOptions.length;
  }
  function choices(id, certs) {
    const select = $(id),
      previous = [...select.selectedOptions].map((o) => o.value);
    select.replaceChildren();
    for (const c of certs) {
      const option = line(
        select,
        `${certificateLabel(c)} · ${c.id.slice(0, 12)}`,
        "option",
      );
      option.value = c.id;
      option.selected = previous.includes(c.id);
    }
    if (!select.multiple && !select.value && select.options.length)
      select.selectedIndex = 0;
  }
  async function operation(task) {
    if (busy) return;
    busy = true;
    render();
    try {
      await task();
    } catch (e) {
      message(e.message, true);
    } finally {
      seals = await worker.call("sealList");
      busy = false;
      render();
      onChange();
    }
  }
  async function save(result) {
    seals = result.seals;
    try {
      await sealStorage("put", { id: result.id, bytes: result.bytes });
    } catch (e) {
      throw Error(
        `印章已载入本次会话，但无法持久保存：${e.message}。请保管下载的 ESL。`,
      );
    }
  }
  function render() {
    const certs = getCertificates();
    choices(
      "ofdSealMaker",
      certs.filter((c) => c.canSign && c.algorithm.startsWith("SM2")),
    );
    choices(
      "ofdSealAuthorized",
      certs.filter((c) => c.timeValid && c.algorithm.startsWith("SM2")),
    );
    const list = $("ofdSealList");
    list.replaceChildren();
    if (!seals.length) line(list, "尚未保存电子印章。", "p", "ofdMuted");
    for (const seal of seals) {
      const section = document.createElement("section");
      list.append(section);
      line(section, seal.name, "h3");
      line(
        section,
        `${seal.timeValid ? "有效" : "尚未生效或已过期"} · 制章签名已验证`,
        "p",
        "ofdMuted",
      );
      const details = document.createElement("details");
      section.append(details);
      line(details, "印章属性", "summary");
      propertyRows(details, [
        ["印章标识", seal.sealId],
        [
          "类型",
          seal.type === 1
            ? "单位印章（1）"
            : seal.type === 2
              ? "个人印章（2）"
              : String(seal.type),
        ],
        ["版本 / 厂商", `${seal.version} / ${seal.vendor}`],
        ["制作时间", seal.created],
        ["有效期起始", seal.validFrom],
        ["有效期截止", seal.validTo],
        ["图片显示尺寸", `${seal.width} × ${seal.height} mm`],
        ["SHA-256 指纹", seal.id],
      ]);
      line(details, "制章者", "h3");
      certificateIdentity(details, seal.maker);
      line(details, "授权用章证书", "h3");
      for (const c of seal.authorized) {
        certificateIdentity(details, c);
        propertyRows(details, [["SHA-256 指纹", c.id]]);
      }
      const actions = document.createElement("div");
      actions.className = "actions buttonRow";
      section.append(actions);
      const action = (label, task) => {
        const b = line(actions, label, "button", "secondaryButton");
        b.type = "button";
        b.disabled = busy;
        b.onclick = () => operation(task);
      };
      action("导出 ESL", async () => {
        const entry = await worker.call("sealGet", { id: seal.id });
        download(
          entry.bytes,
          `seal-${seal.sealId}.esl`,
          "application/octet-stream",
        );
      });
      action("以此印章重新制章", async () => {
        const entry = await worker.call("sealGet", { id: seal.id });
        $("ofdSealName").value = seal.name;
        $("ofdSealType").value = String(seal.type);
        $("ofdSealWidth").value = seal.width;
        $("ofdSealHeight").value = seal.height;
        $("ofdSealStart").value = $("ofdSealEnd").value = "";
        for (const o of $("ofdSealAuthorized").options)
          o.selected = seal.authorized.some((c) => c.id === o.value);
        await imageEditor.setImage(entry.image);
        $("ofdSealCreateSection").open = true;
        $("ofdSealName").focus();
        message(
          "已载入属性，可修改后创建新印章。",
        );
      });
      action("从本机移除", async () => {
        await sealStorage("delete", seal.id);
        seals = await worker.call("sealRemove", { id: seal.id });
        message("已从本机移除。");
      });
    }
    for (const input of dialog.querySelectorAll("input, select, button"))
      input.disabled = busy;
    updateCreate();
  }
  $("ofdSealMaker").onchange = $("ofdSealAuthorized").onchange = updateCreate;
  $("ofdSealClose").onclick = () => dialog.close();
  dialog.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  const ready = (async () => {
    try {
      const saved = await sealStorage("getAll");
      for (const entry of saved) {
        try {
          await worker.call("sealImport", { bytes: entry.bytes });
        } catch (e) {
          message(`印章 ${entry.id.slice(0, 12)} 无法载入：${e.message}`, true);
        }
      }
      seals = await worker.call("sealList");
    } catch (e) {
      message(`无法载入本机印章目录：${e.message}`, true);
    }
    render();
    onChange();
  })();
  $("ofdSealCreate").onsubmit = (e) => {
    e.preventDefault();
    const args = {
      makerId: $("ofdSealMaker").value,
      authorizedIds: [...$("ofdSealAuthorized").selectedOptions].map(
        (o) => o.value,
      ),
      options: {
        name: $("ofdSealName").value,
        type: Number($("ofdSealType").value),
        width: Number($("ofdSealWidth").value),
        height: Number($("ofdSealHeight").value),
        validFrom: $("ofdSealStart").value
          ? new Date($("ofdSealStart").value).toISOString()
          : undefined,
        validTo: $("ofdSealEnd").value
          ? new Date($("ofdSealEnd").value).toISOString()
          : undefined,
        image: imageEditor.bytes(),
      },
    };
    operation(async () => {
      const result = await worker.call("sealCreate", args);
      download(
        result.bytes,
        `seal-${result.metadata.sealId}.esl`,
        "application/octet-stream",
      );
      await save(result);
      message(
        "印章已创建并保存，已下载 ESL 备份。",
      );
    });
  };
  $("ofdSealImport").onsubmit = (e) => {
    e.preventDefault();
    const file = $("ofdSealImportFile").files[0];
    operation(async () => {
      if (!file || file.size > 16 * 1048576)
        throw Error("请选择不超过 16 MB 的 ESL 文件。");
      const result = await worker.call("sealImport", {
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      await save(result);
      message("印章已导入，制章签名验证通过。");
    });
  };
  return {
    ready,
    render,
    list: () => seals,
    async open() {
      dialog.showModal();
      await ready;
      seals = await worker.call("sealList");
      render();
    },
  };
}
