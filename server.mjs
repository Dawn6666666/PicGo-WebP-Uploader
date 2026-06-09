import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { INPUT_DIR, OUTPUT_DIR, PICGO_PATH, PORT, REMOTE_INPUT_DIR, ROOT_DIR } from "./src/config.mjs";
import { cleanupDirectory } from "./src/utils/files.mjs";
import { createCompressService } from "./src/services/compress.mjs";
import { createRemoteImageService } from "./src/services/remoteImages.mjs";
import { createUploadService } from "./src/services/upload.mjs";
import { registerRoutes } from "./src/routes.mjs";

const app = express();

await fs.mkdir(INPUT_DIR, { recursive: true });
await fs.mkdir(REMOTE_INPUT_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await cleanupDirectory(INPUT_DIR);
await cleanupDirectory(REMOTE_INPUT_DIR);
await cleanupDirectory(OUTPUT_DIR);

const upload = multer({
  dest: INPUT_DIR,
  limits: {
    files: 1000,
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.static(path.join(ROOT_DIR, "public")));
app.use("/preview", express.static(OUTPUT_DIR));
app.use(express.json());

const compressService = createCompressService({ outputDir: OUTPUT_DIR });
const remoteImageService = createRemoteImageService({
  inputDir: REMOTE_INPUT_DIR
});
const uploadService = createUploadService({
  picgoPath: PICGO_PATH,
  outputDir: OUTPUT_DIR
});

registerRoutes(app, {
  upload,
  outputDir: OUTPUT_DIR,
  picgoPath: PICGO_PATH,
  compressService,
  remoteImageService,
  uploadService,
  cleanupDirectory
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
