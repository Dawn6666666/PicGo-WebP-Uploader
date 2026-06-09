import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { imageExtensions } from "../utils/image.mjs";

const contentTypeExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["image/tiff", ".tif"]
]);

export function createRemoteImageService({
  inputDir,
  maxUrls = 100,
  maxBytes = 100 * 1024 * 1024,
  timeoutMs = 30_000
}) {
  async function downloadImagesFromUrls(urls, { downloadConcurrency = 4 } = {}) {
    if (!Array.isArray(urls) || !urls.length) {
      throw new Error("Invalid urls: urls must not be empty");
    }

    if (urls.length > maxUrls) {
      throw new Error(`Invalid urls: too many urls, max ${maxUrls}`);
    }

    const jobId = crypto.randomUUID();
    const jobDir = path.join(inputDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    try {
      const items = [];
      let nextIndex = 0;

      const runWorker = async () => {
        while (nextIndex < urls.length) {
          const index = nextIndex;
          nextIndex += 1;
          items[index] = await downloadOne(urls[index], index, jobDir);
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(downloadConcurrency, urls.length) },
          () => runWorker()
        )
      );

      const failed = items.filter((item) => !item.ok);
      if (failed.length) {
        const first = failed[0];
        throw new Error(`Download failed: ${first.url} - ${first.error}`);
      }

      return {
        jobId,
        jobDir,
        files: items.map((item) => item.file),
        downloads: items.map(({ file, ...item }) => item)
      };
    } catch (error) {
      await fs.rm(jobDir, { recursive: true, force: true });
      throw error;
    }
  }

  async function downloadOne(inputUrl, index, jobDir) {
    try {
      const url = parseImageUrl(inputUrl);
      let response;
      const maxRetries = 5;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
          });
          clearTimeout(timer);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          break;
        } catch (error) {
          clearTimeout(timer);
          if (attempt === maxRetries) {
            throw error;
          }
          console.warn(`[RemoteImageService] 下载 ${url} 失败（第 ${attempt} 次尝试）: ${error.message}，准备重试...`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`file too large (${contentLength} bytes)`);
      }

      const contentType = normalizeContentType(response.headers.get("content-type"));
      const ext = pickExtension(url, contentType);
      const name = buildFileName(url, index, ext);
      const filePath = path.join(jobDir, name);
      const bytes = await writeResponseBodyWithLimit(response, filePath, maxBytes);

      return {
        ok: true,
        url: String(url),
        contentType,
        bytes: bytes,
        file: {
          path: filePath,
          originalname: name,
          size: bytes
        }
      };
    } catch (error) {
      return {
        ok: false,
        url: typeof inputUrl === "string" ? inputUrl : String(inputUrl),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    downloadImagesFromUrls
  };
}

async function writeResponseBodyWithLimit(response, filePath, maxBytes) {
  if (!response.body) {
    throw new Error("empty response body");
  }

  const file = await fs.open(filePath, "w");
  let bytes = 0;

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`file too large (${bytes} bytes)`);
      }
      await file.write(buffer);
    }
  } catch (error) {
    await file.close();
    await fs.rm(filePath, { force: true });
    throw error;
  }

  await file.close();
  return bytes;
}

function parseImageUrl(inputUrl) {
  if (typeof inputUrl !== "string" || !inputUrl.trim()) {
    throw new Error("url must be a non-empty string");
  }

  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new Error("invalid url");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("only http and https urls are allowed");
  }

  return url;
}

function normalizeContentType(contentType) {
  return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

function pickExtension(url, contentType) {
  const fromContentType = contentTypeExtensions.get(contentType);
  if (fromContentType) {
    return fromContentType;
  }

  const fromUrl = path.extname(decodeURIComponent(url.pathname)).toLowerCase();
  if (imageExtensions.has(fromUrl)) {
    return fromUrl;
  }

  throw new Error(`unsupported image type: ${contentType || "unknown"}`);
}

function buildFileName(url, index, ext) {
  const baseName = path.basename(decodeURIComponent(url.pathname), path.extname(url.pathname));
  const safeName = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80)
    || "remote-image";

  return `${index}-${safeName}${ext}`;
}
