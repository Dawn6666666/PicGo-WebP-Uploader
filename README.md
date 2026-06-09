# PicGo WebP Uploader

一个本地运行的图片压缩、预览与 PicGo 上传工具。项目使用 Node.js、Express、Sharp 和 PicGo CLI，将图片批量转换为 WebP，并在确认压缩结果后上传到已配置的图床。

## 功能概览

- **两阶段处理流程**：先压缩并预览，再选择单张上传或批量上传。
- **WebP 压缩参数**：支持质量、effort、最大宽度和压缩并发配置。
- **大文件选择优化**：大批量选择时先生成轻量缩略图，避免直接在页面中解码大体积原图。
- **本地目录直读**：可输入本机目录路径，由后端直接扫描磁盘并压缩，避免浏览器传输和缓存整批原图。
- **批量上传队列**：上传阶段使用可配置并发，避免一次性启动过多 PicGo 进程。
- **链接复制**：支持 Markdown、URL、BBCode 和 HTML `<img>` 格式；压缩后可复制本地预览链接，上传后自动切换为图床 URL。
- **临时文件隔离**：压缩产物写入独立批次目录，避免重复图片或不同压缩参数互相覆盖。

## 架构与数据流

```mermaid
flowchart TD
  A["浏览器页面"] --> B{"输入来源"}
  B -->|"选择 / 拖拽 / 粘贴文件"| C["前端生成轻量缩略图"]
  B -->|"本地目录路径"| D["POST /api/compress-directory"]
  C --> E["POST /api/compress"]
  E --> F["Express 接收 FormData"]
  D --> G["后端扫描本地目录"]
  F --> H["Sharp 并发压缩"]
  G --> H
  H --> I["计算压缩内容 MD5"]
  I --> J["写入 tmp/output 批次目录"]
  J --> K["GET /preview 静态预览"]
  K --> A
  A -->|"单张或批量上传"| L["POST /api/upload-picgo"]
  L --> M["PicGo CLI"]
  M --> N["图床 / R2"]
  N --> O["返回最终 URL"]
  O --> A
```

## 处理时序

```mermaid
sequenceDiagram
  autonumber
  actor User as 用户
  participant UI as 浏览器页面
  participant API as Express API
  participant Sharp as Sharp 压缩
  participant Temp as tmp/output
  participant PicGo as PicGo CLI
  participant Store as 图床 / R2

  User->>UI: 选择图片或输入本机目录
  alt 选择图片
    UI->>UI: 生成轻量缩略图
    UI->>API: POST /api/compress
  else 本地目录直读
    UI->>API: POST /api/compress-directory
    API->>API: 扫描本机目录
  end

  API->>Sharp: 并发转换为 WebP
  Sharp-->>API: WebP buffer 与图片信息
  API->>API: 计算压缩内容 MD5
  API->>Temp: 写入批次隔离的预览文件
  API-->>UI: NDJSON 进度与 previewUrl
  UI->>Temp: GET /preview/...
  Temp-->>UI: 返回压缩后预览图

  User->>UI: 单张上传或上传全部
  UI->>API: POST /api/upload-picgo
  API->>Temp: 读取压缩后的 WebP
  API->>PicGo: picgo upload filePath
  PicGo->>Store: 上传到图床
  Store-->>PicGo: 返回最终 URL
  PicGo-->>API: 输出上传日志和 URL
  API-->>UI: NDJSON 上传结果
  UI->>UI: 更新链接并支持复制
```

### 路径说明

压缩预览文件会写入本地临时目录：

```text
tmp/output/{batchId}/{yyyy}/{mm}/{dd}/{index}-{md5}.webp
```

其中 `batchId` 只用于本地临时文件隔离和预览缓存隔离，不参与最终图床 URL 的生成。最终 URL 由 PicGo 及其上传插件配置决定。

## 安装与启动

### 环境要求

- Node.js 18 或更高版本
- 已安装并配置可用的 PicGo CLI

### 安装依赖

```powershell
cd D:\Code\Other\picgo-webp-uploader
npm install
```

### 启动服务

```powershell
npm start
```

默认访问地址：

```text
http://localhost:5177
```

如果端口 `5177` 已被占用，可以临时指定其他端口：

```powershell
$env:PORT=5178; npm start
```

