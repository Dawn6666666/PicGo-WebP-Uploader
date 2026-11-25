import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { mapConcurrent } from "../utils/batch.mjs";
import { imageExtensions, outputMimeTypes, percentageSaved, clampNumber } from "../utils/image.mjs";
import { localDate, uploadName } from "../utils/naming.mjs";

export function compressionOptions(options = {}) {
  return {
    quality: clampNumber(options.quality, 1, 100, 82),
    effort: clampNumber(options.effort, 0, 6, 6),
    maxWidth: clampNumber(options.maxWidth, 0, 20000, 0),
    maxDimension: clampNumber(options.maxDimension, 0, 20000, 0),
    compressConcurrency: clampNumber(options.compressConcurrency, 1, 64, 8)
  };
}

async function prepareImage(input, { quality, effort, maxWidth, maxDimension }, rasterizeSvg) {
  // Read one frame's metadata so height means display height, even for animations.
  let metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch (error) {
    // A scalable SVG without an intrinsic canvas can still be uploaded verbatim.
    if (!rasterizeSvg && !maxWidth && !maxDimension && /svgload(?:_buffer)?: bad dimensions/.test(error.message)) {
      return { data: input, width: null, height: null, ext: ".svg", keptOriginal: true };
    }
    throw error;
  }
  const { format, autoOrient: { width, height } } = metadata;
  const widthLimit = Math.min(maxWidth || Infinity, maxDimension || Infinity);
  const resize = width > widthLimit || (maxDimension > 0 && height > maxDimension);
  const animated = (format === "gif" || format === "webp") && metadata.pages > 1;
  const original = { data: input, width, height, ext: "." + format, keptOriginal: true };

  if (!resize && (animated || format === "gif" || (format === "svg" && !rasterizeSvg))) return original;

  let pipeline = sharp(input, { animated }).autoOrient();
  if (resize) {
    pipeline = pipeline.resize({ width: widthLimit, height: maxDimension || undefined,
      fit: "inside", withoutEnlargement: true });
  }
  const { data, info } = await pipeline.webp({ quality, effort, smartSubsample: true }).toBuffer({ resolveWithObject: true });
  if (!resize && ["jpeg", "png", "webp"].includes(format) && data.length >= input.length) return original;
  return { data, width: info.width, height: info.pageHeight ?? info.height, ext: ".webp", keptOriginal: false };
}

export function createCompressService({ outputDir, galleryPreview = false }) {
  async function compressFilesToJson({ files, source, sourceDirectory, baseIndex = 0,
    jobId = crypto.randomUUID(), onEvent = () => {}, isCancelled = () => false,
    rasterizeSvg = false, prefix, naming, ...options }) {
    const settings = compressionOptions(options);
    const started = new Date();
    const date = localDate(started);
    const items = await mapConcurrent(files, settings.compressConcurrency, async (file, offset) => {
      const index = baseIndex + offset;
      const name = file.originalname;
      const ext = file.inputExt ?? path.extname(name).toLowerCase();
      const item = { index, name, originalBytes: file.size };
      if (isCancelled()) return { ...item, ok: false, skipped: true, reason: "cancelled" };
      onEvent({ type: "file-start", ...item, total: files.length });
      try {
        if (file.error) throw new Error(file.error);
        if (!imageExtensions.has(ext)) {
          const reason = `不支持的格式: ${ext || "(无扩展名)"}`;
          onEvent({ type: "file-skip", ...item, reason });
          return { ...item, ok: false, skipped: true, reason };
        }
        const input = await fs.readFile(file.path);
        item.originalBytes = input.length;
        const { data, width, height, ext: outputExt, keptOriginal } = await prepareImage(input, settings, rasterizeSvg);
        const md5 = crypto.createHash("md5").update(data).digest("hex");
        const outputName = uploadName({ name, md5, date, naming: galleryPreview ? "hash" : naming, prefix, ext: outputExt });
        const fileId = `${jobId}/${index}/${outputName}`;
        const target = path.join(outputDir, fileId);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const mimeType = outputMimeTypes.get(outputExt);
        // A job can be enumerated for upload while its other images are being prepared.
        const temporary = target + ".part";
        try {
          await fs.writeFile(temporary, data);
          if (galleryPreview) {
            const info = { originalName: path.basename(name), md5, mimeType, compressedBytes: data.length };
            await fs.writeFile(target + ".json", JSON.stringify(info));
          }
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          if (galleryPreview) await fs.rm(target + ".json", { force: true });
          throw error;
        }
        const result = {
          ...item, ok: true, fileId, outputName, md5,
          previewUrl: "/preview/" + fileId.split("/").map(encodeURIComponent).join("/"),
          compressedBytes: data.length, savedPercent: percentageSaved(input.length, data.length),
          width, height, mimeType, keptOriginal
        };
        onEvent({ type: "compressed", ...result });
        onEvent({ type: "file-done", index, name });
        return result;
      } catch (error) {
        onEvent({ type: "file-error", ...item, message: error.message });
        return { ...item, ok: false, error: error.message };
      }
    });

    const compressed = items.filter(item => item.ok);
    const skipped = items.filter(item => item.skipped).length;
    const failed = items.length - compressed.length - skipped;
    const originalBytes = items.reduce((sum, item) => sum + (item.originalBytes || 0), 0);
    const compressedBytes = compressed.reduce((sum, item) => sum + item.compressedBytes, 0);
    return {
      ok: failed === 0, jobId, source, sourceDirectory,
      startedAt: started.toISOString(), finishedAt: new Date().toISOString(),
      options: { ...settings, maxWidth: settings.maxWidth || null, maxDimension: settings.maxDimension || null },
      total: items.length, compressed: compressed.length, skipped, failed, originalBytes,
      compressedBytes, savedPercent: percentageSaved(originalBytes, compressedBytes), items
    };
  }
  return { compressFilesToJson };
}
