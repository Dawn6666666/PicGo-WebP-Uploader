import { setColorScheme, setTheme } from "/vendor/mdui/mdui.esm.js";
import { imageMarkdown } from "./markdown.mjs";

const $ = id => document.getElementById(id);

const DEFAULT_COLOR = "#5750a3";
function applyColorScheme(hex) {
  const color = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : DEFAULT_COLOR;
  setColorScheme(color, { customColors: [{ name: "success", value: "#276944" }] });
  $("customColorInput").value = color;
  for (const btn of $("paletteSwatches").querySelectorAll("button.swatch")) {
    btn.setAttribute("aria-checked", String(btn.dataset.color === color));
  }
}
applyColorScheme(localStorage.getItem("colorScheme") || DEFAULT_COLOR);
$("paletteBtn").addEventListener("click", () => { $("paletteDialog").open = true; });
$("closePaletteBtn").addEventListener("click", () => { $("paletteDialog").open = false; });
$("resetPaletteBtn").addEventListener("click", () => {
  localStorage.removeItem("colorScheme");
  applyColorScheme(DEFAULT_COLOR);
});
$("paletteSwatches").addEventListener("click", event => {
  const btn = event.target.closest("button.swatch");
  if (!btn) return;
  localStorage.setItem("colorScheme", btn.dataset.color);
  applyColorScheme(btn.dataset.color);
});
$("customColorInput").addEventListener("input", event => {
  localStorage.setItem("colorScheme", event.target.value);
  applyColorScheme(event.target.value);
});
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function updateTheme() {
  const saved = localStorage.getItem("theme");
  const dark = saved ? saved === "dark" : systemTheme.matches;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = saved === "light" || saved === "dark" ? saved : "light dark";
  setTheme(dark ? "dark" : "light");
  const label = dark ? "切换到浅色模式" : "切换到深色模式";
  $("themeActionLabel").textContent = label;
  $("themeToggleBtn").title = label;
  $("themeToggleBtn").querySelector("mdui-icon").name = dark ? "light_mode" : "dark_mode";
}
updateTheme();
systemTheme.addEventListener("change", updateTheme);
window.addEventListener("storage", event => {
  if (event.key === "theme") updateTheme();
});
$("themeToggleBtn").addEventListener("click", () => {
  const target = document.documentElement.classList.contains("mdui-theme-dark") ? "light" : "dark";
  const system = systemTheme.matches ? "dark" : "light";
  if (target === system) localStorage.removeItem("theme");
  else localStorage.setItem("theme", target);
  updateTheme();
});

const rows = new Map();
const previewJobs = new Set();
let files = [];
let sourceMode = "files";
let selectionVersion = 0;
let preparedSource = null;
const thumbnailUrls = [];
let compressing = false;
let activeUploads = 0;
let bulkUploading = false;
let progress = null;
let refreshFrame = 0;

function busy() { return compressing || bulkUploading || activeUploads > 0; }
function sourceKey() {
  return JSON.stringify([sourceMode, sourceMode === "files" ? selectionVersion : $("localDirectoryPath").value.trim(),
    $("quality").value, $("effort").value, $("maxWidth").value,
    $("dimensionPreset").value === "custom" ? $("maxDimension").value : $("dimensionPreset").value]);
}
function notify(message) {
  $("liveStatus").textContent = message;
  $("notice").textContent = message;
  $("notice").open = true;
}
function syncSource() {
  const directory = sourceMode === "directory";
  $("fileSource").hidden = directory;
  $("directorySource").hidden = !directory;
  $("chooseFiles").disabled = busy();
  $("clearSelectionBtn").disabled = busy();
  $("fileInput").disabled = busy();
  $("localDirectoryPath").disabled = busy();
  for (const btn of $("sourceMode").querySelectorAll("mdui-segmented-button")) btn.disabled = busy();
  $("uploadBtn").disabled = busy() || (directory ? !$("localDirectoryPath").value.trim() : !files.length);
}
$("sourceMode").addEventListener("change", event => {
  sourceMode = event.target.value;
  syncSource();
  refresh();
});
$("chooseFiles").addEventListener("click", () => $("fileInput").click());
$("clearSelectionBtn").addEventListener("click", () => { if (!busy()) selectFiles([]); });
$("dropzone").addEventListener("click", event => {
  if (!busy() && !event.composedPath().includes($("chooseFiles")) && !event.composedPath().includes($("clearSelectionBtn"))) $("fileInput").click();
});
$("dropzone").addEventListener("keydown", event => {
  if (!busy() && (event.key === "Enter" || event.key === " ") && event.target === $("dropzone")) {
    event.preventDefault();
    $("fileInput").click();
  }
});
$("localDirectoryPath").addEventListener("input", () => { syncSource(); refresh(); });
$("localDirectoryPath").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.isComposing || event.keyCode === 229) return;
    if (!$("uploadBtn").disabled) prepare();
  }
});
$("fileInput").addEventListener("change", () => {
  if ($("fileInput").files.length) selectFiles([...$("fileInput").files]);
  $("fileInput").value = "";
});

