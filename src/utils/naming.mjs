import path from "node:path";

export const namingModes = ["date-name", "name", "hash"];

function safePart(value, maxBytes) {
  const normalized = value.normalize("NFC").replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "-");
  let part = "";
  for (const char of normalized) {
    if (Buffer.byteLength(part + char) > maxBytes) break;
    part += char;
  }
  return part.replace(/^-+|-+$/g, "");
}

export function localDate(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(n => String(n).padStart(2, "0")).join("-");
}

export function uploadName({ name, md5, ext, date, naming = "date-name", prefix = "" }) {
  const parts = [safePart(prefix, 48)];
  if (naming === "date-name") parts.push(date);
  if (naming !== "hash") parts.push(safePart(path.parse(name).name, 72) || "image");
  return parts.concat(md5).filter(Boolean).join("-") + ext;
}