## 配置项

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5177` | Web 服务端口 |
| `PICGO_PATH` | `C:\nvm4w\nodejs\picgo.cmd` | PicGo CLI 可执行文件路径 |
| `OUTPUT_DIR` | `tmp/output` | 压缩预览文件输出目录 |

示例：

```powershell
$env:PICGO_PATH="D:\your\path\to\picgo.cmd"
$env:OUTPUT_DIR="D:\temp\picgo-webp-output"
npm start
```

### 前端控制项

| 控制项 | 默认值 | 说明 |
| --- | --- | --- |
| WebP 质量 | `82` | Sharp WebP quality，`100` 表示最高质量，不等同于 lossless |
| 压缩 effort | `6` | Sharp WebP effort，数值越高通常越慢、压缩更充分 |
| 压缩并发 | `8` | 后端 Sharp 并发任务数；前端可选到 `24`，服务端最多接受 `64` |
| 请求分批 | 不分批 | 仅在浏览器内存紧张时手动启用 |
| 最大宽度 | `0` | `0` 表示不限制；大于 `0` 时按宽度等比缩小且不放大 |
| 上传并发 | `5` | 批量上传 PicGo 进程并发数；前端可选到 `10` |

## 使用流程

### 选择文件模式

1. 通过点击、拖拽或粘贴选择图片。
2. 页面为大批量文件生成轻量缩略图，避免直接显示原图造成卡顿。
3. 调整压缩参数。
4. 点击“压缩并预览”。
5. 检查压缩后大小、尺寸和预览图。
6. 单张上传或点击“上传全部就绪图片”。
7. 使用“复制全部”导出链接。

### 本地目录模式

适合处理较大的相册目录，例如：

```text
D:\Code\Blog\MyBlog\public\images\albums\AcgExample
```

使用方式：

1. 在“本机目录路径”输入框中填入目录。
2. 点击“压缩本地目录”。
3. 后端直接读取本机磁盘文件并压缩。
4. 预览、上传和复制链接流程与选择文件模式一致。

该模式不会把原图批量加载到浏览器内存中，更适合上百 MB 的图片目录。

## API 说明

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | `GET` | 返回服务状态和 PicGo 路径 |
| `/api/compress` | `POST` | 接收 `multipart/form-data` 图片并压缩，返回 NDJSON 事件流 |
| `/api/compress-directory` | `POST` | 接收本机目录路径，后端扫描并压缩，返回 NDJSON 事件流 |
| `/api/upload-picgo` | `POST` | 根据压缩结果 `fileId` 调用 PicGo 上传 |
| `/api/cleanup` | `POST` | 清理压缩预览输出目录 |

### CLI / AI 优化 API

这组接口面向 PowerShell、curl、脚本和 AI Agent 调用，返回普通 JSON，避免命令行工具解析 NDJSON 事件流。流程固定为两步：

1. 压缩图片并拿到 `jobId`、`fileId`、压缩体积和本地预览地址。
2. 用户或 AI 检查结果后，显式传入 `confirm: true` 才会上传到 PicGo。

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/cli/compress-directory` | `POST` | 压缩本机目录，返回完整 JSON 清单 |
| `/api/cli/compress` | `POST` | 接收 `multipart/form-data` 图片，或接收 JSON 本地文件路径数组并压缩，返回完整 JSON 清单 |
| `/api/cli/compress-urls` | `POST` | 下载远程图片 URL 到临时目录后压缩，返回完整 JSON 清单 |
| `/api/cli/upload` | `POST` | 上传指定 `fileIds` 或整个 `jobId`，必须传 `confirm: true` |

#### 压缩本机目录

PowerShell:

```powershell
$body = @{
  directory = "D:\Code\Blog\MyBlog\public\images\albums\AcgExample"
  quality = 82
  effort = 6
  maxWidth = 0
  compressConcurrency = 8
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Uri "http://localhost:5177/api/cli/compress-directory" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body

$result.items | Select-Object index,name,originalBytes,compressedBytes,savedPercent,fileId
```

curl:

```bash
curl -X POST http://localhost:5177/api/cli/compress-directory \
  -H "Content-Type: application/json" \
  -d '{"directory":"D:\\Code\\Blog\\MyBlog\\public\\images\\albums\\AcgExample","quality":82,"effort":6,"maxWidth":0,"compressConcurrency":8}'
```

响应结构示例：