function releaseSelection() {
  selectionVersion++;
  thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.length = 0;
  $("thumbnails").replaceChildren();
}
async function selectFiles(incoming, { append = false } = {}) {
  if (busy()) return;
  let added = incoming;
  if (append && files.length) {
    const seen = new Set(files.map(f => `${f.name}:${f.size}:${f.lastModified}`));
    added = incoming.filter(f => !seen.has(`${f.name}:${f.size}:${f.lastModified}`));
    if (!added.length) { notify("这些图片已在待选列表中"); return; }
    files = [...files, ...added];
    selectionVersion++;
  } else {
    releaseSelection();
    files = incoming;
  }
  sourceMode = "files";
  $("sourceMode").value = "files";
  const version = selectionVersion;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  $("dropzoneContent").hidden = !!files.length;
  $("selection").hidden = !files.length;
  $("selectionSummary").textContent = `${files.length} 张图片 · ${formatBytes(bytes)}`;
  $("selectionNames").textContent = files.slice(0, 2).map(file => file.name).join("、") + (files.length > 2 ? " 等" : "");
  $("chooseFiles").querySelector("span").textContent = files.length ? "重新选择" : "选择图片";
  $("chooseFiles").variant = files.length ? "outlined" : "filled";
  $("clearSelectionBtn").hidden = !files.length;
  syncSource();
  refresh();
  const lightweight = files.length > 8 || bytes > 20 * 1024 * 1024;
  const preview = added.slice(0, Math.max(0, 12 - $("thumbnails").childElementCount));
  let next = 0;
  async function thumbnailWorker() {
    while (version === selectionVersion && next < preview.length) {
      const file = preview[next++];
      const img = document.createElement("img");
      img.alt = file.name;
      img.title = file.name;
      $("thumbnails").append(img);
      const url = lightweight ? await createThumbnailUrl(file) : URL.createObjectURL(file);
      if (!url || version !== selectionVersion) {
        if (url) URL.revokeObjectURL(url);
        img.remove();
        continue;
      }
      thumbnailUrls.push(url);
      img.src = url;
      img.onerror = () => img.remove();
    }
  }
  if (files.length && !busy()) void prepare();
  await Promise.all([thumbnailWorker(), thumbnailWorker()]);
}
async function createThumbnailUrl(file) {
  if (!window.createImageBitmap) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: 72, resizeHeight: 72, resizeQuality: "low" });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 72;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .7));
    return blob && URL.createObjectURL(blob);
  } catch { return null; } finally { bitmap?.close(); }
}
const isImage = file => file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif|svg|avif|tiff?)$/i.test(file.name);
let dragDepth = 0;
window.addEventListener("dragenter", event => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  dragDepth++;
  if (!busy()) $("dropzone").classList.add("dragging");
});
window.addEventListener("dragover", event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").classList.remove("dragging"); } });
window.addEventListener("drop", event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  $("dropzone").classList.remove("dragging");
  const images = [...event.dataTransfer.files].filter(isImage);
  if (images.length) selectFiles(images, { append: true }); else notify("请选择支持的图片格式");
});
window.addEventListener("paste", event => {
  const images = [...(event.clipboardData?.files || [])].filter(isImage);
  if (!busy() && images.length) { event.preventDefault(); selectFiles(images, { append: true }); }
});

