import fs from "node:fs/promises";
import path from "node:path";
import { clampNumber, normalizeUploadName } from "./utils/image.mjs";
import { cleanupFiles, walkFiles } from "./utils/files.mjs";
import { compressionOptions } from "./services/compress.mjs";

function multipartFiles(req) {
  return (req.files ?? []).map(file => ({ ...file, originalname: normalizeUploadName(file.originalname) }));
}

async function directoryFiles(directory) {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("目录路径不能为空");
  return walkFiles(directory);
}

async function localFiles(paths) {
  if (!paths.length) throw new Error("files must not be empty");
  const files = [];
  for (const input of paths) {
    if (typeof input !== "string" || !input.trim()) throw new Error("无效的文件路径");
    const resolved = path.resolve(input);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error(`不是文件: ${input}`);
    files.push({ path: resolved, originalname: path.basename(resolved), size: stat.size });
  }
  return files;
}

function eventStream(res) {
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  return event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n"); };
}

export function registerRoutes(app, { backend, upload, outputDir, picgoPath, compressService, remoteImageService, uploadService }) {
  app.get("/api/health", (_req, res) => res.json({ ok: true, backend, picgoPath }));

  function compressHandler(source, stream = false) {
    return async (req, res) => {
      const body = req.body ?? {};
      let remoteBatch;
      try {
        let files;
        let sourceType = source;
        if (source === "directory") files = await directoryFiles(body.directory);
        else if (source === "remote-urls") {
          remoteBatch = await remoteImageService.downloadImagesFromUrls(body.urls, {
            downloadConcurrency: clampNumber(body.downloadConcurrency, 1, 16, 4)
          });
          files = remoteBatch.files;
        } else if (!stream && Array.isArray(body.files)) {
          files = await localFiles(body.files);
          sourceType = "local-files";
        } else files = multipartFiles(req);

        const options = compressionOptions(body);
        const baseIndex = stream ? clampNumber(body.baseIndex, 0, 1000000, 0) : 0;
        const send = stream ? eventStream(res) : undefined;
        send?.({ type: "start", total: files.length, ...options, source: sourceType, baseIndex,
          batchNumber: clampNumber(body.batchNumber, 1, 10000, 1), totalBatches: clampNumber(body.totalBatches, 1, 10000, 1) });
        const result = await compressService.compressFilesToJson({
          files, ...options, source: sourceType, sourceDirectory: source === "directory" ? path.resolve(body.directory) : undefined,
          onEvent: send, baseIndex, isCancelled: () => res.destroyed, rasterizeSvg: stream && backend === "picgo"
        });
        if (stream) {
          send({ type: "done" });
          res.end();
        } else res.json({ ...result, downloads: remoteBatch?.downloads });
      } catch (error) {
        if (!res.headersSent) res.status(400).json({ ok: false, error: error.message });
        else res.end(JSON.stringify({ type: "error", message: error.message }) + "\n");
      } finally {
        await cleanupFiles((req.files ?? []).map(file => file.path));
        if (remoteBatch) await fs.rm(remoteBatch.jobDir, { recursive: true, force: true });
      }
    };
  }

  app.post("/api/compress", upload.array("images"), compressHandler("multipart", true));
  app.post("/api/compress-directory", compressHandler("directory", true));
  app.post("/api/cli/compress", upload.array("images"), compressHandler("multipart"));
  app.post("/api/cli/compress-directory", compressHandler("directory"));
  app.post("/api/cli/compress-urls", compressHandler("remote-urls"));

  app.post("/api/cli/upload", async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: "upload requires confirm: true" });
    try {
      const ids = await uploadService.collectUploadFileIds(req.body);
      res.json(await uploadService.uploadFiles(ids, clampNumber(req.body.uploadConcurrency, 1, 10, 5)));
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/upload-picgo", async (req, res) => {
    let ids;
    try { ids = await uploadService.collectUploadFileIds({ fileIds: [req.body?.fileId] }); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const send = eventStream(res);
    try {
      const result = await uploadService.uploadFile(ids[0], message => send({ type: "picgo-log", message }));
      send({ type: "done", ...result });
    } catch (error) { send({ type: "error", message: error.message }); }
    res.end();
  });

  app.post("/api/cleanup", async (req, res) => {
    try {
      const batchId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
      let ids = req.body?.jobIds;
      if (ids === undefined) {
        const entries = await fs.readdir(outputDir, { withFileTypes: true });
        ids = entries.filter(entry => entry.isDirectory() && batchId.test(entry.name)).map(entry => entry.name);
      }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !batchId.test(id))) {
        return res.status(400).json({ ok: false, error: "Invalid jobIds" });
      }
      for (const id of ids) await fs.rm(path.join(outputDir, id), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}