```json
{
  "ok": true,
  "jobId": "0fb5fbf9-35bb-4ac2-9398-2cc1f8f191e5",
  "source": "directory",
  "total": 2,
  "compressed": 2,
  "skipped": 0,
  "failed": 0,
  "originalBytes": 10485760,
  "compressedBytes": 3145728,
  "savedPercent": 70,
  "items": [
    {
      "ok": true,
      "index": 0,
      "name": "cover.png",
      "fileId": "0fb5fbf9-35bb-4ac2-9398-2cc1f8f191e5/2026/06/09/0-a1b2.webp",
      "previewUrl": "/preview/0fb5fbf9-35bb-4ac2-9398-2cc1f8f191e5/2026/06/09/0-a1b2.webp",
      "compressedBytes": 1536000,
      "savedPercent": 68.5,
      "width": 1920,
      "height": 1080
    }
  ]
}
```

#### 压缩命令行上传的文件

PowerShell:

```powershell
curl.exe -X POST http://localhost:5177/api/cli/compress `
  -F "quality=82" `
  -F "effort=6" `
  -F "images=@D:\Pictures\a.png" `
  -F "images=@D:\Pictures\b.jpg"
```

也可以直接传本机文件路径数组，避免把本机图片重新走一遍 HTTP 二进制上传：

```powershell
$body = @{
  files = @(
    "D:\Pictures\a.png",
    "D:\Pictures\b.jpg"
  )
  quality = 82
  effort = 6
  maxWidth = 0
  compressConcurrency = 8
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Uri "http://localhost:5177/api/cli/compress" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

#### 压缩远程图片 URL

远程 URL 会先下载到 `tmp/remote-input/{jobId}`，随后复用本地压缩流程。无论压缩成功还是下载中途失败，这批下载下来的原图临时文件都会自动清理，压缩产物仍保留在 `tmp/output`，等待确认上传。

```powershell
$body = @{
  urls = @(
    "https://example.com/a.jpg",
    "https://example.com/b.png"
  )
  quality = 82
  effort = 6
  maxWidth = 0
  downloadConcurrency = 4
  compressConcurrency = 8
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Uri "http://localhost:5177/api/cli/compress-urls" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

#### 确认后上传

上传整个压缩批次：

```powershell
$uploadBody = @{
  confirm = $true
  jobId = $result.jobId
  uploadConcurrency = 5
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:5177/api/cli/upload" `
  -Method Post `
  -ContentType "application/json" `
  -Body $uploadBody
```

只上传选中的文件：

```powershell
$selectedFileIds = @(
  $result.items[0].fileId,
  $result.items[1].fileId
)

$uploadBody = @{
  confirm = $true
  fileIds = $selectedFileIds
  uploadConcurrency = 2
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:5177/api/cli/upload" `
  -Method Post `
  -ContentType "application/json" `
  -Body $uploadBody
```

上传响应会返回 `items` 和 `urls`。其中 `urls` 是成功上传后的最终图床链接数组，`items` 保留每张图的 `fileId`、`url`、PicGo 原始输出和错误信息。

### 交互式 CLI

如果你想直接在终端里一步步选参数，可以运行：

```powershell
npm run cli
```

这个模式会让你选择来源（目录、文件或远程 URL）、质量、effort、最大宽度、压缩并发和上传并发。上传成功后会自动尝试把最终 URL 复制到剪贴板，同时把完整结果保存到 `tmp/cli-results/{jobId}/result.json` 和 `urls.txt`。

## 运行时行为

- 服务启动时会清理上一次残留的输入临时文件和预览输出文件。
- 点击“清空”会调用 `/api/cleanup` 清理预览产物。
- 单张上传成功后会删除对应的本地压缩文件，并清理空目录。
- 压缩文件名使用压缩内容 MD5，确保同一内容生成稳定标识。
- 上传返回 URL 来自 PicGo 输出日志，最终对象 key 由 PicGo 上传插件配置决定。

## 注意事项

- 本工具面向本机使用，不建议直接暴露到公网。
- 本地目录直读接口可以访问运行该 Node 进程的文件系统，请只在可信环境中使用。
- GIF 动图不会作为动图处理；当前压缩流程面向静态图片。
- WebP `quality: 100` 不是无损 WebP。如需真正 lossless，需要在代码中启用 Sharp 的 `lossless: true`。
- Windows 下执行 `.cmd` 格式的 PicGo CLI 时，服务端已对 `spawn` 启用 `shell: true`。
