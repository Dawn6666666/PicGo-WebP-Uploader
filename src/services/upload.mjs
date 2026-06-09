import { spawn } from "node:child_process";
import path from "node:path";
import { resolveOutputDirectory, resolveOutputFile, walkFiles } from "../utils/files.mjs";

export function createUploadService({ picgoPath, outputDir }) {
  function uploadWithPicgo(filePath, onLog) {
    const TIMEOUT_MS = 120_000;

    return new Promise((resolve, reject) => {
      const child = spawn(picgoPath, ["upload", filePath], {
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

  async function collectUploadFileIds(body) {
    if (Array.isArray(body?.fileIds)) {
      const fileIds = body.fileIds.map((fileId) => {
        if (typeof fileId !== "string" || !fileId || fileId.includes("..") || path.isAbsolute(fileId)) {
          throw new Error("invalid fileIds");
        }
        resolveOutputFile(outputDir, fileId);
        return fileId;
      });

      if (!fileIds.length) {
        throw new Error("fileIds must not be empty");
      }

      return fileIds;
    }

    if (typeof body?.jobId === "string" && body.jobId && !body.jobId.includes("..") && !path.isAbsolute(body.jobId)) {
      const jobDir = resolveOutputDirectory(outputDir, body.jobId);
      const files = await walkFiles(jobDir);
      const fileIds = files
        .filter((file) => path.extname(file.originalname).toLowerCase() === ".webp")
        .map((file) => path.relative(outputDir, file.path).split(path.sep).join("/"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      if (!fileIds.length) {
        throw new Error("jobId has no uploadable files");
      }

      return fileIds;
    }

    throw new Error("provide fileIds or jobId");
  }

  return {
    uploadWithPicgo,
    collectUploadFileIds
  };
}
