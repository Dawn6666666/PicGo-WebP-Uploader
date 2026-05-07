// ========== DOM refs ==========
const fileInput = document.querySelector("#fileInput");
const qualityInput = document.querySelector("#quality");
const qualityPreset = document.querySelector("#qualityPreset");
const qualityLabel = document.querySelector("#qualityLabel");
const effortInput = document.querySelector("#effort");
const maxWidthInput = document.querySelector("#maxWidth");
const widthPreset = document.querySelector("#widthPreset");
const uploadConcurrencyInput = document.querySelector("#uploadConcurrency");
const effortLabel = document.querySelector("#effortLabel");
const uploadBtn = document.querySelector("#uploadBtn");
const clearBtn = document.querySelector("#clearBtn");
const copyAllBtn = document.querySelector("#copyAllBtn");
const uploadAllBtn = document.querySelector("#uploadAllBtn");
const summary = document.querySelector("#summary");
const health = document.querySelector("#health");
const resultsPanel = document.querySelector("#resultsPanel");
const results = document.querySelector("#results");
const progressFill = document.querySelector("#progressFill");
const dropzone = document.querySelector("#dropzone");
const dropzoneContent = document.querySelector("#dropzoneContent");
const dropzonePreview = document.querySelector("#dropzonePreview");
const dragOverlay = document.querySelector("#dragOverlay");
const themeToggleBtn = document.querySelector("#themeToggleBtn");
const uploadAllDefaultHtml = uploadAllBtn.innerHTML;

// ========== Theme ==========
function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) {
    document.documentElement.dataset.theme = saved;
  } else {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }
}

initTheme();

themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme;
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ========== State ==========
let files = [];
let total = 0;
let finished = 0;
let uploading = false;
let uploadQueueRunning = false;
const localPreviewUrls = [];
/** @type {Map<number, string>} index → url */
const uploadedUrls = new Map();
const uploadedFiles = new Map();

// ========== Slider labels & Presets ==========
qualityInput.addEventListener("input", () => {
  qualityLabel.textContent = qualityInput.value;
  // If the user manually slides to a value not in the preset, maybe reset the preset dropdown
  // Or just let it be. We can try to match it.
  const presetOptions = Array.from(qualityPreset.options).map(opt => opt.value);
  if (presetOptions.includes(qualityInput.value)) {
    qualityPreset.value = qualityInput.value;
  } else {
    qualityPreset.value = ""; // optional: if you add an empty/custom option
  }
});

qualityPreset.addEventListener("change", () => {
  if (qualityPreset.value) {
    qualityInput.value = qualityPreset.value;
    qualityLabel.textContent = qualityPreset.value;
  }
});

effortInput.addEventListener("input", () => {
  effortLabel.textContent = effortInput.value;
});

maxWidthInput.addEventListener("input", () => {
  const presetOptions = Array.from(widthPreset.options).map(opt => opt.value);
  if (presetOptions.includes(maxWidthInput.value)) {
    widthPreset.value = maxWidthInput.value;
  } else {
    widthPreset.value = "";
  }
});

widthPreset.addEventListener("change", () => {
  if (widthPreset.value !== "") {
    maxWidthInput.value = widthPreset.value;
  }
});

// ========== File selection ==========
fileInput.addEventListener("change", () => {
  setFiles(Array.from(fileInput.files ?? []));
});

function setFiles(incoming) {
  if (uploading) return;
  files = incoming;
  summary.textContent = files.length
    ? `${files.length} 个文件，原始总大小 ${formatBytes(totalBytes(files))}`
    : "未选择文件";

  localPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  localPreviewUrls.length = 0;
  dropzonePreview.innerHTML = "";

  if (files.length > 0) {
    dropzoneContent.style.display = "none";
    dropzonePreview.style.display = "flex";

    const previewFiles = files.slice(0, 15);
    previewFiles.forEach(file => {
      const url = URL.createObjectURL(file);
      localPreviewUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      dropzonePreview.append(img);
    });

    if (files.length > 15) {
      const more = document.createElement("div");
      more.className = "more-preview";
      more.textContent = `+${files.length - 15}`;
      dropzonePreview.append(more);
    }
  } else {
    dropzoneContent.style.display = "flex";
    dropzonePreview.style.display = "none";
  }
}

// ========== Drag & Drop ==========
let dragCounter = 0;

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    dragOverlay.classList.add("visible");
  }
});

