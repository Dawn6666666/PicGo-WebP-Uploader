import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { mapConcurrent } from "../utils/batch.mjs";
import { imageExtensions } from "../utils/image.mjs";

const contentTypeExtensions = new Map([
  ["image/jpeg", ".jpg"], ["image/jpg", ".jpg"], ["image/png", ".png"],
  ["image/webp", ".webp"], ["image/avif", ".avif"], ["image/tiff", ".tif"],
  ["image/svg+xml", ".svg"], ["image/gif", ".gif"]
]);

function remoteName(url) {
  const segment = url.pathname.split("/").at(-1) || "image";
  try { return decodeURIComponent(segment); } catch { return segment; }
}

export function createRemoteImageService({ inputDir, maxUrls = 100, maxBytes = 100 * 1024 * 1024, timeoutMs = 30000 }) {
  async function downloadOne(source, index, jobDir) {
    let name = "image";
    try {
      const url = new URL(source);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 HTTP(S) 图片链接");
      name = remoteName(url);
      const target = path.join(jobDir, String(index));
      for (let attempt = 1; ; attempt++) {
        const signal = AbortSignal.timeout(timeoutMs);
        let response;
        try {
          response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("图片过大");
          const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const inputExt = contentTypeExtensions.get(contentType) ?? path.extname(name).toLowerCase();
          const xmlSvg = inputExt === ".svg" && ["application/xml", "text/xml"].includes(contentType);
          if (!imageExtensions.has(inputExt) || (contentType && !contentTypeExtensions.has(contentType)
            && !xmlSvg && !["application/octet-stream", "binary/octet-stream"].includes(contentType))) {
            throw new Error(`不支持的图片类型: ${contentType || inputExt}`);
          }
          if (!response.body) throw new Error("下载响应为空");
          let bytes = 0;
          await pipeline(response.body, async function* (chunks) {
            for await (const chunk of chunks) {
              bytes += chunk.byteLength;
              if (bytes > maxBytes) throw new Error("图片过大");
              yield chunk;
            }
          }, createWriteStream(target), { signal });
          return { ok: true, url: source, bytes, contentType,
            file: { path: target, originalname: name, source, inputExt, size: bytes } };
        } catch (error) {
          await response?.body?.cancel().catch(() => {});
          if (attempt >= 3 || (response && response.status !== 429 && response.status < 500)) throw error;
          await delay(250 * attempt);
        }
      }
    } catch (error) {
      return { ok: false, url: source, error: error.message,
        file: { originalname: name, source, error: error.message } };
    }
  }

  async function downloadImagesFromUrls(urls, { downloadConcurrency = 4, allowPartial = false } = {}) {
    if (!Array.isArray(urls) || !urls.length || urls.length > maxUrls) {
      throw new Error(`Invalid urls: 需要 1 至 ${maxUrls} 条链接`);
    }
    const jobId = crypto.randomUUID();
    const jobDir = path.join(inputDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    try {
      const items = await mapConcurrent(urls, downloadConcurrency, (url, index) => downloadOne(url, index, jobDir));
      const failed = items.find(item => !item.ok);
      if (failed && !allowPartial) throw new Error(`Download failed: ${failed.url} - ${failed.error}`);
      return { jobId, jobDir, files: items.map(item => item.file), downloads: items.map(({ file, ...item }) => item) };
    } catch (error) {
      await fs.rm(jobDir, { recursive: true, force: true });
      throw error;
    }
  }
  return { downloadImagesFromUrls };
}
