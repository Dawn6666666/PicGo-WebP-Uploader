# PicGo WebP Uploader

给 AI 写笔记用的批量传图工具。CLI 直接读取本机文件或目录，通过 PicGo 或自己的 R2 图床管理站上传。返回的 JSON 按正文引用顺序保存原名、来源、图床链接和 Shirone Markdown。网页支持先预览，再上传单张或整批。

在 JavaGuide / 小林 coding 的学习笔记中，正文可以继续沿用原图链接。自制截图、需要放到自有 R2 的封面、需要备份的外链，可分别使用下面的上传和迁移命令。

## 安装

Windows、Linux 均可使用。建议使用 Node.js 22.14 或更高版本。直连 R2 管理站只需要站点地址和登录凭据。选择 PicGo 后端时需要本机已配置的 PicGo CLI。在本项目目录执行

```sh
npm ci
node cli.mjs --help
```

如果机器上只有 PicGo 桌面版，可用 `npm install -g picgo` 安装 CLI，再为它配置同一个图床。Linux 上已安装较新版系统 libvips、Sharp 安装时提示编译失败，可执行 `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci` 使用预编译库。

执行一次 `npm link`，就能在博客文章目录直接运行 `picgo-webp`。下文的 `picgo-webp` 也可以替换为 `node "/本项目的绝对路径/cli.mjs"`。两种用法都无需启动网页服务。

## 上传本地图

```sh
picgo-webp "./images" --output "./图片映射.json"
picgo-webp upload "./抓包截图.png" "./图解/栈帧.svg" --output "./图片映射.json"
```

目录按名称排序、递归展开，忽略非图片文件。多个路径按命令行给出的顺序处理。默认质量 80、effort 6、保留分辨率。带小字或细线的截图可试用质量 90。

- 静态 JPEG、PNG、WebP 会试编码 WebP，只有体积变小才选用。GIF、动态 WebP 和 CLI 的 SVG 在原尺寸下原样保留。AVIF、TIFF 转为静态 WebP。
- 用 `--max-dimension 2560` 等比限制最长边，竖图也适用。`--max-width` 可单独限制宽度，两者同时设置时满足两个上限。确实需要缩小时，即使产物稍大也采用指定尺寸。GIF 和动态 WebP 缩小时输出动态 WebP。
- 每张图的 `mimeType`、`width`、`height`、`compressedBytes` 和 `md5` 对应最终选用的文件。`keptOriginal: true` 表示逐字节保留了原图。扩展名取实际输出格式。

## 直连 R2 图床管理站

将项目根目录的 `.env.example` 复制为 `.env`，将 `R2_GALLERY_URL` 设为管理站的根地址，设置 `R2_GALLERY_PASSWORD` 为登录密码，或设置 `R2_GALLERY_TOKEN` 为已登录浏览器的 `auth-token` cookie 值。两者都有时优先使用 token。Web、CLI 和交互模式启动时读取项目根目录的 `.env`。同名进程环境变量优先于文件中的值。`UPLOAD_BACKEND` 可设为 `gallery` 或 `picgo`。留空时，有站点地址就使用 gallery，否则使用 PicGo。非交互 CLI 的 `--backend gallery|picgo` 优先级最高。修改配置后重新启动网页服务。

Linux Bash 示例，密码通过终端提示输入

```bash
export R2_GALLERY_URL='https://gallery.example.org'
read -rsp '图床密码 ' R2_GALLERY_PASSWORD && export R2_GALLERY_PASSWORD
picgo-webp upload --input images.json --output uploaded.json
```

Windows PowerShell 7 示例

```powershell
$env:R2_GALLERY_URL = 'https://gallery.example.org'
$env:R2_GALLERY_PASSWORD = Read-Host '图床密码' -MaskInput
picgo-webp upload --input images.json --output uploaded.json
```

管理站默认按 `img/YYYY/MM/DD/<32 位小写 MD5>.<实际扩展名>` 建新对象，日期和前缀取管理站配置。CLI 对最终文件计算 MD5，先向管理站查询。命中已有内容时，沿用服务端返回的真实 `key` 和 `url`，可跨日期、跨原名、跨运行复用。新对象通过签名地址直传，并由管理站确认。管理站在预检时声明需要回退或返回 404，工具会改走该站的表单上传，此时服务端收到文件后再查重。鉴权、直传或最终确认失败会在清单中标明阶段。

