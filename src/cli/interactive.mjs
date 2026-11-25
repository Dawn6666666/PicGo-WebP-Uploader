import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DEFAULT_BACKEND, PICGO_PATH, OUTPUT_DIR, REMOTE_INPUT_DIR, ROOT_DIR } from "../config.mjs";
import { createCompressService } from "../services/compress.mjs";
import { createRemoteImageService } from "../services/remoteImages.mjs";
import { createUploadService } from "../services/upload.mjs";
import { walkFiles } from "../utils/files.mjs";
import { clampNumber } from "../utils/image.mjs";
import { copyTextToClipboard } from "../utils/clipboard.mjs";

const scriptedAnswers = input.isTTY
  ? null
  : readFileSync(0, "utf8").split(/\r?\n/);
const rl = scriptedAnswers
  ? null
  : readline.createInterface({ input, output });
const compressService = createCompressService({ outputDir: OUTPUT_DIR, galleryPreview: DEFAULT_BACKEND === "gallery" });
const remoteImageService = createRemoteImageService({
  inputDir: REMOTE_INPUT_DIR
});
const uploadService = createUploadService({
  backend: DEFAULT_BACKEND,
  picgoPath: PICGO_PATH,
  outputDir: OUTPUT_DIR
});
const cliResultsDir = path.join(ROOT_DIR, "tmp", "cli-results");

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(REMOTE_INPUT_DIR, { recursive: true });
await fs.mkdir(cliResultsDir, { recursive: true });
let remoteBatch;

try {
  console.log("PicGo WebP CLI");
  console.log("");

  const sourceType = await askChoice("来源类型", [
    { label: "目录", value: "directory" },
    { label: "文件", value: "files" },
    { label: "远程 URL", value: "urls" }
  ], "directory");

  let files;
  let sourceDirectory = "";

  if (sourceType === "directory") {
    sourceDirectory = await askText("目录路径");
    if (!sourceDirectory) throw new Error("目录路径不能为空");
    const resolved = path.resolve(sourceDirectory);
    await fs.access(resolved);
    files = await walkFiles(resolved);
    sourceDirectory = resolved;
    console.log(`已扫描 ${files.length} 个文件`);
  } else if (sourceType === "files") {
    const rawPaths = await askText("文件路径，多个用英文逗号分隔");
    const inputPaths = rawPaths
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!inputPaths.length) {
      throw new Error("没有提供文件路径");
    }

    files = [];
    for (const inputPath of inputPaths) {
      const resolved = path.resolve(inputPath);
      const stat = await fs.stat(resolved);
      files.push({
        path: resolved,
        originalname: path.basename(resolved),
        size: stat.size
      });
    }
  } else {
    const rawUrls = await askText("图片 URL，多个用英文逗号分隔");
    const urls = rawUrls
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const downloadConcurrency = await askNumber("下载并发", 1, 16, 4);
    console.log("");
    console.log("开始下载远程图片...");
    remoteBatch = await remoteImageService.downloadImagesFromUrls(urls, {
      downloadConcurrency
    });
    files = remoteBatch.files;
    console.log(`已下载 ${files.length} 个文件`);
  }

  const quality = await askNumber("WebP 质量", 1, 100, 82);
  const effort = await askNumber("WebP effort", 0, 6, 6);
  const maxWidth = await askNumber("最大宽度", 0, 20000, 0);
  const compressConcurrency = await askNumber("压缩并发", 1, 64, 8);
  const uploadConcurrency = await askNumber("上传并发", 1, 10, 5);
  const uploadAfterCompress = await askConfirm("压缩后立即上传", true);
  const maxDimension = await askNumber("最长边（0 表示不限）", 0, 20000, 0);

  console.log("");
  console.log("开始压缩...");

  const compressResult = await compressService.compressFilesToJson({
    files,
    quality,
    effort,
    maxWidth,
    maxDimension,
    compressConcurrency,
    source: sourceType === "urls" ? "remote-urls" : sourceType,
    sourceDirectory: sourceType === "directory" ? sourceDirectory : undefined
  });

  printCompressionSummary(compressResult);

  if (uploadAfterCompress && compressResult.compressed > 0) {
    console.log("");
    console.log("开始上传...");
    const uploadFileIds = await uploadService.collectUploadFileIds({ jobId: compressResult.jobId });
    const uploaded = await uploadService.uploadFiles(uploadFileIds, uploadConcurrency);
    printUploadSummary(uploaded);
    await persistResults({
      compressResult,
      uploadResult: uploaded
    });

    const urls = uploaded.urls.join("\n");
    if (urls && copyTextToClipboard(urls)) {
      console.log("已复制上传 URL 到剪贴板");
    }
  } else {
    await persistResults({ compressResult, uploadResult: null });
  }

  console.log("");
  console.log(`结果已保存到: ${path.join(cliResultsDir, compressResult.jobId)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (remoteBatch?.jobDir) {
    await fs.rm(remoteBatch.jobDir, { recursive: true, force: true });
  }
  rl?.close();
}

async function persistResults({ compressResult, uploadResult }) {
  const runDir = path.join(cliResultsDir, compressResult.jobId);
  await fs.mkdir(runDir, { recursive: true });

  const payload = {
    compress: compressResult,
    upload: uploadResult,
    savedAt: new Date().toISOString()
  };

  await fs.writeFile(path.join(runDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(runDir, "urls.txt"),
    `${(uploadResult?.urls ?? []).join("\n")}\n`,
    "utf8"
  );
}

function printCompressionSummary(result) {
  console.log("");
  console.log(`任务: ${result.jobId}`);
  console.log(`总数: ${result.total}`);
  console.log(`成功: ${result.compressed}`);
  console.log(`跳过: ${result.skipped}`);
  console.log(`失败: ${result.failed}`);
  console.log(`节省: ${result.savedPercent}%`);
}

function printUploadSummary(result) {
  console.log("");
  console.log(`上传成功: ${result.succeeded}/${result.total}`);
  for (const url of result.urls) {
    console.log(url);
  }
}

async function prompt(question) {
  if (scriptedAnswers) {
    output.write(question);
    const answer = scriptedAnswers.shift() ?? "";
    output.write(`${answer}\n`);
    return answer;
  }

  return rl.question(question);
}

async function askText(question, fallback = "") {
  const answer = (await prompt(`${question}: `)).trim();
  return answer || fallback;
}

async function askNumber(question, min, max, fallback) {
  const answer = (await prompt(`${question} [${fallback}]: `)).trim();
  return clampNumber(answer || fallback, min, max, fallback);
}

async function askConfirm(question, fallback = true) {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await prompt(`${question} (${suffix}): `)).trim().toLowerCase();
  if (!answer) {
    return fallback;
  }
  return ["y", "yes", "true", "1"].includes(answer);
}

async function askChoice(question, options, fallbackValue) {
  console.log(question);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });

  const fallbackIndex = Math.max(
    1,
    options.findIndex((option) => option.value === fallbackValue) + 1
  );
  const answer = (await prompt(`请选择 [${fallbackIndex}]: `)).trim();
  const index = clampNumber(answer || fallbackIndex, 1, options.length, fallbackIndex) - 1;
  return options[index].value;
}