window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dragOverlay.classList.remove("visible");
  }
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove("visible");

  const dt = e.dataTransfer;
  if (!dt?.files?.length) return;

  const imageFiles = Array.from(dt.files).filter((f) =>
    f.type.startsWith("image/")
  );
  if (imageFiles.length) {
    setFiles(imageFiles);
  }
});

// also support hovering over the dropzone itself
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-hover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("drag-hover");
});

dropzone.addEventListener("drop", () => {
  dropzone.classList.remove("drag-hover");
});

// ========== Paste ==========
window.addEventListener("paste", (e) => {
  if (uploading) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  const imageFiles = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }

  if (imageFiles.length) {
    e.preventDefault();
    setFiles(imageFiles);
    toast(`已粘贴 ${imageFiles.length} 张图片`);
  }
});

// ========== Clear ==========
clearBtn.addEventListener("click", () => {
  cleanupServerOutput();
  files = [];
  fileInput.value = "";
  dropzone.classList.remove("drag-hover");
  
  localPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  localPreviewUrls.length = 0;
  uploadedUrls.clear();
  uploadedFiles.clear();
  dropzonePreview.innerHTML = "";
  dropzoneContent.style.display = "flex";
  dropzonePreview.style.display = "none";
  
  summary.textContent = "未选择文件";
  results.innerHTML = "";
  resultsPanel.style.display = "none";
  progressFill.style.width = "0%";
  finished = 0;
  
  uploadAllBtn.disabled = true;
  copyAllBtn.disabled = true;
});

// ========== Copy All ==========
copyAllBtn.addEventListener("click", () => {
  if (!uploadedFiles.size) return;

  const formatSelect = document.querySelector("#copyFormat");
  const format = formatSelect ? formatSelect.value : "markdown";
  let text = "";
  
  const orderedUploads = Array.from(uploadedFiles.entries())
    .sort(([a], [b]) => a - b)
    .map(([, data]) => data);

  for (const data of orderedUploads) {
    const { url, name } = data;
    if (format === "markdown") {
      text += `![${name}](${url})\n`;
    } else if (format === "url") {
      text += `${url}\n`;
    } else if (format === "bbcode") {
      text += `[img]${url}[/img]\n`;
    } else if (format === "html") {
      text += `<img src="${url}" alt="${name}" />\n`;
    }
  }

  if (text) {
    text = text.trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        toast(`已复制 ${uploadedFiles.size} 个 ${format.toUpperCase()} 链接`);
      }).catch(err => {
        fallbackCopy(text, format);
      });
    } else {
      fallbackCopy(text, format);
    }
  }
});

function fallbackCopy(text, format) {
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    
    if (successful) {
      toast(`已复制 ${uploadedFiles.size} 个 ${format.toUpperCase()} 链接 (Fallback)`);
    } else {
      toast("复制失败: 浏览器拒绝了剪贴板访问");
    }
  } catch (err) {
    toast("复制失败: " + err.message);
  }
}

// ========== Upload ==========
uploadBtn.addEventListener("click", async () => {
  if (!files.length) {
    summary.textContent = "先选择图片文件";
    return;
  }

  uploading = true;
  uploadBtn.disabled = true;
  results.innerHTML = "";
  resultsPanel.style.display = "block";
  progressFill.style.width = "0%";
  finished = 0;
  total = files.length;
  uploadedUrls.clear();
  uploadedFiles.clear();
  copyAllBtn.disabled = true;
  uploadAllBtn.disabled = true;

  const form = new FormData();
  form.set("quality", qualityInput.value);
  form.set("effort", effortInput.value);
  form.set("maxWidth", maxWidthInput.value || "0");

  for (const file of files) {
    form.append("images", file, file.name);
  }

  try {
    const response = await fetch("/api/compress", {
      method: "POST",
      body: form
    });

    if (!response.ok || !response.body) {
      throw new Error(`上传请求失败：${response.status}`);
    }

    await readNdjson(response.body, handleEvent);
  } catch (error) {
    addGlobalMessage(
      error instanceof Error ? error.message : String(error),
      "error"
    );
  } finally {
    uploading = false;
    uploadBtn.disabled = false;
  }
});

// ========== NDJSON streaming reader ==========
async function readNdjson(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // non-JSON line, ignore
      }
    }
  }

  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer));
    } catch {
      // ignore
    }
  }
}

