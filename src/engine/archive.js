import { Unzip, UnzipInflate } from "fflate";
import { DOMParser } from "@xmldom/xmldom";

export const NS = "http://www.ofdspec.org/2016";
export const MAX_FILE = 100 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024,
  MAX_XML = 16 * 1024 * 1024;
export const name = (node) =>
  node?.localName || node?.nodeName?.split(":").at(-1);
export const children = (node, tag) =>
  Array.from(node?.childNodes || []).filter(
    (n) => n.nodeType === 1 && (!tag || name(n) === tag),
  );
export function child(node, tag) {
  for (let current = node?.firstChild; current; current = current.nextSibling)
    if (current.nodeType === 1 && (!tag || name(current) === tag)) return current;
}
export const text = (node, tag) =>
  (tag ? child(node, tag) : node)?.textContent?.trim() || "";
export const attr = (node, key, fallback = "") =>
  node?.hasAttribute(key) ? node.getAttribute(key) : fallback;
export function numbers(value, expected) {
  const result = String(value)
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (
    result.some((n) => !Number.isFinite(n)) ||
    (expected && result.length !== expected)
  )
    throw new Error(`无效数值：${String(value).slice(0, 80)}`);
  return result;
}
export function number(node, key, fallback) {
  const value = Number(attr(node, key, fallback));
  if (!Number.isFinite(value)) throw new Error(`${key} 不是有效数值。`);
  return value;
}
export function bool(node, key, fallback) {
  // xs:boolean has whiteSpace=collapse; surrounding XML whitespace is legal.
  const value = attr(node, key, String(fallback)).trim();
  if (["true", "1"].includes(value)) return true;
  if (["false", "0"].includes(value)) return false;
  throw new Error(`${key} 不是有效布尔值。`);
}
export function resolve(base, reference) {
  const value = reference.trim();
  if (!value || /[\\:\0]/.test(value)) throw new Error("无效的包内资源路径。");
  const segments = (
    value.startsWith("/")
      ? value.slice(1)
      : base.slice(0, base.lastIndexOf("/") + 1) + value
  ).split("/");
  const result = [];
  for (const part of segments) {
    if (part === "..") {
      if (!result.length) throw new Error("资源路径越过了 OFD 容器边界。");
      result.pop();
    } else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}
export function xmlParse(data) {
  // XML permits UTF-8 and UTF-16. Decode before parsing, while callers retain
  // original bytes for signature/hash verification.
  const le = data?.[0] === 0xff && data?.[1] === 0xfe || data?.[0] === 0x3c && data?.[1] === 0;
  const be = data?.[0] === 0xfe && data?.[1] === 0xff || data?.[0] === 0 && data?.[1] === 0x3c;
  const source = typeof data === 'string' ? data : new TextDecoder(le?'utf-16le':be?'utf-16be':'utf-8',{fatal:true}).decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("不允许 XML 外部实体或 DTD。");
  const errors = [];
  const document = new DOMParser({
    locator: false,
    onError: (level, message) => errors.push(message),
  }).parseFromString(source, "application/xml");
  if (errors.length || !document?.documentElement)
    throw new Error("文件包含无效 XML。");
  return document.documentElement;
}

export class Archive {
  constructor(bytes) {
    if (!bytes.length || bytes.length > MAX_FILE)
      throw new Error("文件为空或超过 100 MB。");
    this.entries = new Map();
    this.dataCache = new Map();
    this.xmlCache = new Map();
    this.xmlCacheBytes = 0;
    this.warnings = new Set();
    this.expanded = 0;
    let count = 0, declared = 0;
    const zip = new Unzip((file) => {
      if (++count > 20000 || /[\\:\0]/.test(file.name) ||
          file.name.startsWith("/") || file.name.split("/").includes(".."))
        throw new Error("OFD 容器包含无效路径或过多文件。");
      if (file.name.endsWith("/")) return;
      const key = resolve("", file.name);
      if (this.entries.has(key)) throw new Error("OFD 容器包含重复文件。");
      declared += file.originalSize || 0;
      if (declared > MAX_EXPANDED || (/\.xml$/i.test(key) && file.originalSize > MAX_XML))
        throw new Error("OFD 解压内容超过限制（512 MB，单个 XML 16 MB）。");
      this.entries.set(key, { file });
    });
    zip.register(UnzipInflate);
    // fflate buffers compressed chunks until an entry's public start() method
    // is called. Keep chunks bounded even for entries with data descriptors.
    for (let i = 0; i < bytes.length; i += 16384)
      zip.push(bytes.subarray(i, i + 16384), i + 16384 >= bytes.length);
    if (!this.entries.size) throw new Error("ZIP 文件不完整或已损坏。");
  }
  has(path) { return this.entries.has(path); }
  paths() { return this.entries.keys(); }
  materialize() { return new Map([...this.paths()].map(path => [path, this.read(path)])); }
  read(path) {
    if (this.dataCache.has(path)) return this.dataCache.get(path);
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`缺少包内文件：${path}`);
    if (entry.error) throw entry.error;
    let size = 0, complete = false;
    const chunks = [];
    entry.file.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      this.expanded += data.length;
      if (this.expanded > MAX_EXPANDED || (/\.xml$/i.test(path) && size > MAX_XML))
        throw new Error("OFD 解压内容超过限制（512 MB，单个 XML 16 MB）。");
      chunks.push(data);
      complete = final;
    };
    try {
      entry.file.start();
      if (!complete || (entry.file.originalSize !== undefined && size !== entry.file.originalSize))
        throw new Error("ZIP 文件不完整或已损坏。");
      const value = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
      this.dataCache.set(path, value);
      // Drop decompressor and chunk callbacks after successful extraction.
      delete entry.file;
      return value;
    } catch (error) { entry.error = error; throw error; }
  }
  xml(path) {
    if (this.xmlCache.has(path)) {
      const root = this.xmlCache.get(path);
      this.xmlCache.delete(path);
      this.xmlCache.set(path, root);
      return root;
    }
    const data = this.read(path), root = xmlParse(data);
    if (root.namespaceURI !== NS)
      this.warnings.add(
        `命名空间 ${root.namespaceURI || "（缺失）"}，已按 OFD 结构读取。`,
      );
    // DOM trees are much larger than their source XML. Keep a bounded working
    // set so drawing, text extraction and links can reuse the same page tree.
    // Oversized pages are still readable, but never retained in the cache.
    const limit = 8 * 1024 * 1024;
    if (data.length <= limit) {
      while (this.xmlCache.size >= 32 || this.xmlCacheBytes + data.length > limit) {
        const oldest = this.xmlCache.keys().next().value;
        this.xmlCacheBytes -= this.read(oldest).length;
        this.xmlCache.delete(oldest);
      }
      this.xmlCache.set(path, root);
      this.xmlCacheBytes += data.length;
    }
    return root;
  }
}
