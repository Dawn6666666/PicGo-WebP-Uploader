import { setColorScheme, setTheme } from "/vendor/mdui/mdui.esm.js";
import { imageMarkdown } from "./markdown.mjs";

const $ = id => document.getElementById(id);
const icons = {
  collections: "M22 16V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2ZM8 4h12v12H8zm1 10h10l-3.2-4-2.4 3-1.7-2.1zM2 6v14a2 2 0 0 0 2 2h14v-2H4V6z",
  "add-image": "M19 13v6H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6zM7 17h10l-3.2-4.1-2.5 3-1.5-1.9zM18 2v3h-3v2h3v3h2V7h3V5h-3V2z",
  image: "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM5 5h14v14H5zm1 12h12l-3.8-5-3.1 3.8-1.9-2.4z",
  cloud: "M19.35 10.04A7.49 7.49 0 0 0 5.5 8.01 6 6 0 0 0 6 20h13a5 5 0 0 0 .35-9.96ZM19 18H6a4 4 0 0 1-.42-7.98l1.07-.11.5-.95a5.5 5.5 0 0 1 10.26 1.48l.3 1.5 1.53.1A3 3 0 0 1 19 18Z",
  moon: "M9.4 3.2A9 9 0 1 0 20.8 14.6a7.5 7.5 0 0 1-11.4-11.4Zm-2.5 3.6a9.5 9.5 0 0 0 10.3 10.3A7 7 0 0 1 6.9 6.8Z",
  sun: "M6.76 4.84 4.96 3.05 3.54 4.46l1.8 1.8zm-4.76 6.16h3v2H2zm9-9h2v3h-2zm9.46 2.46-1.41-1.41-1.8 1.8 1.41 1.41zM19 11h3v2h-3zm-1.76 8.16 1.8 1.8 1.41-1.42-1.8-1.8zM11 19h2v3h-2zm-7.46.54 1.42 1.42 1.8-1.8-1.42-1.42zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
  add: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  compress: "M4 9h4.59L3 3.41 4.41 2 10 7.59V3h2v8H4zm16 6h-4.59L21 20.59 19.59 22 14 16.41V21h-2v-8h8z",
  tune: "M3 6h4V3h2v3h12v2H9v3H7V8H3zm0 10h12v-3h2v3h4v2h-4v3h-2v-3H3z",
  expand: "m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6z",
  layers: "m12 2 10 6-10 6L2 8zm0 2.33L5.89 8 12 11.67 18.11 8zM3.94 11.5 12 16.34l8.06-4.84L22 12.66l-10 6-10-6zm0 4.33L12 20.67l8.06-4.84L22 17l-10 6-10-6z",
  upload: "M5 17v2h14v-2h2v4H3v-4zm6-1V6.83L7.41 10.4 6 9l6-6 6 6-1.41 1.41L13 6.83V16z",
  copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11z"
};

function drawIcon(el, name) {
  el.setAttribute("aria-hidden", "true");
  // All paths are static UI assets. Filenames, URLs and logs use textContent.
  el.innerHTML = `<svg viewBox="0 0 24 24" focusable="false"><path d="${icons[name]}"></path></svg>`;
}
for (const root of [document, $("resultTemplate").content]) {
  for (const el of root.querySelectorAll("[data-icon]")) drawIcon(el, el.dataset.icon);
}

