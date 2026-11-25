import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TMP_DIR, UPLOAD_SETTINGS } from "../config.mjs";
import { createCompressService } from "../services/compress.mjs";
import { createRemoteImageService } from "../services/remoteImages.mjs";
import { createUploadService } from "../services/upload.mjs";
import { mapConcurrent } from "../utils/batch.mjs";
import { imageMarkdown } from "../../public/markdown.mjs";

async function writeJson(target, result) {
  const temporary = target + "." + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function runBatch(command, inputs, options) {
  const jobId = crypto.randomUUID();
  const resultPath = path.resolve(options.output ?? path.join(TMP_DIR, "cli-results", jobId, "result.json"));
  if (inputs.some(file => file.path && path.relative(resultPath, file.path) === "")
    || (options.input && options.input !== "-" && path.relative(resultPath, options.input) === "")) {
    throw new Error("--output 与输入路径重复");
  }
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "picgo-webp-"));
  try {
    const uploader = createUploadService({ ...UPLOAD_SETTINGS, outputDir: work, backend: options.backend });
    let files = inputs;
    if (command === "migrate") {
      const remote = createRemoteImageService({ inputDir: work, maxUrls: Infinity });
      const batch = await remote.downloadImagesFromUrls(inputs.map(item => item.source), {
        downloadConcurrency: options.downloadConcurrency, allowPartial: true
      });
      files = inputs.map((spec, index) => ({ ...spec, ...batch.files[index] }));
    }
    const compression = await createCompressService({ outputDir: work }).compressFilesToJson({
      files, ...options, source: command, jobId
    });
    // One upload per final filename within this run. Keep every source occurrence and caption.
    const uploads = new Map();
    const items = await mapConcurrent(compression.items, options.uploadConcurrency, async item => {
      const file = files[item.index];
      const originalName = path.basename(item.name);
      const alt = file.alt ?? path.parse(originalName).name;
      const row = { index: item.index, source: file.source, sourcePage: file.sourcePage ?? null, originalName, alt,
        caption: file.caption ?? null, widthPercent: file.widthPercent ?? null };
      if (!item.ok) return { ...row, ok: false, error: item.error ?? item.reason };
      const { outputName, md5, width, height, originalBytes, compressedBytes, mimeType, keptOriginal } = item;
      Object.assign(row, { outputName, md5, width, height, originalBytes, compressedBytes, mimeType, keptOriginal });
      try {
        const shared = uploads.has(outputName);
        if (!shared) {
          uploads.set(outputName, uploader.uploadFile(item.fileId, undefined, {
            originalName, md5, mimeType, compressedBytes, assetAlt: file.assetAlt, tags: file.tags
          }));
        }
        const result = await uploads.get(outputName);
        const { url } = result;
        const asset = options.backend === "gallery" ? { ...result, duplicate: shared || result.duplicate } : {};
        return { ...row, ...asset, ok: true, url, markdown: imageMarkdown({ ...row, url }) };
      } catch (error) {
        return { ...row, ok: false, error: error.message };
      }
    });
    const succeeded = items.filter(item => item.ok).length;
    const result = {
      schemaVersion: 1, jobId, command, startedAt: compression.startedAt,
      options: { ...compression.options, backend: options.backend, prefix: options.prefix ?? "", naming: options.naming,
        uploadConcurrency: options.uploadConcurrency, downloadConcurrency: options.downloadConcurrency },
      ok: succeeded === items.length && !items.some(item => item.metadataError), total: items.length, succeeded,
      failed: items.length - succeeded, resultPath, items
    };
    try {
      await writeJson(resultPath, result);
    } catch (error) {
      // stdout still carries every successful link if the results disk fills up.
      result.ok = false;
      result.error = `清单保存失败: ${error.message}`;
      result.resultPath = null;
    }
    return result;
  } finally {
    try {
      await fs.rm(work, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.error(`临时目录清理失败 ${work}: ${error.message}`);
    }
  }
}
