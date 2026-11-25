import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { DEFAULT_BACKEND, INPUT_DIR, OUTPUT_DIR, PORT, REMOTE_INPUT_DIR, ROOT_DIR, UPLOAD_SETTINGS } from "./src/config.mjs";
import { createCompressService } from "./src/services/compress.mjs";
import { createRemoteImageService } from "./src/services/remoteImages.mjs";
import { createUploadService } from "./src/services/upload.mjs";
import { registerRoutes } from "./src/routes.mjs";

const app = express();
const require = createRequire(import.meta.url);
for (const file of ["mdui.css", "mdui.esm.js"]) {
  const asset = require.resolve("mdui/" + file);
  app.get("/vendor/mdui/" + file, (_req, res) => res.sendFile(asset));
}

await fs.mkdir(INPUT_DIR, { recursive: true });
await fs.mkdir(REMOTE_INPUT_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
const upload = multer({
  dest: INPUT_DIR,
  limits: {
    files: 1000,
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.static(path.join(ROOT_DIR, "public")));
app.use("/preview", express.static(OUTPUT_DIR, {
  setHeaders(res) { res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'"); }
}));
app.use(express.json());

const compressService = createCompressService({ outputDir: OUTPUT_DIR, galleryPreview: DEFAULT_BACKEND === "gallery" });
const remoteImageService = createRemoteImageService({
  inputDir: REMOTE_INPUT_DIR
});
const uploadService = createUploadService({
  ...UPLOAD_SETTINGS,
  backend: DEFAULT_BACKEND,
  outputDir: OUTPUT_DIR
});

registerRoutes(app, {
  backend: DEFAULT_BACKEND,
  upload,
  outputDir: OUTPUT_DIR,
  picgoPath: UPLOAD_SETTINGS.picgoPath,
  compressService,
  remoteImageService,
  uploadService
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`PicGo WebP uploader running at http://localhost:${server.address().port}`);
  console.log(DEFAULT_BACKEND === "gallery" ? "Using R2 gallery" : `Using PicGo CLI: ${UPLOAD_SETTINGS.picgoPath}`);
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
