import { attr, bool, child, children, number, text } from "./archive.js";
import { MM } from "./units.js";
import { readAttachments } from "./attachments.js";

// One navigation model, expressed in PDF.js destination coordinates, serves both
// the native viewer sidebar and PDF serialization. Page indices are zero-based.
const DEFERRED_DEST = "ofd:destination:";
function pageDestination(doc, values) {
  const [index, type, l, t, r, b, zoom] = values;
  if (!Number.isInteger(index) || !doc.pages[index] ||
      !["XYZ", "Fit", "FitH", "FitV", "FitR"].includes(type) ||
      [l,t,r,b,zoom].some(v => !Number.isFinite(v))) return null;
  const start = [index, { name: type }];
  if (type === "Fit") return start;
  const [x,y,,height] = doc.pages[index].box,
    left = (l-x)*MM, top = (height+y-t)*MM;
  switch (type) {
    case "XYZ": return [...start, left, top, zoom || null];
    case "FitH": return [...start, top];
    case "FitV": return [...start, left];
    case "FitR": {
      const right = (r-x)*MM, bottom = (height+y-b)*MM;
      if (right <= left || top <= bottom) { doc.warnings.add("导航：FitR 目标区域为空或倒置。"); return null; }
      return [...start, left, bottom, right, top];
    }
  }
}
export function resolveDeferredDestination(doc, key) {
  if (typeof key !== "string" || !key.startsWith(DEFERRED_DEST)) return null;
  try { return pageDestination(doc, JSON.parse(key.slice(DEFERRED_DEST.length))); }
  catch { return null; }
}
export function actionReader(doc, defer = false) {
  const pages = new Map(doc.pages.map((page, index) => [page.id, index]));
  const warn = (message) => doc.warnings.add(`导航：${message}`);
  function destination(node) {
    if (!node) return null;
    const index = pages.get(attr(node, "PageID"));
    if (index === undefined) { warn("跳转引用了不存在的页面。"); return null; }
    const type = attr(node, "Type");
    if (!["XYZ", "Fit", "FitH", "FitV", "FitR"].includes(type)) {
      warn(`未识别的目标类型 ${type}。`); return null;
    }
    try {
      const values = [index, type, ...["Left", "Top", "Right", "Bottom", "Zoom"].map(k => number(node,k,0))];
      return defer && type !== "Fit" ? DEFERRED_DEST + JSON.stringify(values) : pageDestination(doc, values);
    } catch(error) {
      warn(`跳转目标（页面 ID ${attr(node,"PageID")}）无效：${error.message}`);
      return null;
    }
  }
  const destinations = Object.create(null);
  for (const bookmark of children(child(doc.root, "Bookmarks"), "Bookmark")) {
    const name = attr(bookmark, "Name"), dest = destination(child(bookmark, "Dest"));
    if (!name || !dest) continue;
    if (Object.hasOwn(destinations, name)) { warn(`书签名称重复：${name}`); continue; }
    destinations[name] = dest;
  }
  function action(node, event) {
    const actions = children(child(node, "Actions"), "Action").filter((a) => attr(a, "Event") === event);
    const result = [];
    for (const entry of actions) {
      const go = child(entry, "Goto"), uri = child(entry, "URI"), attachment = child(entry, "GotoA");
      let target;
      if (go) {
        const bookmark = child(go, "Bookmark"), name = attr(bookmark, "Name");
        const dest = bookmark ? destinations[name] : destination(child(go, "Dest"));
        if (bookmark && !dest) warn(`跳转引用了不存在的书签：${name}`);
        if (dest) target = { dest };
      } else if (uri) {
        try {
          const url = new URL(attr(uri, "URI"), attr(uri, "Base") || undefined);
          if (["http:", "https:", "mailto:"].includes(url.protocol)) target = { url: url.href };
        } catch { /* Invalid URIs remain inert. */ }
        if (!target) warn("不支持的 URI 协议或无效地址。");
      } else if (attachment) {
        const ref = readAttachments(doc).find(a=>a.id===attr(attachment,"AttachID"));
        if (ref?.path) target = { attachment: { id: ref.id, filename: ref.filename, newWindow: bool(attachment, "NewWindow", true) } };
        else warn("附件动作引用了不存在的附件。");
      } else warn("Sound/Movie 媒体动作尚未实现，未执行该动作。");
      if (target) result.push(target);
    }
    return result.length ? { ...result[0], ...(result[0].attachment?{attachmentId:result[0].attachment.id}:{}), actions: result } : {};
  }
  return { action, destinations };
}

