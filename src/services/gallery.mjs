import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

function httpUrl(value, label) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* report which field is invalid without printing credentials */ }
  throw new Error(`${label} 需要有效的 HTTP(S) 地址`);
}

async function request(url, init, stage) {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(120000) });
  } catch {
    throw new Error(`图床${stage}请求失败，请检查网络、地址或超时`);
  }
}

function check(response, json, stage) {
  if (!response.ok || json?.success !== true) {
    throw new Error(`图床${stage}失败 (HTTP ${response.status})`);
  }
}

function uploaded(data, duplicate = false) {
  if (typeof data?.key !== "string" || !data.key.trim()) throw new Error("图床响应缺少对象 key");
  const url = httpUrl(data.url, "图床响应的 url");
  return { key: data.key, url: url.href, duplicate: duplicate || data.duplicate === true };
}

const jsonHeaders = { "Content-Type": "application/json" };
const directPath = "/api/upload/direct";

export function createGalleryClient(env) {
  const base = httpUrl(env.R2_GALLERY_URL, "R2_GALLERY_URL");
  if (base.pathname !== "/" || base.search || base.hash) throw new Error("R2_GALLERY_URL 请填写图床管理站点的根地址");
  const token = env.R2_GALLERY_TOKEN;
  const password = env.R2_GALLERY_PASSWORD;
  if (!token && !password) throw new Error("请设置 R2_GALLERY_PASSWORD 或 R2_GALLERY_TOKEN");
  if (token && /[\s;,\x00-\x1f\x7f]/.test(token)) throw new Error("R2_GALLERY_TOKEN 只接受 auth-token 的值");

  async function login() {
    if (token) return "auth-token=" + token;
    const res = await request(new URL("/api/auth/login", base), {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ password })
    }, "登录");
    check(res, await res.json().catch(() => null), "登录");
    const cookie = /(?:^|,\s*)(auth-token=[^;,\s]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!cookie) throw new Error("图床登录响应缺少 auth-token");
    return cookie;
  }

  let session;
  async function api(route, stage, body, method = "POST") {
    const current = session ??= login().catch(error => {
      // Share a failed login across the queue. A later web retry can sign in again.
      setTimeout(() => { if (session === current) session = undefined; }, 30000).unref();
      throw error;
    });
    const multipart = body instanceof FormData;
    const headers = new Headers(multipart ? undefined : jsonHeaders);
    headers.set("Cookie", await current);
    const res = await request(new URL(route, base), {
      method, headers, body: multipart ? body : JSON.stringify(body)
    }, stage);
    const json = await res.json().catch(() => null);
    if ([401, 403].includes(res.status)) {
      if (session === current) session = undefined;
      throw new Error(`图床${stage}鉴权失败 (HTTP ${res.status})`);
    }
    if (route === directPath && body.intent === "prepare" && (res.status === 404 || json?.fallback === true)) return null;
    check(res, json, stage);
    if (!json.data || typeof json.data !== "object") throw new Error(`图床${stage}响应缺少 data`);
    return json.data;
  }

  async function upload(filePath, image) {
    const { originalName, compressedBytes, md5, mimeType, assetAlt, tags } = image;
    const file = await fs.open(filePath, "r");
    let header;
    try {
      header = Buffer.alloc(Math.min(4096, compressedBytes));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await file.close();
    }

    const prepared = await api(directPath, "预检", {
      intent: "prepare", fileName: originalName, fileSize: compressedBytes, fileHeader: header.toString("base64"),
      contentMd5: Buffer.from(md5, "hex").toString("base64"), useContentHashName: true
    });
    if (prepared?.existing) return uploaded(prepared.existing, true);
    let result;
    if (prepared === null) {
      const form = new FormData();
      form.set("file", new Blob([await fs.readFile(filePath)], { type: mimeType }), image.outputName);
      form.set("originalName", originalName);
      form.set("useContentHashName", "true");
      result = uploaded(await api("/api/upload", "代理上传", form));
    } else {
      if (typeof prepared.ticket !== "string" || !prepared.ticket || !prepared.headers || typeof prepared.headers !== "object") {
        throw new Error("图床预检响应缺少签名上传参数");
      }
      const url = httpUrl(prepared.uploadUrl, "图床预检的 uploadUrl");
      const headers = new Headers({ "Content-Length": String(compressedBytes) });
      for (const [key, value] of Object.entries(prepared.headers)) {
        if (["cache-control", "content-md5", "content-type"].includes(key.toLowerCase())) headers.set(key, value);
      }
      const body = createReadStream(filePath);
      try {
        const res = await request(url, { method: "PUT", headers, body, duplex: "half" }, "直传");
        await res.body?.cancel();
        if (!res.ok) throw new Error(`图床直传失败 (HTTP ${res.status})`);
      } finally {
        body.destroy();
      }
      result = uploaded(await api(directPath, "确认上传", { intent: "complete", ticket: prepared.ticket }));
    }

    if (!result.duplicate && (assetAlt != null || tags != null)) {
      try {
        await api("/api/images/metadata", "保存素材说明", {
          key: result.key, metadata: { alt: assetAlt ?? undefined, tags: tags ?? undefined }
        }, "PATCH");
      } catch (error) {
        result.metadataError = error.message;
      }
    }
    return result;
  }
  return { upload };
}