setColorScheme("#5750a3", { customColors: [{ name: "success", value: "#276944" }] });
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function updateTheme() {
  const saved = localStorage.getItem("theme");
  const dark = saved ? saved === "dark" : systemTheme.matches;
  setTheme(dark ? "dark" : "light");
  const label = dark ? "切换到浅色模式" : "切换到深色模式";
  $("themeActionLabel").textContent = label;
  $("themeToggleBtn").title = label;
  drawIcon($("themeToggleBtn").querySelector("mdui-icon"), dark ? "sun" : "moon");
}
updateTheme();
systemTheme.addEventListener("change", updateTheme);
$("themeToggleBtn").addEventListener("click", () => {
  localStorage.setItem("theme", document.documentElement.classList.contains("mdui-theme-dark") ? "light" : "dark");
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
  $("fileInput").disabled = busy();
  $("localDirectoryPath").disabled = busy();
  for (const radio of $("sourceMode").querySelectorAll("input")) radio.disabled = busy();
  $("uploadBtn").disabled = busy() || (directory ? !$("localDirectoryPath").value.trim() : !files.length);
}
$("sourceMode").addEventListener("change", event => {
  sourceMode = event.target.value;
  syncSource();
  refresh();
});
$("chooseFiles").addEventListener("click", () => $("fileInput").click());
$("dropzone").addEventListener("click", event => {
  if (!busy() && !event.composedPath().includes($("chooseFiles"))) $("fileInput").click();
});
$("localDirectoryPath").addEventListener("input", () => { syncSource(); refresh(); });
$("localDirectoryPath").addEventListener("keydown", event => {
  if (event.key === "Enter" && !$("uploadBtn").disabled) prepare();
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
async function selectFiles(incoming) {
  if (busy()) return;
  releaseSelection();
  files = incoming;
  sourceMode = "files";
  $("filesMode").checked = true;
  const version = selectionVersion;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  $("dropzoneContent").hidden = !!files.length;
  $("selection").hidden = !files.length;
  $("selectionSummary").textContent = `${files.length} 张图片 · ${formatBytes(bytes)}`;
  $("selectionNames").textContent = files.slice(0, 2).map(file => file.name).join("、") + (files.length > 2 ? " 等" : "");
  $("chooseFiles").querySelector("span").textContent = files.length ? "重新选择" : "选择图片";
  $("chooseFiles").variant = files.length ? "outlined" : "filled";
  syncSource();
  refresh();
  const lightweight = files.length > 8 || bytes > 20 * 1024 * 1024;
  const preview = files.slice(0, 12);
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
  if (images.length) selectFiles(images); else notify("请选择支持的图片格式");
});
window.addEventListener("paste", event => {
  const images = [...(event.clipboardData?.files || [])].filter(isImage);
  if (!busy() && images.length) { event.preventDefault(); selectFiles(images); }
});

function syncQuality() {
  const quality = $("quality").value;
  $("qualityLabel").value = quality;
  $("quality").style.setProperty("--fill", ((Number(quality) - 1) / 99 * 100) + "%");
  $("qualityPreset").value = [...$("qualityPreset").options].some(option => option.value === quality) ? quality : "";
}
$("quality").addEventListener("input", syncQuality);
$("qualityPreset").addEventListener("change", () => { $("quality").value = $("qualityPreset").value; syncQuality(); });
$("dimensionPreset").addEventListener("change", () => { $("customDimension").hidden = $("dimensionPreset").value !== "custom"; });
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
function setLink(row, url, label, linkType) {
  row.url = url;
  const copy = row.el.querySelector(".copy-one");
  copy.title = "复制" + linkType;
  copy.querySelector(".sr-only").textContent = `复制 ${row.name} 的${linkType}`;
  const link = row.el.querySelector(".file-link");
  link.href = url;
  link.textContent = label;
  link.title = url;
  link.hidden = false;
  const thumb = row.el.querySelector(".thumb");
  let imageLink = thumb.querySelector("a");
  if (!imageLink) {
    imageLink = document.createElement("a");
    imageLink.target = "_blank";
    imageLink.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.alt = row.name;
    img.loading = "lazy";
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
    setLink(row, new URL(event.previewUrl, location.origin).href, "本地预览", "本地预览链接");
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
        setLink(row, event.url, event.duplicate ? "图床链接 · 已复用" : "图床链接", "图床链接");
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
  if (progress) {
    const bar = $("batchProgress").querySelector("progress");
    if (progress.total) { bar.max = progress.total; bar.value = progress.done; } else bar.removeAttribute("value");
    $("progressLabel").textContent = progress.total ? `${compressing ? "压缩图片" : progress.label} · ${progress.done} / ${progress.total}` : progress.label;
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
