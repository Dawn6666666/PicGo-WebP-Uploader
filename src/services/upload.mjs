import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cleanupEmptyParents, cleanupFiles, resolveOutputDirectory, resolveOutputFile, walkFiles } from "../utils/files.mjs";
import { mapConcurrent } from "../utils/batch.mjs";
import { outputMimeTypes } from "../utils/image.mjs";
import { createGalleryClient } from "./gallery.mjs";

function uploadable(file) {
  return outputMimeTypes.has(path.extname(file).toLowerCase());
}

async function previewInfo(filePath) {
  try { return JSON.parse(await fs.readFile(filePath + ".json", "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Previews produced before gallery support still have a usable filename and bytes.
  const hash = createHash("md5");
  let compressedBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    compressedBytes += chunk.length;
  }
  return { originalName: path.basename(filePath), mimeType: outputMimeTypes.get(path.extname(filePath).toLowerCase()),
    md5: hash.digest("hex"), compressedBytes };
}

function finalUrl(stdout) {
  // PicGo logs the result after its SUCCESS marker. A wrapper may print just the URL.
  const lines = stripVTControlCharacters(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const marker = /\[(?:PicGo\s+)?SUCCESS\]\s*:?\s*/i;
  const success = lines.findLastIndex(line => marker.test(line));
  let value = lines.at(-1);
  if (success >= 0) {
    const inline = lines[success].split(marker).at(-1);
    value = inline || lines[success + 1];
  } else {
    const error = lines.find(line => /\[(?:PicGo\s+)?ERROR\]/i.test(line));
    if (error) throw new Error(error);
  }
  if (/^https?:\/\//i.test(value)) {
    try { return new URL(value).href; } catch { /* report a missing or malformed result */ }
  }
  throw new Error("PicGo 未返回有效的图床 URL，请检查图床配置或上传日志");
}

function startPicgo(command, filePath, configPath) {
  const options = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  const args = ["upload", filePath];
  if (configPath) args.push("-c", path.resolve(configPath));
  if (process.platform !== "win32" || /\.(exe|com)$/i.test(command)) {
    return spawn(command, args, options);
  }

  // npm installs a batch shim on Windows. Keep paths in quoted environment
  // expansions, never interpolate their contents into the command itself.
  const env = { ...process.env, PG_UPLOAD_COMMAND: command, PG_UPLOAD_FILE: filePath };
  let invocation = '"%PG_UPLOAD_COMMAND%" upload "%PG_UPLOAD_FILE%"';
  if (configPath) {
    env.PG_UPLOAD_CONFIG = path.resolve(configPath);
    invocation += ' -c "%PG_UPLOAD_CONFIG%"';
  }
  if ([command, filePath, env.PG_UPLOAD_CONFIG ?? ""].some(arg => /["\r\n]/.test(arg))) {
    throw new Error("Windows 路径不能包含双引号或换行");
  }
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", '"' + invocation + '"'],
    { ...options, env, windowsVerbatimArguments: true });
}

export function createUploadService({ picgoPath, outputDir, configPath = process.env.PICGO_CONFIG, backend = "picgo" }) {
  const gallery = backend === "gallery" ? createGalleryClient() : null;
  const pending = new Map();
  const galleryUploads = new Map();

  async function uploadToGallery(filePath, info) {
    const image = info ?? await previewInfo(filePath);
    if (galleryUploads.has(image.md5)) return { ...await galleryUploads.get(image.md5), duplicate: true };
    const upload = gallery.upload(filePath, { ...image, outputName: path.basename(filePath) });
    galleryUploads.set(image.md5, upload);
    try { return await upload; } finally { galleryUploads.delete(image.md5); }
  }

  function uploadWithPicgo(filePath, onLog) {
    return new Promise((resolve, reject) => {
      const child = startPicgo(picgoPath, filePath, configPath);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("PicGo 上传超时 (120s)"));
      }, 120000);
      let stdout = "";
      let raw = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", text => {
          if (stream === child.stdout) stdout += text;
          raw += text;
          if (onLog) for (const line of text.trimEnd().split(/\r?\n/)) onLog(line);
        });
      }
      child.on("error", error => {
        clearTimeout(timer);
        reject(error.code === "ENOENT" ? new Error(`找不到 PicGo 命令 ${picgoPath}，请安装 PicGo CLI 或设置 PICGO_PATH`) : error);
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`PicGo 上传失败 (exit ${code}): ${raw.trim() || picgoPath}`));
        try { resolve({ raw, url: finalUrl(stdout) }); } catch (error) { reject(error); }
      });
    });
  }

  function validateId(fileId) {
    if (typeof fileId !== "string" || !fileId || fileId.split(/[\\/]/).includes("..")
      || path.isAbsolute(fileId) || !uploadable(fileId)) throw new Error("Invalid fileId");
    return resolveOutputFile(outputDir, fileId);
  }

  async function collectUploadFileIds(body) {
    if (Array.isArray(body?.fileIds)) {
      if (!body.fileIds.length) throw new Error("fileIds must not be empty");
      body.fileIds.forEach(validateId);
      return body.fileIds;
    }
    const jobId = body?.jobId;
    if (typeof jobId !== "string" || !jobId || /[\\/]/.test(jobId)) throw new Error("provide fileIds or jobId");
    const files = await walkFiles(resolveOutputDirectory(outputDir, jobId), Infinity, uploadable);
    const ids = files.map(file => path.relative(outputDir, file.path).split(path.sep).join("/"))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (!ids.length) throw new Error("jobId has no uploadable files");
    return ids;
  }

  async function uploadFile(fileId, onLog, image) {
    const filePath = validateId(fileId);
    if (pending.has(filePath)) return pending.get(filePath);
    const run = async () => {
      await fs.access(filePath);
      const result = gallery ? await uploadToGallery(filePath, image) : await uploadWithPicgo(filePath, onLog);
      await cleanupFiles([filePath, filePath + ".json"]);
      await cleanupEmptyParents(path.dirname(filePath), outputDir);
      return result;
    };
    pending.set(filePath, run());
    try { return await pending.get(filePath); } finally { pending.delete(filePath); }
  }

  async function uploadFiles(fileIds, concurrency) {
    const items = await mapConcurrent(fileIds, concurrency, async fileId => {
      const logs = [];
      try { return { ok: true, fileId, ...await uploadFile(fileId, line => logs.push(line)), logs }; }
      catch (error) { return { ok: false, fileId, error: error.message, logs }; }
    });
    const urls = items.filter(item => item.ok).map(item => item.url);
    return { ok: urls.length === items.length, total: items.length, succeeded: urls.length,
      failed: items.length - urls.length, items, urls };
  }
  return { collectUploadFileIds, uploadFile, uploadFiles };
}
