import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { imageExtensions, percentageSaved } from "../utils/image.mjs";

export function createCompressService({ outputDir }) {
  async function compressToWebp({
    inputPath,
    quality,
    effort,
    maxWidth
  }) {
    let pipeline = sharp(inputPath, {
      failOn: "none",
      animated: false
    }).rotate();

    if (maxWidth > 0) {
      pipeline = pipeline.resize({
        width: maxWidth,
        withoutEnlargement: true
      });
    }

    const { data, info } = await pipeline
      .webp({
        quality,
        effort,
        smartSubsample: true
      })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      bytes: info.size,
      width: info.width,
      height: info.height
    };
  }

  async function compressFilesToJson({
    files,
    quality,
    effort,
    maxWidth,
    compressConcurrency,
    source,
    sourceDirectory
  }) {
    const batchId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const items = [];
    let nextFileIndex = 0;

    const runWorker = async () => {
      while (nextFileIndex < files.length) {
        const index = nextFileIndex;
        nextFileIndex += 1;
        const file = files[index];
        const name = file.originalname;
        const ext = path.extname(name).toLowerCase();

        if (!imageExtensions.has(ext)) {
          items[index] = {
            ok: false,
            skipped: true,
            index,
            name,
            originalBytes: file.size,
            reason: `unsupported format: ${ext || "(no extension)"}`
          };
          continue;
        }

        try {
          let outputData;
          let outputBytes;
          let outputExt;
          let width = null;
          let height = null;

          if (ext === ".svg") {
            // SVG 不走 Sharp 转换，直接读取原图并输出
            outputData = await fs.readFile(file.path);
            outputBytes = outputData.length;
            outputExt = ".svg";
          } else {
            const compressed = await compressToWebp({
              inputPath: file.path,
              quality,
              effort,
              maxWidth
            });
            outputData = compressed.data;
            outputBytes = compressed.bytes;
            outputExt = ".webp";
            width = compressed.width;
            height = compressed.height;
          }

          const md5 = crypto.createHash("md5").update(outputData).digest("hex");
          const now = new Date();
          const year = String(now.getFullYear());
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const day = String(now.getDate()).padStart(2, "0");
          const relPath = `${batchId}/${year}/${month}/${day}/${index}-${md5}${outputExt}`;
          const outputPath = path.join(outputDir, batchId, year, month, day, `${index}-${md5}${outputExt}`);

          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, outputData);

          items[index] = {
            ok: true,
            index,
            name,
            fileId: relPath,
            previewUrl: `/preview/${relPath}`,
            originalBytes: file.size,
            compressedBytes: outputBytes,
            savedPercent: ext === ".svg" ? 0 : percentageSaved(file.size, outputBytes),
            width,
            height,
            md5
          };
        } catch (error) {
          items[index] = {
            ok: false,
            index,
            name,
            originalBytes: file.size,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(compressConcurrency, files.length) },
        () => runWorker()
      )
    );

    const compressedItems = items.filter((item) => item?.ok);
    const skipped = items.filter((item) => item?.skipped).length;
    const failed = items.filter((item) => item && !item.ok && !item.skipped).length;
    const originalBytes = items.reduce((sum, item) => sum + (item?.originalBytes ?? 0), 0);
    const compressedBytes = compressedItems.reduce((sum, item) => sum + item.compressedBytes, 0);

    return {
      ok: failed === 0,
      jobId: batchId,
      source,
      sourceDirectory,
      startedAt,
      finishedAt: new Date().toISOString(),
      options: {
        quality,
        effort,
        maxWidth: maxWidth || null,
        compressConcurrency
      },
      total: files.length,
      compressed: compressedItems.length,
      skipped,
      failed,
      originalBytes,
      compressedBytes,
      savedPercent: percentageSaved(originalBytes, compressedBytes),
      items
    };
  }

  return {
    compressToWebp,
    compressFilesToJson
  };
}
