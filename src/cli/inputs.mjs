import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { imageExtensions } from "../utils/image.mjs";
import { walkFiles } from "../utils/files.mjs";

function imageSpec(entry, index) {
  if (typeof entry === "string") entry = { source: entry };
  if (typeof entry?.source !== "string" || !entry.source.trim()) throw new Error(`第 ${index + 1} 项缺少 source`);
  const { source, alt, caption, widthPercent, sourcePage, assetAlt, tags } = entry;
  if (assetAlt != null && typeof assetAlt !== "string") throw new Error(`第 ${index + 1} 项的 assetAlt 必须是字符串`);
  if (tags != null && (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string"))) {
    throw new Error(`第 ${index + 1} 项的 tags 必须是字符串数组`);
  }
  for (const value of [alt, caption]) {
    if (value != null && typeof value !== "string") throw new Error(`第 ${index + 1} 项的 alt / caption 必须是字符串`);
  }
  if (widthPercent != null && (!Number.isInteger(widthPercent) || widthPercent < 1 || widthPercent > 100)) {
    throw new Error(`第 ${index + 1} 项的 widthPercent 必须是 1 至 100 的整数`);
  }
  if (sourcePage != null) {
    let valid = false;
    try { valid = typeof sourcePage === "string" && ["http:", "https:"].includes(new URL(sourcePage).protocol); }
    catch { /* report the manifest position below */ }
    if (!valid) throw new Error(`第 ${index + 1} 项的 sourcePage 必须是 HTTP(S) 文章链接`);
  }
  return { source, alt, caption, widthPercent, sourcePage, assetAlt, tags };
}

export async function readInputs(paths, input, command) {
  let base = process.cwd();
  let entries = paths;
  if (input !== undefined) {
    if (paths.length) throw new Error("位置参数与 --input 只能选一种");
    const json = input === "-" ? await text(process.stdin) : await fs.readFile(input, "utf8");
    if (input !== "-") base = path.dirname(path.resolve(input));
    const manifest = JSON.parse(json.replace(/^\uFEFF/, ""));
    entries = Array.isArray(manifest) ? manifest : manifest?.images;
  }
  if (!Array.isArray(entries) || !entries.length) throw new Error("请传入图片、目录或 --input 清单");
  const specs = entries.map(imageSpec);
  if (command === "migrate") return specs;
  const files = [];
  for (const spec of specs) {
    const source = path.resolve(base, spec.source);
    const originalname = path.basename(source);
    try {
      if (/^https?:\/\//i.test(spec.source)) throw new Error("远程图片请使用 migrate");
      const stat = await fs.stat(source);
      if (stat.isDirectory()) {
        const images = await walkFiles(source, Infinity, file => imageExtensions.has(path.extname(file).toLowerCase()));
        if (!images.length) throw new Error("目录中没有支持的图片");
        for (const file of images) files.push({ ...spec, ...file, source: file.path });
      } else {
        if (!stat.isFile()) throw new Error("路径不是普通文件");
        files.push({ ...spec, source, originalname, path: source, size: stat.size });
      }
    } catch (error) {
      files.push({ ...spec, source: /^https?:\/\//i.test(spec.source) ? spec.source : source, originalname, error: error.message });
    }
  }
  return files;
}