`duplicate` 为 `true` 表示复用了已有对象或本批前一个条目的上传结果。同图在清单中出现多次，管理站保存首次上传的原名。每条正文引用仍分别保存自己的原名、出处和图注。

## PicGo 命名与通用参数

PicGo 的默认上传名为 `[文章前缀-]YYYY-MM-DD-原名-MD5.<实际扩展名>`，日期取批次开始时的本机日期。前缀和原名保留中文、字母与数字，空格及路径分隔符等会归一化为短横线。MD5 取**实际上传的文件内容**，共 32 位。

| 参数 | 用途 |
| --- | --- |
| `--prefix java-basis-04` | PicGo 文件名前缀，可用文章 slug 分组 |
| `--naming date-name` | 默认，日期、原名、MD5 |
| `--naming name` | 原名、MD5，跨日期重跑可得到同一文件名 |
| `--naming hash` | 仅使用 MD5，可与前缀组合 |
| `--quality` / `--effort` | WebP 编码参数，默认 `80` / `6` |
| `--max-width` / `--max-dimension` | 最大宽度 / 最长边，默认均为 `0`，即不限 |
| `--compress-concurrency` / `--upload-concurrency` / `--download-concurrency` | 分别默认 `8` / `5` / `4` |

PicGo 在同一 CLI 批次内对相同上传名只传一次，跨批次会重新调用 PicGo。对象目录、域名及插件启用的二次重命名由图床配置决定。正文使用返回的 `url`。例如 `picgo-webp ./images --backend picgo --prefix java-basis-04`。

## 迁移指定外链

```sh
picgo-webp migrate "https://example.org/images/stack.png?v=2" --output migrated.json
```

`migrate` 接收图片直链。每条结果都保留输入的完整 URL（含查询参数），下载临时文件在本次命令结束时清理。个别链接失效时，其余图片继续上传。工具只处理显式提供的来源，正文编辑由写作端完成。

## 给 AI 的图片清单

图片在文章中已经有描述、图注、宽度或出处时，把这些信息随图传入。将以下内容保存为文章目录下的 `images.json`：

```json
{
  "images": [
    {
      "source": "./实验截图/栈帧.png",
      "alt": "调用前后的两个栈帧",
      "caption": "形参和实参中的引用指向同一个对象",
      "widthPercent": 60
    }
  ]
}
```

```sh
picgo-webp upload --input images.json --output uploaded.json
```

远程清单将 `source` 换成图片 URL，运行 `picgo-webp migrate --input images.json`。可选字段 `sourcePage` 保存来源**文章**的 HTTP(S) 地址，方便 AI 核对上下文或署名。`--input -` 从标准输入读取相同的 JSON。文件清单的相对路径以清单所在目录为基准，标准输入及位置参数以调用目录为基准。

还可以在同一张图的第一个条目里给出 `"assetAlt": "JVM 栈帧结构", "tags": ["JVM", "运行时数据区"]`。gallery 只在新建素材后写入这些字段。命中已有对象时保留已有的素材说明和标签。`alt`、`caption`、`widthPercent` 始终供各自的正文引用使用。

gallery 成功结果摘录

```json
{
  "ok": true,
  "source": "/notes/实验截图/栈帧.png",
  "sourcePage": null,
  "originalName": "栈帧.png",
  "outputName": "4ba2c5cf6596c21870c48f09bf86c5e7.png",
  "key": "img/2026/11/25/4ba2c5cf6596c21870c48f09bf86c5e7.png",
  "url": "https://cdn.example/img/2026/11/25/4ba2c5cf6596c21870c48f09bf86c5e7.png",
  "duplicate": false,
  "mimeType": "image/png",
  "keptOriginal": true,
  "alt": "调用前后的两个栈帧",
  "caption": "形参和实参中的引用指向同一个对象",
  "widthPercent": 60,
  "markdown": "![调用前后的两个栈帧 w-60%](https://cdn.example/img/2026/11/25/4ba2c5cf6596c21870c48f09bf86c5e7.png \"形参和实参中的引用指向同一个对象\")"
}
```

**写正文时**，按 `source` 和 `index` 对应原图位置，对 `ok: true` 的条目直接使用 `markdown`。Shirone 的可见图注需要让图片独占一行。省略 `caption` 会生成无标题的标准 Markdown 图片；AI 可以依据原段落补图注。`alt` 默认取去掉扩展名的原名。相同原名或同一图片在不同段落的不同图注都保存在各自条目里。

