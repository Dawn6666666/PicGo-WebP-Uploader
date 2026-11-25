import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
export const TMP_DIR = path.join(ROOT_DIR, "tmp");
export const INPUT_DIR = path.join(TMP_DIR, "input");
export const REMOTE_INPUT_DIR = path.join(TMP_DIR, "remote-input");
export const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(TMP_DIR, "output");
export const PORT = Number(process.env.PORT ?? 5177);
export const PICGO_PATH = process.env.PICGO_PATH || "picgo";
export const DEFAULT_BACKEND = process.env.R2_GALLERY_URL ? "gallery" : "picgo";