// ========== Event handler ==========
function handleEvent(event) {
  if (event.type === "start") {
    addGlobalMessage(
      `开始处理 ${event.total} 个文件 — 质量 ${event.quality}，effort ${event.effort}` +
        (event.maxWidth ? `，最大宽度 ${event.maxWidth}px` : ""),
      "info"
    );
    return;
  }

  if (event.type === "file-start") {
    const card = createCard(event.index, event.name);
    card.querySelector(".meta").textContent = `原始大小 ${formatBytes(event.originalBytes)}`;
    setStatus(event.index, "处理中", "running");
    return;
  }

  if (event.type === "compressed") {
    const card = getCard(event.index);
    if (!card) return;
    card.querySelector(".meta").textContent =
      `${formatBytes(event.originalBytes)} → ${formatBytes(event.compressedBytes)}，节省 ${event.savedPercent}%` +
      (event.width && event.height ? `，${event.width}×${event.height}` : "");
    appendLog(event.index, `已压缩为 ${event.outputName}`);

    const placeholder = card.querySelector(".placeholder");
    if (placeholder) {
      placeholder.textContent = "";
      placeholder.classList.remove("placeholder");
      const img = document.createElement("img");
      img.src = event.previewUrl;
      img.className = "preview-img";
      placeholder.append(img);
    }

    const actionsContainer = card.querySelector(".card-actions");
    if (actionsContainer && !actionsContainer.hasChildNodes()) {
      const uploadSingleBtn = document.createElement("button");
      uploadSingleBtn.className = "btn btn-primary";
      uploadSingleBtn.style.width = "100%";
      uploadSingleBtn.style.padding = "4px 8px";
      uploadSingleBtn.textContent = "上传图床";
      uploadSingleBtn.onclick = () => uploadToPicgo(event.index, event.fileId, uploadSingleBtn);
      actionsContainer.append(uploadSingleBtn);
    }

    uploadAllBtn.disabled = false;
    card.dataset.fileId = event.fileId;
    return;
  }

  if (event.type === "picgo-log") {
    appendLog(event.index, event.message);
    return;
  }

  if (event.type === "file-done") {
    finished += 1;
    setStatus(event.index, "压缩就绪", "done");
    updateProgress();
    return;
  }

  if (event.type === "file-skip") {
    finished += 1;
    setStatus(event.index, "跳过", "skip");
    appendLog(event.index, event.reason);
    updateProgress();
    return;
  }

  if (event.type === "file-error") {
    finished += 1;
    setStatus(event.index, "失败", "error");
    appendLog(event.index, event.message);
    updateProgress();
    return;
  }

  if (event.type === "done") {
    addGlobalMessage("全部处理完成", "done");
  }
}

// ========== DOM helpers ==========
function createCard(index, name) {
  const card = document.createElement("article");
  card.className = "result-card";
  card.dataset.index = String(index);
  card.innerHTML = `
    <div class="card-left">
      <div class="preview-container placeholder">处理中</div>
      <div class="card-actions" style="margin-top: 8px;"></div>
    </div>
    <div class="card-right">
      <div class="result-head">
        <div>
          <h2></h2>
          <p class="meta"></p>
        </div>
        <span class="status"></span>
      </div>
      <div class="url-container"></div>
      <details class="log-details" style="margin-top:12px;font-size:12px;color:var(--text-3);">
        <summary style="cursor:pointer;user-select:none;">运行日志</summary>
        <pre class="log" style="margin-top:8px;"></pre>
      </details>
    </div>
  `;
  card.querySelector("h2").textContent = name;
  results.append(card);
  return card;
}

function getCard(index) {
  return document.querySelector(`.result-card[data-index="${index}"]`);
}

function setStatus(index, label, kind) {
  const card = getCard(index);
  if (!card) return;
  const status = card.querySelector(".status");
  status.textContent = label;
  status.className = `status ${kind}`;
}

function appendLog(index, message) {
  const card = getCard(index);
  if (!card) return;
  const log = card.querySelector(".log");
  log.textContent += `${message}\n`;
  log.scrollTop = log.scrollHeight;
}

function appendUrl(index, url) {
  const card = getCard(index);
  if (!card) return;
  const container = card.querySelector(".url-container");

  const row = document.createElement("div");
  row.className = "url-row";

  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = url;

  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.title = "复制 URL";
  copyBtn.type = "button";
  copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      toast("已复制 URL");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      }, 2000);
    });
  });

  row.append(link, copyBtn);
  container.append(row);
}

function addGlobalMessage(message, kind) {
  const line = document.createElement("div");
  line.className = `global ${kind}`;
  line.textContent = message;
  results.prepend(line);
}

function updateProgress() {
  const percent = total ? Math.round((finished / total) * 100) : 0;
  progressFill.style.width = `${percent}%`;
  summary.textContent = `${finished}/${total} 已完成`;
}

