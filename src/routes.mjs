import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clampNumber, normalizeUploadName, percentageSaved, imageExtensions } from "./utils/image.mjs";
import { cleanupEmptyParents, cleanupFiles, resolveOutputFile, walkFiles } from "./utils/files.mjs";

export function registerRoutes(app, {
  upload,
  outputDir,
  picgoPath,
  compressService,
  remoteImageService,
  uploadService,
  cleanupDirectory
}) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      picgoPath
    });
  });

  app.post("/api/compress", upload.array("images"), async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    const quality = clampNumber(req.body.quality, 1, 100, 82);
    const effort = clampNumber(req.body.effort, 0, 6, 6);
    const maxWidth = clampNumber(req.body.maxWidth, 0, 20000, 0);
    const compressConcurrency = clampNumber(req.body.compressConcurrency, 1, 64, 8);
    const baseIndex = clampNumber(req.body.baseIndex, 0, 1_000_000, 0);
    const batchNumber = clampNumber(req.body.batchNumber, 1, 10_000, 1);
    const totalBatches = clampNumber(req.body.totalBatches, 1, 10_000, 1);
    const files = req.files ?? [];
    const cleanupPaths = files.map((file) => file.path);
    const batchId = crypto.randomUUID();
    let clientDisconnected = false;
    let nextFileIndex = 0;

    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    const send = (event) => {
      if (clientDisconnected) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        clientDisconnected = true;
      }
    };

    send({
      type: "start",
      total: files.length,
      quality,
      effort,
      maxWidth: maxWidth || null,
      compressConcurrency,
      baseIndex,
      batchNumber,
      totalBatches
    });

    const processFile = async (index) => {
      if (clientDisconnected) return;

      const file = files[index];
      const publicIndex = baseIndex + index;
      const originalName = normalizeUploadName(file.originalname);
      const ext = path.extname(originalName).toLowerCase();

      send({
        type: "file-start",
        index: publicIndex,
        total: files.length,
        name: originalName,
        originalBytes: file.size
      });

      if (!imageExtensions.has(ext)) {
        send({
          type: "file-skip",
          index: publicIndex,
          name: originalName,
          reason: `不支持的格式: ${ext || "(无扩展名)"}`
        });
        return;
      }

      try {
        const compressed = await compressService.compressToWebp({
          inputPath: file.path,
          quality,
          effort,
          maxWidth
        });

        const md5 = crypto.createHash("md5").update(compressed.data).digest("hex");
        const now = new Date();
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");

        const relPath = `${batchId}/${year}/${month}/${day}/${publicIndex}-${md5}.webp`;
        const outputPath = path.join(
          outputDir,
          batchId,
          year,
          month,
          day,
          `${publicIndex}-${md5}.webp`
        );

        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, compressed.data);

        send({
          type: "compressed",
          index: publicIndex,
          name: originalName,
          outputName: relPath,
          previewUrl: `/preview/${relPath}`,
          fileId: relPath,
          originalBytes: file.size,
          compressedBytes: compressed.bytes,
          savedPercent: percentageSaved(file.size, compressed.bytes),
          width: compressed.width,
          height: compressed.height
        });

        send({
          type: "file-done",
          index: publicIndex,
          name: originalName
        });
      } catch (error) {
        send({
          type: "file-error",
          index: publicIndex,
          name: originalName,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const runWorker = async () => {
      while (!clientDisconnected && nextFileIndex < files.length) {
        const index = nextFileIndex;
        nextFileIndex += 1;
        await processFile(index);
      }
    };

    try {
      const workers = Array.from(
        { length: Math.min(compressConcurrency, files.length) },
        () => runWorker()
      );
      await Promise.all(workers);

      send({
        type: "done"
      });
    } finally {
      await cleanupFiles(cleanupPaths);
      res.end();
    }
  });

  app.post("/api/compress-directory", async (req, res) => {
    const directory = typeof req.body.directory === "string"
      ? path.resolve(req.body.directory)
      : "";

    if (!directory) {
      return res.status(400).json({ error: "目录路径不能为空" });
    }

    let stat;
    try {
      stat = await fs.stat(directory);
    } catch {
      return res.status(400).json({ error: "目录不存在或无法访问" });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "路径不是目录" });
    }

    let files;
    try {
      files = await walkFiles(directory);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (files.length > 2000) {
      return res.status(400).json({ error: "目录文件过多，请先拆分到 2000 个以内" });
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    const quality = clampNumber(req.body.quality, 1, 100, 82);
    const effort = clampNumber(req.body.effort, 0, 6, 6);
    const maxWidth = clampNumber(req.body.maxWidth, 0, 20000, 0);
    const compressConcurrency = clampNumber(req.body.compressConcurrency, 1, 64, 8);
    const batchId = crypto.randomUUID();
    let clientDisconnected = false;
    let nextFileIndex = 0;

    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    const send = (event) => {
      if (clientDisconnected) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        clientDisconnected = true;
      }
    };

    send({
      type: "start",
      total: files.length,
      quality,
      effort,
      maxWidth: maxWidth || null,
      compressConcurrency,
      source: "directory"
    });

    const processFile = async (index) => {
      if (clientDisconnected) return;

      const file = files[index];
      const ext = path.extname(file.originalname).toLowerCase();

      send({
        type: "file-start",
        index,
        total: files.length,
        name: file.originalname,
        originalBytes: file.size
      });

      if (!imageExtensions.has(ext)) {
        send({
          type: "file-skip",
          index,
          name: file.originalname,
          reason: `不支持的格式: ${ext || "(无扩展名)"}`
        });
        return;
      }

      try {
        const compressed = await compressService.compressToWebp({
          inputPath: file.path,
          quality,
          effort,
          maxWidth
        });

        const md5 = crypto.createHash("md5").update(compressed.data).digest("hex");
        const now = new Date();
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const relPath = `${batchId}/${year}/${month}/${day}/${index}-${md5}.webp`;
        const outputPath = path.join(
          outputDir,
          batchId,
          year,
          month,
          day,
          `${index}-${md5}.webp`
        );

        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, compressed.data);

        send({
          type: "compressed",
          index,
          name: file.originalname,
          outputName: relPath,
          previewUrl: `/preview/${relPath}`,
          fileId: relPath,
          originalBytes: file.size,
          compressedBytes: compressed.bytes,
          savedPercent: percentageSaved(file.size, compressed.bytes),
          width: compressed.width,
          height: compressed.height
        });

        send({
          type: "file-done",
          index,
          name: file.originalname
        });
      } catch (error) {
        send({
          type: "file-error",
          index,
          name: file.originalname,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const runWorker = async () => {
      while (!clientDisconnected && nextFileIndex < files.length) {
        const index = nextFileIndex;
        nextFileIndex += 1;
        await processFile(index);
      }
    };

    try {
      const workers = Array.from(
        { length: Math.min(compressConcurrency, files.length) },
        () => runWorker()
      );
      await Promise.all(workers);

      send({ type: "done" });
    } finally {
      res.end();
    }
  });

  app.post("/api/cli/compress", upload.array("images"), async (req, res) => {
    const quality = clampNumber(req.body.quality, 1, 100, 82);
    const effort = clampNumber(req.body.effort, 0, 6, 6);
    const maxWidth = clampNumber(req.body.maxWidth, 0, 20000, 0);
    const compressConcurrency = clampNumber(req.body.compressConcurrency, 1, 64, 8);
    const uploadedFiles = req.files ?? [];
    const cleanupPaths = uploadedFiles.map((file) => file.path);
    let files;
    let source;

    try {
      if (Array.isArray(req.body.files)) {
        files = await collectLocalFiles(req.body.files);
        source = "local-files";
      } else {
        files = uploadedFiles.map((file) => ({
          path: file.path,
          originalname: normalizeUploadName(file.originalname),
          size: file.size
        }));
        source = "multipart";
      }

      const result = await compressService.compressFilesToJson({
        files,
        quality,
        effort,
        maxWidth,
        compressConcurrency,
        source
      });

      res.json(result);
    } catch (error) {
      const isClientError = error instanceof Error && error.message.startsWith("Invalid files:");
      res.status(isClientError ? 400 : 500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await cleanupFiles(cleanupPaths);
    }
  });

  app.post("/api/cli/compress-directory", async (req, res) => {
    const directory = typeof req.body.directory === "string"
      ? path.resolve(req.body.directory)
      : "";

    if (!directory) {
      return res.status(400).json({ ok: false, error: "directory is required" });
    }

    let stat;
    try {
      stat = await fs.stat(directory);
    } catch {
      return res.status(400).json({ ok: false, error: "directory does not exist or cannot be accessed" });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ ok: false, error: "directory must point to a folder" });
    }

    let files;
    try {
      files = await walkFiles(directory);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (files.length > 2000) {
      return res.status(400).json({ ok: false, error: "too many files; split the directory to 2000 files or fewer" });
    }

    try {
      const result = await compressService.compressFilesToJson({
        files,
        quality: clampNumber(req.body.quality, 1, 100, 82),
        effort: clampNumber(req.body.effort, 0, 6, 6),
        maxWidth: clampNumber(req.body.maxWidth, 0, 20000, 0),
        compressConcurrency: clampNumber(req.body.compressConcurrency, 1, 64, 8),
        source: "directory",
        sourceDirectory: directory
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/cli/compress-urls", async (req, res) => {
    const quality = clampNumber(req.body.quality, 1, 100, 82);
    const effort = clampNumber(req.body.effort, 0, 6, 6);
    const maxWidth = clampNumber(req.body.maxWidth, 0, 20000, 0);
    const compressConcurrency = clampNumber(req.body.compressConcurrency, 1, 64, 8);
    const downloadConcurrency = clampNumber(req.body.downloadConcurrency, 1, 16, 4);
    let remoteBatch;

    try {
      remoteBatch = await remoteImageService.downloadImagesFromUrls(req.body.urls, {
        downloadConcurrency
      });

      const result = await compressService.compressFilesToJson({
        files: remoteBatch.files,
        quality,
        effort,
        maxWidth,
        compressConcurrency,
        source: "remote-urls"
      });

      res.json({
        ...result,
        downloads: remoteBatch.downloads
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isClientError =
        message.startsWith("Invalid urls:") ||
        message.startsWith("Download failed:");

      res.status(isClientError ? 400 : 500).json({
        ok: false,
        error: message
      });
    } finally {
      if (remoteBatch?.jobDir) {
        await fs.rm(remoteBatch.jobDir, { recursive: true, force: true });
      }
    }
  });

  app.post("/api/cli/upload", async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        ok: false,
        error: "upload requires confirm: true"
      });
    }

    const uploadConcurrency = clampNumber(req.body.uploadConcurrency, 1, 10, 5);
    let fileIds;

    try {
      fileIds = await uploadService.collectUploadFileIds(req.body);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const items = [];
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < fileIds.length) {
        const index = nextIndex;
        nextIndex += 1;
        const fileId = fileIds[index];
        const filePath = resolveOutputFile(outputDir, fileId);

        try {
          await fs.access(filePath);
          const logs = [];
          const uploadResult = await uploadService.uploadWithPicgo(filePath, (line) => logs.push(line));
          items[index] = {
            ok: true,
            fileId,
            url: uploadResult.url,
            raw: uploadResult.raw,
            logs
          };
          await cleanupFiles([filePath]);
          await cleanupEmptyParents(path.dirname(filePath), outputDir);
        } catch (error) {
          items[index] = {
            ok: false,
            fileId,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(uploadConcurrency, fileIds.length) },
        () => runWorker()
      )
    );

    const succeeded = items.filter((item) => item?.ok).length;
    res.json({
      ok: succeeded === items.length,
      total: items.length,
      succeeded,
      failed: items.length - succeeded,
      items,
      urls: items.filter((item) => item?.ok && item.url).map((item) => item.url)
    });
  });

  app.post("/api/upload-picgo", async (req, res) => {
    const { fileId } = req.body;
    if (!fileId || typeof fileId !== "string" || fileId.includes("..") || path.isAbsolute(fileId)) {
      return res.status(400).json({ error: "Invalid fileId" });
    }

    let filePath;
    try {
      filePath = resolveOutputFile(outputDir, fileId);
    } catch {
      return res.status(400).json({ error: "Invalid fileId" });
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    const send = (event) => {
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        // ignore
      }
    };

    try {
      await fs.access(filePath);
    } catch {
      send({ type: "error", message: "文件不存在或已过期" });
      return res.end();
    }

    try {
      const uploadResult = await uploadService.uploadWithPicgo(filePath, (line) => {
        send({ type: "picgo-log", message: line });
      });

      send({
        type: "done",
        url: uploadResult.url,
        raw: uploadResult.raw
      });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await cleanupFiles([filePath]);
      await cleanupEmptyParents(path.dirname(filePath), outputDir);
      res.end();
    }
  });

  app.post("/api/cleanup", async (_req, res) => {
    try {
      await cleanupDirectory(outputDir);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}

async function collectLocalFiles(inputFiles) {
  if (!inputFiles.length) {
    throw new Error("Invalid files: files must not be empty");
  }

  const files = [];
  for (const filePath of inputFiles) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("Invalid files: each file path must be a non-empty string");
    }

    const resolvedPath = path.resolve(filePath);
    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throw new Error(`Invalid files: cannot access ${filePath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Invalid files: not a file ${filePath}`);
    }

    files.push({
      path: resolvedPath,
      originalname: path.basename(resolvedPath),
      size: stat.size
    });
  }

  return files;
}
