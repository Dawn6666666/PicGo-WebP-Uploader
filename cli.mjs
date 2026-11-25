#!/usr/bin/env node
import { parseArgs } from "node:util";
import { namingModes } from "./src/utils/naming.mjs";
import { DEFAULT_BACKEND } from "./src/config.mjs";

const help = `picgo-webp [upload] <图片或目录...> [选项]
picgo-webp migrate <HTTP(S) 图片链接...> [选项]
picgo-webp upload|migrate --input <清单.json|-> [选项]
picgo-webp interactive

upload 是默认操作。本地目录递归扫描；migrate 下载并上传显式给出的图片链接。
--input FILE             JSON 数组或 {"images":[{"source":"…","alt":"…","caption":"…","widthPercent":60,"sourcePage":"…"}]}
                         清单内相对路径以清单目录为基准；- 表示标准输入。
--backend MODE           picgo 或 gallery。覆盖项目配置中的默认后端
--prefix TEXT            PicGo 文件名前缀，例如文章 slug
--naming MODE            PicGo 支持 date-name（默认）、name 或 hash；gallery 使用纯 MD5
--output FILE            保存 JSON 清单，默认 tmp/cli-results/<jobId>/result.json
--quality 82             WebP 质量 (1–100)
--effort 6               WebP effort (0–6)
--max-width 0            最大像素宽度 (0–20000)，0 保留原宽
--max-dimension 0        最长边像素 (0–20000)，0 不限制；可与宽度上限组合
--compress-concurrency 8 压缩并发 (1–64)
--upload-concurrency 5   上传并发 (1–10)
--download-concurrency 4 远程下载并发 (1–16)
-h, --help               查看帮助

stdout 输出 JSON。退出码 0 全部成功，1 处理或保存失败，2 参数或清单错误。
PicGo 从 PATH 查找，也可设置 PICGO_PATH 和 PICGO_CONFIG。
gallery 读取 R2_GALLERY_URL 与 R2_GALLERY_PASSWORD 或 R2_GALLERY_TOKEN。
清单可用 assetAlt 和 tags 单独设置新素材的图床说明与标签。`;

const numberOptions = {
  quality: ["quality", 1, 100, 82], effort: ["effort", 0, 6, 6],
  "max-width": ["maxWidth", 0, 20000, 0], "compress-concurrency": ["compressConcurrency", 1, 64, 8],
  "max-dimension": ["maxDimension", 0, 20000, 0],
  "upload-concurrency": ["uploadConcurrency", 1, 10, 5], "download-concurrency": ["downloadConcurrency", 1, 16, 4]
};

async function main(argv) {
  if ((argv.length === 1 && argv[0] === "interactive") || !argv.length) {
    await import("./src/cli/interactive.mjs");
    return;
  }
  const parameters = Object.fromEntries(["input", "output", "backend", "prefix", "naming", ...Object.keys(numberOptions)]
    .map(key => [key, { type: "string" }]));
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { ...parameters, help: { type: "boolean", short: "h" } } });
  if (values.help) return console.log(help);

  const command = ["upload", "migrate"].includes(positionals[0]) ? positionals.shift() : "upload";
  const backend = values.backend ?? DEFAULT_BACKEND;
  if (!["picgo", "gallery"].includes(backend)) throw new Error("--backend 必须是 picgo 或 gallery");
  if (backend === "gallery" && (values.prefix || (values.naming !== undefined && values.naming !== "hash"))) {
    throw new Error("gallery 由服务端按内容命名。使用 --backend picgo 可指定 --prefix 或 --naming");
  }
  const options = { ...values, backend, naming: values.naming ?? (backend === "gallery" ? "hash" : "date-name") };
  if (!namingModes.includes(options.naming)) throw new Error("未知的 --naming，请选 date-name、name 或 hash");
  for (const [flag, [key, min, max, fallback]] of Object.entries(numberOptions)) {
    const raw = values[flag];
    const n = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === "" || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(`--${flag} 必须是 ${min} 至 ${max} 的整数`);
    }
    options[key] = n;
  }
  const { readInputs } = await import("./src/cli/inputs.mjs");
  const inputs = await readInputs(positionals, options.input, command);
  const { runBatch } = await import("./src/cli/run.mjs");
  try {
    const result = await runBatch(command, inputs, options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 2;
}