**返回约定**：非交互上传与迁移命令的 stdout 只输出一个 JSON 对象。`items` 保持输入顺序，单张失败包含 `source` 和 `error`。退出码 `0` 表示全部成功，`1` 表示处理或保存失败（仍应读取成功项），`2` 表示参数或清单无效。默认清单保存在工具目录的 `tmp/cli-results/<jobId>/result.json`，绝对路径在 `resultPath`。指定 `--output` 会原子替换该结果文件。重试时，可将失败条目的 `source` 和原有图注整理为新输入清单。

若仅图床素材说明写入失败，条目仍保留 `ok: true`、`url` 和 `markdown`，并附上 `metadataError`。整批退出码为 `1`。可以在管理页按 `key` 补录说明。

## 网页和交互式 CLI

```sh
npm start
```

浏览器打开 `http://127.0.0.1:5177`。页面使用 mdui 2.1.5，组件脚本和样式由本机服务提供。

1. 在「图片来源」选择、拖入或粘贴图片。也可以切换到「本机目录」，输入运行服务的机器上的目录路径，递归读取其中的图片。大批量选图只为前几张生成轻量缩略图。
2. 调整 WebP 质量和最长边，点击「压缩并预览」。质量预设、压缩努力度、最大宽度、请求分批和并发数在「高级设置」中。
3. 在「处理队列」按原文件名核对缩略图、尺寸和体积，点击单张「上传」或「上传全部」。上传失败后可在同一行重试，详细错误见「运行日志」。
4. 选择 Markdown、URL、BBCode 或 HTML，复制单张或当前队列的全部链接。上传前链接指向本地预览，上传后切换为图床地址。Markdown 图片的替代文本（alt）默认取原文件名。

网页质量预设为极省流量 50、省流量 70、均衡 80、高清 90 和最高画质 100。默认选均衡，滑块可在 1–100 之间调整。质量 100 的 WebP 编码仍为有损模式。

PicGo 网页模式将 SVG 栅格化为 WebP，gallery 模式与 CLI 共用保留原图策略。

习惯终端问答时运行 `picgo-webp interactive` 或 `npm run cli`。交互模式可只压缩，完成后保存旧版兼容的 `result.json` 和 `urls.txt`。

| 环境变量 | 默认行为 |
| --- | --- |
| `PICGO_PATH` | 在 PATH 中查找 `picgo`，Windows 支持 npm 安装的 `.cmd`。也可填写可执行文件的绝对路径 |
| `PICGO_CONFIG` | PicGo 自身默认配置。填写配置文件路径可选择另一份配置 |
| `PORT` | 网页服务绑定 `127.0.0.1:5177` |
| `OUTPUT_DIR` | Web 和交互模式的预览目录，默认项目下的 `tmp/output`。非交互 CLI 使用独立的系统临时目录 |

PowerShell 可用 `$env:PICGO_PATH = 'D:\Tools\picgo.cmd'`；Linux 可用 `export PICGO_PATH=/opt/node/bin/picgo`。

## 已有 HTTP 接口

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/health` | 服务状态、当前后端和 PicGo 命令 |
| `POST /api/compress` | multipart 字段 `images`，NDJSON 压缩预览事件 |
| `POST /api/compress-directory` | JSON 字段 `directory`，递归扫描，NDJSON 压缩预览事件 |
| `POST /api/upload-picgo` | JSON 字段 `fileId`，由当前后端上传，返回 NDJSON 日志与结果 |
| `POST /api/cli/compress` | multipart 图片或 JSON 字段 `files`（本机路径数组），返回含 `jobId` 和 `items` 的 JSON |
| `POST /api/cli/compress-directory` / `POST /api/cli/compress-urls` | 分别传 `directory` 或 `urls`，返回压缩清单 |
| `POST /api/cli/upload` | 传 `confirm: true` 和 `jobId` 或 `fileIds`，返回 `items` 与 `urls` |
| `POST /api/cleanup` | 传 `jobIds` 仅清理指定预览批次；省略时清理全部预览批次 |

压缩接口支持 `quality`、`effort`、`maxWidth`、`maxDimension`、`compressConcurrency`。上传及远程下载分别使用 `uploadConcurrency`、`downloadConcurrency`。网页重启后可继续通过已有文件 ID 上传。回归测试使用 `npm test`。
