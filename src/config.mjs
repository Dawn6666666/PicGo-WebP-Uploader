import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
let fileSettings = {};
try {
  fileSettings = parse(readFileSync(path.join(ROOT_DIR, ".env")));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const settings = { ...fileSettings, ...process.env };

export const TMP_DIR = path.join(ROOT_DIR, "tmp");
export const INPUT_DIR = path.join(TMP_DIR, "input");
export const REMOTE_INPUT_DIR = path.join(TMP_DIR, "remote-input");
export const OUTPUT_DIR = settings.OUTPUT_DIR
  ? path.resolve(settings.OUTPUT_DIR)
  : path.join(TMP_DIR, "output");
export const PORT = Number(settings.PORT ?? 5177);
export const UPLOAD_SETTINGS = {
  picgoPath: settings.PICGO_PATH || "picgo",
  configPath: settings.PICGO_CONFIG,
  gallerySettings: {
    R2_GALLERY_URL: settings.R2_GALLERY_URL,
    R2_GALLERY_PASSWORD: settings.R2_GALLERY_PASSWORD,
    R2_GALLERY_TOKEN: settings.R2_GALLERY_TOKEN
  }
};
export const DEFAULT_BACKEND = settings.UPLOAD_BACKEND || (settings.R2_GALLERY_URL ? "gallery" : "picgo");
if (!["gallery", "picgo"].includes(DEFAULT_BACKEND)) {
  throw new Error("UPLOAD_BACKEND 必须是 gallery 或 picgo");
}
