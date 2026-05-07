import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import express from "express";
import multer from "multer";
import sharp from "sharp";

const app = express();
const PORT = Number(process.env.PORT ?? 5177);
const PICGO_PATH = process.env.PICGO_PATH ?? "C:\\nvm4w\\nodejs\\picgo.cmd";
const ROOT_DIR = process.cwd();
const TMP_DIR = path.join(ROOT_DIR, "tmp");
const INPUT_DIR = path.join(TMP_DIR, "input");
const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(TMP_DIR, "output");

await fs.mkdir(INPUT_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await cleanupDirectory(INPUT_DIR);
await cleanupDirectory(OUTPUT_DIR);

const upload = multer({
  dest: INPUT_DIR,
  limits: {
    files: 1000,
    fileSize: 100 * 1024 * 1024
  }
});

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tif",
  ".tiff"
]);

app.use(express.static(path.join(ROOT_DIR, "public")));
app.use("/preview", express.static(OUTPUT_DIR));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    picgoPath: PICGO_PATH
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
      const compressed = await compressToWebp({
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
        OUTPUT_DIR,
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

  const files = await walkFiles(directory);
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
      const compressed = await compressToWebp({
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
        OUTPUT_DIR,
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

app.post("/api/upload-picgo", async (req, res) => {
  const { fileId } = req.body;
  if (!fileId || typeof fileId !== "string" || fileId.includes("..") || path.isAbsolute(fileId)) {
    return res.status(400).json({ error: "Invalid fileId" });
  }

  let filePath;
  try {
    filePath = resolveOutputFile(fileId);
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
    const uploadResult = await uploadWithPicgo(filePath, (line) => {
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
    await cleanupEmptyParents(path.dirname(filePath), OUTPUT_DIR);
    res.end();
  }
});

app.post("/api/cleanup", async (_req, res) => {
  try {
    await cleanupDirectory(OUTPUT_DIR);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`PicGo WebP uploader running at http://localhost:${PORT}`);
  console.log(`Using PicGo CLI: ${PICGO_PATH}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Close the existing process or start this app with another port, for example:`);
    console.error(`  $env:PORT=5178; npm start`);
    process.exit(1);
  }

  throw error;
});

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

function uploadWithPicgo(filePath, onLog) {
  const TIMEOUT_MS = 120_000;

  return new Promise((resolve, reject) => {
    const child = spawn(PICGO_PATH, ["upload", filePath], {
      windowsHide: true,
      shell: process.platform === "win32"
    });

    let raw = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`PicGo 上传超时 (${TIMEOUT_MS / 1000}s)`));
      }
    }, TIMEOUT_MS);

    const handleChunk = (chunk, isError = false) => {
      const text = chunk.toString();
      raw += text;
      if (isError) {
        stderr += text;
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          onLog(trimmed);
        }
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk));
    child.stderr.on("data", (chunk) => handleChunk(chunk, true));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr || raw || `PicGo exited with code ${code}`));
        return;
      }

      const urls = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      resolve({
        raw,
        url: urls.at(-1) ?? ""
      });
    });
  });
}

function resolveOutputFile(fileId) {
  const resolved = path.resolve(OUTPUT_DIR, fileId);
  const root = path.resolve(OUTPUT_DIR);
  if (
    resolved !== root &&
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("Invalid fileId");
  }
  return resolved;
}

function normalizeUploadName(name) {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? name : decoded;
  } catch {
    return name;
  }
}

async function cleanupDirectory(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function cleanupFiles(files) {
  await Promise.allSettled(
    files.map((file) =>
      fs.rm(file, {
        force: true
      })
    )
  );
}

async function cleanupEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (current.startsWith(stop) && current !== stop) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

async function walkFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.stat(fullPath);
      const relativeName = path.relative(root, fullPath).split(path.sep).join("/");
      files.push({
        path: fullPath,
        originalname: relativeName,
        size: stat.size
      });
    }
  }

  await visit(root);
  return files;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function percentageSaved(original, compressed) {
  if (!original) {
    return 0;
  }
  return Math.round((1 - compressed / original) * 1000) / 10;
}