export function readNavigation(doc, defer = false) {
  const { action, destinations } = actionReader(doc, defer);
  function item(title, items = [], expanded = true, target = {}) {
    const visible = items.reduce((count, i) => count + 1 + Math.max(0, i.count), 0);
    return { title, dest: null, url: null, bold: false, italic: false,
      color: [0, 0, 0], items, count: expanded ? visible : -visible, ...target };
  }
  function outline(node, depth = 0) {
    if (depth > 64) throw new Error("大纲嵌套过深。");
    return children(node, "OutlineElem").map((entry) => item(attr(entry, "Title"),
      outline(entry, depth + 1), bool(entry, "Expanded", true), action(entry, "CLICK")));
  }
  const outlines = outline(child(doc.root, "Outlines")),
    bookmarks = Object.entries(destinations).map(([title, dest]) => item(title, [], true, { dest }));
  if (bookmarks.length) {
    if (outlines.length) outlines.push(item("书签", bookmarks));
    else outlines.push(...bookmarks);
  }
  const preferences = child(doc.root, "VPreferences"),
    pageMode = { None: "UseNone", FullScreen: "FullScreen", UseOutlines: "UseOutlines",
      UseBookmarks: "UseOutlines", UseThumbs: "UseThumbs", UseAttatchs: "UseAttachments" }[text(preferences, "PageMode")] || "UseNone",
    pageLayout = { OnePage: "SinglePage", OneColumn: "OneColumn", TwoPageL: "TwoPageLeft",
      TwoColumnL: "TwoColumnLeft", TwoPageR: "TwoPageRight", TwoColumnR: "TwoColumnRight" }[text(preferences, "PageLayout")] || "OneColumn";
  // Table 9 defines the omitted TabDisplay as FileName (Annex A disagrees).
  // Use the normative field description, and preserve explicit false values.
  const viewerPreferences = { DisplayDocTitle: text(preferences,"TabDisplay") === "DocTitle" };
  for (const key of ["HideToolbar","HideMenubar","HideWindowUI"]) {
    const value = text(preferences,key);
    viewerPreferences[key] = false;
    if (!value) viewerPreferences[key] = false;
    else if (["true","1","false","0"].includes(value)) viewerPreferences[key] = value === "true" || value === "1";
    else doc.warnings.add(`视图首选项 ${key} 无效，使用默认值 false。`);
  }
  const mode = text(preferences,"ZoomMode"), zoomNode = child(preferences,"Zoom");
  let initialDest = null;
  if (zoomNode) {
    const value = text(zoomNode), zoom = Number(value);
    if (value && Number.isFinite(zoom) && zoom > 0) initialDest = [0,{name:"XYZ"},null,null,zoom];
    else doc.warnings.add("视图首选项 Zoom 无效，使用阅读器默认缩放。");
  } else if (mode === "FitWidth") initialDest = [0,{name:"FitH"},null];
  else if (mode === "FitHeight") initialDest = [0,{name:"FitV"},null];
  else if (mode === "FitRect") initialDest = [0,{name:"Fit"}];
  else if (mode && mode !== "Default") doc.warnings.add(`未知的 ZoomMode：${mode}。`);
  const openAction = action(doc.root,"DO");
  // An explicit navigation action determines its own view. Otherwise apply
  // the preferred zoom before any URI/attachment action, retaining their order.
  if (initialDest && !openAction.actions?.some(entry => entry.dest)) {
    openAction.actions = [{dest:initialDest},...(openAction.actions || [])];
    openAction.dest = initialDest;
  }
  return { outlines, destinations, openAction, pageMode, pageLayout, viewerPreferences };
}