// ========== Toast ==========
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.querySelector("#toasts").append(el);
  setTimeout(() => el.remove(), 2600);
}

// ========== Utils ==========
function totalBytes(items) {
  return items.reduce((sum, file) => sum + file.size, 0);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

// ========== Upload to PicGo ==========
async function uploadToPicgo(index, fileId, btn) {
  btn.disabled = true;
  btn.textContent = "上传中...";
  setStatus(index, "上传中", "running");
  let succeeded = false;

  try {
    const res = await fetch("/api/upload-picgo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId })
    });

    if (!res.ok || !res.body) {
      let message = `上传请求失败：${res.status}`;
      try {
        const payload = await res.json();
        message = payload.error ?? message;
      } catch {
        // keep fallback message
      }
      throw new Error(message);
    }

    await readNdjson(res.body, (event) => {
      if (event.type === "picgo-log") {
        appendLog(index, event.message);
      } else if (event.type === "done") {
        setStatus(index, "上传成功", "done");
        if (event.url) {
          appendUrl(index, event.url);
          uploadedUrls.set(index, event.url);
          const card = getCard(index);
          const name = card ? card.querySelector("h2").textContent : "image";
          uploadedFiles.set(index, { url: event.url, name });
          copyAllBtn.disabled = false;
        }
        btn.remove();
        succeeded = true;
      } else if (event.type === "error") {
        setStatus(index, "上传失败", "error");
        appendLog(index, event.message);
        btn.disabled = false;
        btn.textContent = "重新上传";
      }
    });
  } catch (err) {
    setStatus(index, "上传失败", "error");
    appendLog(index, String(err));
    btn.disabled = false;
    btn.textContent = "重新上传";
  }

  return succeeded;
}

uploadAllBtn.addEventListener("click", () => {
  uploadReadyImagesSequentially();
});

async function uploadReadyImagesSequentially() {
  if (uploadQueueRunning) return;

  const jobs = Array.from(document.querySelectorAll(".result-card"))
    .map((card) => ({
      card,
      index: Number(card.dataset.index),
      fileId: card.dataset.fileId,
      btn: card.querySelector(".card-actions .btn-primary")
    }))
    .filter((job) => job.fileId && job.btn && !job.btn.disabled);

  if (!jobs.length) {
    uploadAllBtn.disabled = true;
    return;
  }

  uploadQueueRunning = true;
  uploadAllBtn.disabled = true;
  uploadConcurrencyInput.disabled = true;
  const concurrency = clampNumber(uploadConcurrencyInput.value, 1, 10, 5);
  uploadAllBtn.textContent = `上传队列 0/${jobs.length}`;
  addGlobalMessage(`开始队列上传：共 ${jobs.length} 张，并发 ${concurrency}`, "info");

  let completed = 0;
  let succeeded = 0;
  let nextJobIndex = 0;

  const updateQueueProgress = () => {
    uploadAllBtn.textContent = `上传队列 ${completed}/${jobs.length}`;
    summary.textContent = `上传队列 ${completed}/${jobs.length}，成功 ${succeeded}`;
  };

  const runWorker = async () => {
    while (nextJobIndex < jobs.length) {
      const job = jobs[nextJobIndex];
      nextJobIndex += 1;
      const ok = await uploadToPicgo(job.index, job.fileId, job.btn);
      completed += 1;
      if (ok) succeeded += 1;
      updateQueueProgress();
    }
  };

  try {
    updateQueueProgress();
    const workers = Array.from(
      { length: Math.min(concurrency, jobs.length) },
      () => runWorker()
    );
    await Promise.all(workers);
  } finally {
    uploadQueueRunning = false;
    uploadConcurrencyInput.disabled = false;
    const hasPending = document.querySelector(".card-actions .btn-primary:not(:disabled)");
    uploadAllBtn.disabled = !hasPending;
    uploadAllBtn.innerHTML = uploadAllDefaultHtml;
    addGlobalMessage(`队列上传完成：成功 ${succeeded}/${jobs.length}`, succeeded === jobs.length ? "done" : "error");
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

async function cleanupServerOutput() {
  try {
    await fetch("/api/cleanup", {
      method: "POST"
    });
  } catch {
    // Local cleanup is best effort.
  }
}

// ========== Health check ==========
fetch("/api/health")
  .then((r) => r.json())
  .then((data) => {
    health.textContent = `PicGo: ${data.picgoPath}`;
    health.style.color = "var(--green)";
  })
  .catch(() => {
    health.textContent = "PicGo 状态未知";
    health.style.color = "var(--red)";
  });
