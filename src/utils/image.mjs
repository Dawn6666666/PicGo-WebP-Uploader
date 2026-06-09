export const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tif",
  ".tiff"
]);

export function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeUploadName(name) {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? name : decoded;
  } catch {
    return name;
  }
}

export function percentageSaved(original, compressed) {
  if (!original) {
    return 0;
  }
  return Math.round((1 - compressed / original) * 1000) / 10;
}