export function writePdfNavigation(pdf, navigation, attachmentTargets) {
  const owned = [], keep = (object) => (owned.push(object), object),
    string = (value) => keep(pdf.newString(value)),
    catalog = keep(keep(pdf.getTrailer()).get("Root"));
  const destination = (dest) => [keep(pdf.findPage(dest[0])), dest[1].name, ...dest.slice(2)];
  try {
    catalog.put("PageMode", navigation.pageMode);
    catalog.put("PageLayout", navigation.pageLayout);
    catalog.put("ViewerPreferences", navigation.viewerPreferences);
    if (navigation.openAction.actions?.length > 1 || navigation.openAction.attachment || navigation.openAction.url)
      catalog.put("OpenAction", pdfAction(pdf, navigation.openAction.actions, keep, attachmentTargets));
    else if (navigation.openAction.dest) catalog.put("OpenAction", destination(navigation.openAction.dest));
    const names = Object.keys(navigation.destinations).sort();
    if (names.length) {
      let root = keep(catalog.get("Names"));
      if (root.isNull()) root = keep(catalog.put("Names", {}));
      root.put("Dests", { Names: names.flatMap((name) => [string(name), destination(navigation.destinations[name])]) });
    }
    if (!navigation.outlines.length) return;
    const root = keep(pdf.addObject({ Type: "Outlines" }));
    catalog.put("Outlines", root);
    function write(items, parent) {
      const refs = items.map(() => keep(pdf.addObject({})));
      for (let i = 0; i < items.length; i++) {
        const item = items[i], ref = refs[i];
        ref.put("Title", string(item.title));
        ref.put("Parent", parent);
        if (i) ref.put("Prev", refs[i - 1]);
        if (i + 1 < refs.length) ref.put("Next", refs[i + 1]);
        if (item.actions?.length > 1 || item.attachment) ref.put("A", pdfAction(pdf, item.actions, keep, attachmentTargets));
        else if (item.dest) ref.put("Dest", destination(item.dest));
        else if (item.url) ref.put("A", { S: "URI", URI: string(item.url) });
        if (item.items.length) {
          write(item.items, ref);
          ref.put("Count", item.count);
        }
      }
      if (refs.length) {
        parent.put("First", refs[0]);
        parent.put("Last", refs.at(-1));
      }
    }
    write(navigation.outlines, root);
    root.put("Count", navigation.outlines.reduce((n, item) => n + 1 + Math.max(0, item.count), 0));
  } finally {
    for (const object of owned.reverse()) object.destroy();
  }
}

// Standard PDF actions, including Next chains and embedded GoToE targets.
export function pdfAction(pdf, actions, keep, attachmentTargets) {
  const serialize = (action) => {
    if (action.dest) return { S: "GoTo", D: [keep(pdf.findPage(action.dest[0])), action.dest[1].name, ...action.dest.slice(2)] };
    if (action.url) return { S: "URI", URI: keep(pdf.newString(action.url)) };
    if (action.attachment) {
      const target=attachmentTargets.get(action.attachment.id);
      return { S:"GoToE",D:[0,"Fit"],NewWindow:action.attachment.newWindow,
        T:target.name!=null?{R:"C",N:keep(pdf.newString(target.name))}:
          {R:"C",P:target.page,A:keep(pdf.newString(target.annotation))} };
    }
    throw Error("未知动作。");
  };
  const result = serialize(actions[0]);
  if (actions.length > 1) result.Next = actions.slice(1).map(serialize);
  return result;
}
