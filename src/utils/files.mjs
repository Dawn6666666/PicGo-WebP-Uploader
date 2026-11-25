import fs from "node:fs/promises";
import path from "node:path";

export async function cleanupFiles(files) {
  await Promise.allSettled(
    files.map((file) =>
      fs.rm(file, {
        force: true
      })
    )
  );
}

export async function cleanupEmptyParents(startDir, stopDir) {
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

export async function walkFiles(rootDir, maxFiles = 2000, acceptFile = () => true) {
  const root = path.resolve(rootDir);
  const files = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (!entry.isFile() || !acceptFile(fullPath)) {
        continue;
      }

      if (files.length >= maxFiles) throw new Error(`目录文件数超过 ${maxFiles}`);
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

export function resolveOutputFile(outputDir, fileId) {
  const resolved = path.resolve(outputDir, fileId);
  const root = path.resolve(outputDir);
  if (
    resolved !== root &&
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("Invalid fileId");
  }
  return resolved;
}

export function resolveOutputDirectory(outputDir, dirId) {
  const resolved = path.resolve(outputDir, dirId);
  const root = path.resolve(outputDir);
  if (
    resolved === root ||
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("Invalid jobId");
  }
  return resolved;
}