function syncQuality() {
  const quality = String($("quality").value);
  $("qualityLabel").value = quality;
  const presets = [...$("qualityPreset").querySelectorAll("mdui-menu-item")];
  $("qualityPreset").value = presets.some(item => item.value === quality) ? quality : "";
}
$("quality").addEventListener("input", syncQuality);
$("qualityPreset").addEventListener("change", () => {
  if (!$("qualityPreset").value) return;
  $("quality").value = Number($("qualityPreset").value);
  syncQuality();
});
$("dimensionPreset").addEventListener("change", () => { $("maxDimension").hidden = $("dimensionPreset").value !== "custom"; });
document.querySelector(".settings").addEventListener("input", scheduleRefresh);
syncQuality();
function settings() {
  const custom = $("dimensionPreset").value === "custom";
  for (const id of ["maxWidth", "compressConcurrency", ...(custom ? ["maxDimension"] : [])]) {
    if (!$(id).checkValidity() || !$(id).value.trim()) {
      if ($(id).closest("details")) $("advanced").open = true;
      $(id).focus();
      $(id).reportValidity();
      return null;
    }
  }
  return { quality: $("quality").value, effort: $("effort").value, maxWidth: $("maxWidth").value,
    maxDimension: custom ? $("maxDimension").value : $("dimensionPreset").value, compressConcurrency: $("compressConcurrency").value };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return value.toFixed(value >= 100 ? 0 : 1) + " " + units[index];
}
function makeBatches(items, maxBytes) {
  const batches = [];
  let batch, size = 0;
  for (const [index, file] of items.entries()) {
    if (!batch || batch.files.length >= 1000 || (maxBytes && size + file.size > maxBytes)) {
      batch = { baseIndex: index, files: [] };
      batches.push(batch);
      size = 0;
    }
    batch.files.push(file);
    size += file.size;
  }
  return batches;
}
async function streamRequest(route, body, onEvent) {
  const multipart = body instanceof FormData;
  const res = await fetch(route, { method: "POST", headers: multipart ? undefined : { "Content-Type": "application/json" },
    body: multipart ? body : JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `请求失败 (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", completed = false;
  function consume(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message || "处理失败");
    onEvent(event);
    if (event.type === "done") completed = true;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const [index, line] of lines.entries()) {
        consume(line);
        // A buffered batch may deliver hundreds of previews in a single read.
        if (index % 80 === 79) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (done) break;
    }
    consume(buffer);
    if (!completed) throw new Error("连接中断，请重试");
  } catch (error) {
    if (!completed) throw error;
  } finally { reader.releaseLock(); }
}
async function clearResults() {
  const ids = [...previewJobs];
  rows.clear();
  preparedSource = null;
  $("results").replaceChildren();
  $("batchError").hidden = true;
  progress = null;
  refresh();
  if (ids.length) {
    try {
      const res = await fetch("/api/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobIds: ids }) });
      if (res.ok) ids.forEach(id => previewJobs.delete(id));
    } catch { /* Unreleased preview directories are retried on the next local cleanup. */ }
  }
}
function newRow(event) {
  const el = $("resultTemplate").content.firstElementChild.cloneNode(true);
  el.querySelector("h3").textContent = event.name;
  el.querySelector(".size").textContent = formatBytes(event.originalBytes || 0);
  const row = { el, index: event.index, name: event.name, state: "working" };
  rows.set(row.index, row);
  $("results").append(el);
  el.querySelector(".upload-one").addEventListener("click", () => uploadOne(row));
  el.querySelector(".copy-one").addEventListener("click", () => copyLinks([row]));
  setState(row, "working");
  return row;
}
const stateLabels = { working: "压缩中", ready: "待上传", uploading: "上传中", uploaded: "已上传", retry: "上传失败", failed: "压缩失败", skipped: "已跳过" };
function setState(row, state, error = "") {
  row.state = state;
  const el = row.el;
  const status = el.querySelector(".state");
  status.textContent = stateLabels[state];
  status.dataset.state = state;
  const thumb = el.querySelector(".thumb");
  if (thumb && !thumb.querySelector("img")) {
    if (state === "working" || state === "uploading") {
      thumb.innerHTML = "<mdui-circular-progress></mdui-circular-progress>";
    } else {
      thumb.innerHTML = '<mdui-icon name="image"></mdui-icon>';
    }
  }
  const upload = el.querySelector(".upload-one");
  upload.hidden = !["ready", "retry"].includes(state);
  upload.disabled = busy();
  upload.textContent = state === "retry" ? "重试上传" : "上传";
  el.querySelector(".copy-one").hidden = !row.url;
  el.querySelector(".file-error").hidden = !error;
  const verbose = error.includes("\n") || error.length > 120;
  el.querySelector(".file-error").textContent = verbose ? "详情可查看运行日志" : error;
  if (verbose) appendLog(row, error);
  scheduleRefresh();
}
function appendLog(row, message) {
  const details = row.el.querySelector(".logs");
  details.hidden = false;
  details.querySelector("pre").append(document.createTextNode(message + "\n"));
}
function setLink(row, url, linkType) {
  row.url = url;
  const copy = row.el.querySelector(".copy-one");
  copy.title = "复制" + linkType;
  copy.querySelector(".sr-only").textContent = `复制 ${row.name} 的${linkType}`;
  const previewBtn = row.el.querySelector(".preview-one");
  if (previewBtn) {
    previewBtn.dataset.url = url;
    previewBtn.hidden = false;
  }
  const thumb = row.el.querySelector(".thumb");
  let imageLink = thumb.querySelector("a");
  if (!imageLink) {
    imageLink = document.createElement("a");
    imageLink.target = "_blank";
    imageLink.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.alt = row.name;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    imageLink.append(img);
    thumb.replaceChildren(imageLink);
  }
  imageLink.href = url;
  imageLink.querySelector("img").src = url;
}
function compressionEvent(event) {
  if (event.type === "start") {
    if (event.source === "directory") progress.total = event.total;
  } else if (event.type === "file-start") {
    newRow(event);
  } else if (event.type === "compressed") {
    const row = rows.get(event.index);
    row.fileId = event.fileId;
    previewJobs.add(event.fileId.split("/")[0]);
    const format = event.outputName.split(".").at(-1).toUpperCase();
    const size = event.keptOriginal ? `保留原始 ${format} · ${formatBytes(event.compressedBytes)}` :
      `${format} · ${formatBytes(event.originalBytes)} → ${formatBytes(event.compressedBytes)}（${event.savedPercent < 0 ? "增加" : "节省"} ${Math.abs(event.savedPercent)}%）`;
    row.el.querySelector(".size").textContent = size;
    if (event.width && event.height) row.el.querySelector(".dimensions").textContent = `${event.width} × ${event.height}`;
    setLink(row, new URL(event.previewUrl, location.origin).href, "本地预览链接");
    setState(row, "ready");
    progress.done++;
  } else if (["file-error", "file-skip"].includes(event.type)) {
    setState(rows.get(event.index), event.type === "file-skip" ? "skipped" : "failed", event.message || event.reason);
    progress.done++;
  }
  scheduleRefresh();
}
async function prepare() {
  if (busy() || $("uploadBtn").disabled) return;
  const options = settings();
  if (!options) return;
  compressing = true;
  const directory = sourceMode === "directory";
  syncControls();
  try {
    await clearResults();
    preparedSource = sourceKey();
    progress = { label: directory ? "扫描目录" : "压缩图片", done: 0, total: directory ? 0 : files.length };
    refresh();
    if (matchMedia("(max-width: 800px)").matches) {
      $("queue-title").focus({ preventScroll: true });
      $("resultsPanel").scrollIntoView({ block: "start" });
    }
    if (directory) {
      await streamRequest("/api/compress-directory", { ...options, directory: $("localDirectoryPath").value.trim() }, compressionEvent);
    } else {
      const batches = makeBatches(files, Number($("compressBatchSize").value) * 1024 * 1024);
      for (const [i, batch] of batches.entries()) {
        const form = new FormData();
        for (const [key, value] of Object.entries({ ...options, baseIndex: batch.baseIndex, batchNumber: i + 1, totalBatches: batches.length })) form.set(key, value);
        batch.files.forEach(file => form.append("images", file, file.name));
        await streamRequest("/api/compress", form, compressionEvent);
      }
    }
    if (!rows.size) showError("目录中没有可处理的文件。");
    $("liveStatus").textContent = `压缩结束，共处理 ${rows.size} 个文件`;
  } catch (error) {
    showError(error.message);
    for (const row of rows.values()) if (row.state === "working") setState(row, "failed", "处理未完成，请重新压缩");
  } finally {
    compressing = false;
    progress = null;
    syncControls();
    refresh();
    // The queue can grow after the initial scroll while previews arrive.
    if (document.activeElement === $("queue-title") && matchMedia("(max-width: 800px)").matches) {
      $("resultsPanel").scrollIntoView({ block: "start" });
    }
  }
}
function showError(message) {
  $("batchError").textContent = message;
  $("batchError").hidden = false;
}
function canUpload(row) { return row.state === "ready" || row.state === "retry"; }
async function uploadOne(row) {
  if (compressing || !canUpload(row)) return;
  activeUploads++;
  setState(row, "uploading");
  if (!bulkUploading) syncControls();
  try {
    await streamRequest("/api/upload-picgo", { fileId: row.fileId }, event => {
      if (event.type === "picgo-log") {
        appendLog(row, event.message);
      } else if (event.type === "done") {
        if (!event.url) throw new Error("图床没有返回链接");
        setLink(row, event.url, "图床链接");
        setState(row, "uploaded");
      }
    });
  } catch (error) { setState(row, "retry", error.message); }
  finally {
    activeUploads--;
    if (!bulkUploading) syncControls();
    scheduleRefresh();
  }
}
async function uploadAll() {
  if (busy()) return;
  const jobs = [...rows.values()].filter(canUpload);
  if (!jobs.length) return;
  if (!$("uploadConcurrency").checkValidity()) {
    $("advanced").open = true;
    $("uploadConcurrency").focus();
    $("uploadConcurrency").reportValidity();
    return;
  }
  bulkUploading = true;
  progress = { label: "上传图片", done: 0, total: jobs.length };
  syncControls();
  refresh();
  let next = 0;
  async function worker() {
    while (next < jobs.length) { await uploadOne(jobs[next++]); progress.done++; scheduleRefresh(); }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(jobs.length, Number($("uploadConcurrency").value)) }, worker));
  } finally {
    bulkUploading = false;
    progress = null;
    syncControls();
    refresh();
    const succeeded = jobs.filter(row => row.state === "uploaded").length;
    notify(`已上传 ${succeeded}/${jobs.length} 张图片`);
  }
}
function syncControls() {
  syncSource();
  document.querySelectorAll(".settings input, .settings select").forEach(el => { el.disabled = busy(); });
  for (const row of rows.values()) row.el.querySelector(".upload-one").disabled = busy();
}
function scheduleRefresh() {
  if (!refreshFrame) refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
}
function refresh() {
  const list = [...rows.values()];
  const links = list.filter(row => row.url);
  const uploaded = links.filter(row => row.state === "uploaded").length;
  const prepared = list.length > 0 && preparedSource === sourceKey();
  const pending = list.some(canUpload);
  $("uploadBtn").variant = prepared && links.length ? "outlined" : "filled";
  $("uploadBtn").querySelector("span").textContent = prepared ? "重新压缩" : "压缩并预览";
  $("uploadAllBtn").variant = prepared && pending ? "filled" : "tonal";
  $("sourceStatus").textContent = list.length && !prepared && !busy() ? "下次压缩将替换当前队列" : "";
  $("emptyState").hidden = !!list.length || !!progress || !$("batchError").hidden;
  $("queueCount").textContent = progress?.total && compressing ? progress.total : list.length;
  $("queueActions").hidden = !list.length && $("batchError").hidden;
  $("clearBtn").disabled = busy();
  $("uploadAllBtn").disabled = busy() || !pending;
  $("uploadAllBtn").hidden = !pending && !bulkUploading;
  $("copyAllBtn").variant = links.length && uploaded === links.length ? "filled" : "outlined";
  $("batchProgress").hidden = !progress;
  $("uploadBtn").loading = compressing;
  $("uploadAllBtn").loading = bulkUploading;
  if (progress) {
    const bar = $("batchProgress").querySelector("mdui-linear-progress");
    if (progress.total && progress.done > 0) { bar.max = progress.total; bar.value = progress.done; } else bar.removeAttribute("value");
    const pct = progress.total ? ` (${Math.round(progress.done / progress.total * 100)}%)` : "";
    $("progressLabel").textContent = progress.total ? `${compressing ? "压缩图片" : progress.label} · ${progress.done} / ${progress.total}${pct}` : progress.label;
  }
  $("copyBar").hidden = !links.length;
  const sources = [];
  if (uploaded) sources.push(`${uploaded} 个图床链接`);
  if (links.length > uploaded) sources.push(`${links.length - uploaded} 个本地预览链接`);
  $("linkSummary").textContent = sources.join(" · ");
}
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatLink(row) {
  switch ($("copyFormat").value) {
    case "url": return row.url;
    case "bbcode": return `[img]${row.url}[/img]`;
    case "html": return `<img src="${escapeAttribute(row.url)}" alt="${escapeAttribute(row.name)}" />`;
    default: return imageMarkdown({ alt: row.name, url: row.url });
  }
}
async function copyLinks(selected) {
  const links = selected.filter(row => row.url).sort((a, b) => a.index - b.index);
  const text = links.map(formatLink).join("\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const active = document.activeElement;
    const field = document.createElement("textarea");
    field.className = "sr-only";
    field.value = text;
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } finally { field.remove(); active?.focus({ preventScroll: true }); }
    if (!copied) { notify("复制失败，请检查剪贴板权限"); return; }
  }
  notify(`已复制 ${links.length} 个链接`);
}
$("uploadBtn").addEventListener("click", prepare);
$("uploadAllBtn").addEventListener("click", uploadAll);
$("copyAllBtn").addEventListener("click", () => copyLinks([...rows.values()]));
$("clearBtn").addEventListener("click", () => {
  if (busy()) return;
  void clearResults();
  notify("队列已清空");
});
fetch("/api/health").then(res => res.json()).then(data => {
  $("health").querySelector("span").textContent = data.backend === "gallery" ? "R2 图床" : "PicGo 图床";
  $("health").title = data.backend === "gallery" ? "使用 R2 管理站上传" : `PicGo 命令：${data.picgoPath}`;
}).catch(() => { $("health").querySelector("span").textContent = "图床状态未知"; });
syncSource();
refresh();

$("closePreviewBtn").addEventListener("click", () => { $("previewDialog").open = false; });
$("results").addEventListener("click", event => {
  const trigger = event.target.closest(".thumb a, .preview-one");
  const url = trigger?.dataset.url || trigger?.href;
  if (!trigger || !url) return;
  const row = trigger.closest(".result-row");
  if (!row) return;
  event.preventDefault();
  $("previewDialog").headline = row.querySelector("h3")?.textContent || "图片预览";
  $("previewImg").src = url;
  $("previewImg").alt = $("previewDialog").headline;
  const size = row.querySelector(".size")?.textContent || "";
  const dims = row.querySelector(".dimensions")?.textContent || "";
  $("previewMeta").textContent = [size, dims].filter(Boolean).join(" · ");
  $("previewDialog").open = true;
});
