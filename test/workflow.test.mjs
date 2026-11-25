import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createCompressService } from "../src/services/compress.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const server = fileURLToPath(new URL("../server.mjs", import.meta.url));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "picgo workflow "));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "uploader.cjs");
  await fs.writeFile(script, `
    const fs = require("node:fs"), path = require("node:path");
    const [command, file] = process.argv.slice(2);
    if (command !== "upload" || !fs.statSync(file).size) process.exit(1);
    fs.appendFileSync(process.env.CALLS, path.basename(file) + "\\n");
    console.log(fs.existsSync(process.env.DENY)
      ? "[PicGo ERROR] See https://help.example/error"
      : "https://cdn.example/" + encodeURIComponent(path.basename(file)));
  `);
  const win = process.platform === "win32";
  const picgo = path.join(dir, win ? "picgo.cmd" : "picgo");
  await fs.writeFile(picgo, win ? '@echo off\r\nnode "%~dp0uploader.cjs" %*\r\n'
    : '#!/usr/bin/env node\nrequire("./uploader.cjs");\n', { mode: 0o755 });
  const env = { ...process.env, PICGO_PATH: picgo, PICGO_CONFIG: "", CALLS: path.join(dir, "calls"), DENY: path.join(dir, "deny"),
    R2_GALLERY_URL: "", R2_GALLERY_PASSWORD: "", R2_GALLERY_TOKEN: "" };
  async function run(args, stdin = "") {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: "pipe" });
    child.stdin.end(stdin);
    const [[code], stdout, stderr] = await Promise.all([once(child, "close"), text(child.stdout), text(child.stderr)]);
    return { code, result: JSON.parse(stdout), stderr };
  }
  return { dir, env, run };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10"/></svg>';
const paletteDiagram = () => sharp(Buffer.from('<svg width="128" height="128"><rect width="128" height="128" fill="white"/><path d="M0 0L128 128M0 128L128 0" stroke="black"/></svg>'))
  .png({ palette: true, colours: 2 }).toBuffer();

test("local manifest keeps provenance through collisions, deduplication and partial failure", async t => {
  const { dir, run, env } = await fixture(t);
  const entries = [];
  for (const folder of ["第一章", "第二章"]) {
    await fs.mkdir(path.join(dir, folder));
    const source = folder + "/示意 [1].png";
    await sharp({ create: { width: 20, height: 10, channels: 3, background: folder === "第一章" ? "red" : "blue" } })
      .png().toFile(path.join(dir, source));
    entries.push({ source, alt: "示意 [1]", caption: '两处 "引用"', widthPercent: 60, sourcePage: "https://example.org/java" });
  }
  entries.push({ ...entries[0], caption: "另一处引用" }, { source: "missing.png" });
  await fs.writeFile(path.join(dir, "input.json"), JSON.stringify({ images: entries }));
  const { result, code } = await run(["upload", "--input", "input.json", "--output", "result.json", "--prefix", "java/basis", "--max-width", "10"]);
  assert.equal(code, 1);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
  const [a, b, c, missing] = result.items;
  assert.deepEqual(result.items.map(row => row.source), entries.map(row => path.join(dir, row.source)));
  assert.equal(a.sourcePage, "https://example.org/java");
  assert.equal(a.originalName, b.originalName);
  assert.notEqual(a.url, b.url);
  assert.equal(a.url, c.url);
  assert.equal(a.width, 10);
  assert.equal(a.height, 5);
  assert.match(a.outputName, /^java-basis-\d{4}-\d{2}-\d{2}-示意-1-[a-f0-9]{32}\.webp$/);
  assert.equal(a.markdown, `![示意 \\[1\\] w-60%](${a.url} "两处 \\"引用\\"")`);
  assert.match(c.markdown, /另一处引用/);
  assert.equal(missing.url, undefined);
  assert.equal((await fs.readFile(env.CALLS, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(result, JSON.parse(await fs.readFile(result.resultPath)));
});

test("default directory upload is recursive and keeps SVG bytes", async t => {
  const { dir, run } = await fixture(t);
  await fs.mkdir(path.join(dir, "images", "child"), { recursive: true });
  await fs.writeFile(path.join(dir, "images", "child", "diagram.svg"), svg);
  await fs.writeFile(path.join(dir, "images", "notes.txt"), "skip");
  const { result, code } = await run(["images", "--naming", "hash", "--output", "result.json"]);
  assert.equal(code, 0);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].outputName, result.items[0].md5 + ".svg");
  assert.equal(result.items[0].compressedBytes, Buffer.byteLength(svg));
  assert.equal(result.items[0].markdown, `![diagram](${result.items[0].url})`);
});

test("migration retains the exact URL, decoded name and input order across download errors", async t => {
  const { run } = await fixture(t);
  const gif = await sharp(Buffer.from(svg)).gif().toBuffer();
  const sourceServer = http.createServer((req, res) => {
    if (req.url.startsWith("/404")) { res.writeHead(404).end(); return; }
    if (req.url === "/asset") { res.writeHead(200, { "content-type": "image/gif" }).end(gif); return; }
    res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
  }).listen(0, "127.0.0.1");
  await once(sourceServer, "listening");
  t.after(() => sourceServer.close());
  const base = `http://127.0.0.1:${sourceServer.address().port}`;
  const good = base + "/" + encodeURIComponent("引用 图.svg") + "?version=1";
  const entries = [{ source: base + "/404" }, { source: good, alt: "引用传递" }, { source: base + "/asset" }];
  const { code, result } = await run(["migrate", "--input", "-", "--naming", "name", "--output", "out.json"], JSON.stringify(entries));
  assert.equal(code, 1);
  assert.match(result.items[0].error, /404/);
  assert.equal(result.items[1].originalName, "引用 图.svg");
  assert.equal(result.items[1].source, good);
  assert.match(result.items[1].outputName, /^引用-图-[a-f0-9]{32}\.svg$/);
  assert.match(result.items[1].markdown, /^!\[引用传递\]/);
  assert.equal(result.items[2].originalName, "asset");
  assert.equal(result.items[2].mimeType, "image/gif");
  assert.equal(result.items[2].outputName, "asset-" + md5(gif) + ".gif");
});

test("invalid options and manifests are rejected before dispatching PicGo", async t => {
  const { run, env } = await fixture(t);
  assert.equal((await run(["a", "--quality", "0"])).code, 2);
  assert.equal((await run(["--input", "-"], '[{"source":"a","widthPercent":101}]')).code, 2);
  await assert.rejects(fs.access(env.CALLS));
});

async function startWeb(t, dir, env) {
  const child = spawn(process.execPath, [server], { cwd: path.dirname(dir), env: { ...env, PORT: "0", OUTPUT_DIR: path.join(dir, "previews") },
    stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(child, "close");
  const stop = async () => { if (child.exitCode === null) child.kill(); await closed; };
  t.after(stop);
  const [startup] = await once(child.stdout, "data");
  const port = /localhost:(\d+)/.exec(startup.toString())[1];
  return { base: "http://127.0.0.1:" + port, stop };
}

test("web preview and JSON API preserve two-stage upload, SVG and retry", async t => {
  const { dir, env } = await fixture(t);
  const { base } = await startWeb(t, dir, env);
  async function post(route, body) {
    return fetch(base + "/api/" + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async function events(route, body) {
    const res = await post(route, body);
    return (await res.text()).trim().split("\n").map(line => JSON.parse(line));
  }

  assert.equal((await fetch(base)).status, 200);
  const form = new FormData();
  form.set("baseIndex", "17");
  form.set("images", new Blob([svg], { type: "image/svg+xml" }), "栈帧.svg");
  const multipart = await fetch(base + "/api/compress", { method: "POST", body: form });
  const rows = (await multipart.text()).trim().split("\n").map(line => JSON.parse(line));
  const ready = rows.find(row => row.type === "compressed");
  assert.equal(ready.index, 17);
  assert.equal(ready.name, "栈帧.svg");
  assert.match(ready.fileId, /\.webp$/);
  assert.equal((await fetch(base + ready.previewUrl)).status, 200);
  await fs.writeFile(env.DENY, "");
  assert.equal((await events("upload-picgo", { fileId: ready.fileId })).at(-1).type, "error");
  assert.equal((await fetch(base + ready.previewUrl)).status, 200);
  await fs.unlink(env.DENY);
  assert.equal((await events("upload-picgo", { fileId: ready.fileId })).at(-1).type, "done");

  const folder = path.join(dir, "pics");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "diagram.svg"), svg);
  const stream = await events("compress-directory", { directory: folder });
  assert.equal(stream.find(row => row.type === "compressed").name, "diagram.svg");
  const prepared = await (await post("cli/compress-directory", { directory: folder })).json();
  assert.match(prepared.items[0].fileId, /\.svg$/);
  const webItem = stream.find(row => row.type === "compressed");
  const cleanup = await post("cleanup", { jobIds: [webItem.fileId.split("/")[0]] });
  assert.equal(cleanup.status, 200);
  assert.equal((await fetch(base + webItem.previewUrl)).status, 404);
  assert.equal((await fetch(base + prepared.items[0].previewUrl)).status, 200);
  assert.equal((await post("cli/upload", { jobId: prepared.jobId })).status, 400);
  const uploaded = await (await post("cli/upload", { confirm: true, jobId: prepared.jobId })).json();
  assert.equal(uploaded.succeeded, 1);
  assert.match(uploaded.urls[0], /\.svg$/);
  const png = path.join(dir, "线稿.png");
  await fs.writeFile(png, await paletteDiagram());
  const kept = await (await post("cli/compress", { files: [png] })).json();
  assert.equal(kept.items[0].keptOriginal, true);
  const pngUpload = await (await post("cli/upload", { confirm: true, jobId: kept.jobId })).json();
  assert.equal(pngUpload.succeeded, 1);
  assert.match(pngUpload.urls[0], /\.png$/);
});

const md5 = (bytes, encoding = "hex") => createHash("md5").update(bytes).digest(encoding);

test("choose actual output bytes, respect oriented bounds, retain vector and animated images", async t => {
  const { dir } = await fixture(t);
  const service = createCompressService({ outputDir: dir });
  async function prepare(bytes, name, options = {}) {
    const source = path.join(dir, name);
    await fs.writeFile(source, bytes);
    const { items: [item] } = await service.compressFilesToJson({ ...options, naming: "hash",
      files: [{ path: source, originalname: name, size: bytes.length }] });
    assert.ok(item.ok, item.error);
    const data = await fs.readFile(path.join(dir, item.fileId));
    assert.equal(item.md5, md5(data));
    assert.equal(item.compressedBytes, data.length);
    return { ...item, data };
  }

  const diagram = await paletteDiagram();
  const full = await prepare(diagram, "线稿.jpg"); // Sniff the content even if the source extension is stale.
  assert.equal(full.keptOriginal, true);
  assert.deepEqual(full.data, diagram);
  assert.equal(full.mimeType, "image/png");
  assert.equal(full.outputName, md5(diagram) + ".png");
  const constrained = await prepare(diagram, "diagram.png", { maxDimension: 127 });
  assert.ok(constrained.compressedBytes > diagram.length);
  assert.deepEqual([constrained.width, constrained.height], [127, 127]);

  const tiny = await sharp({ create: { width: 2, height: 20, channels: 3, background: "white" } }).png({ palette: true }).toBuffer();
  const oriented = await sharp(tiny).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rotated = await prepare(oriented, "exif.jpeg", { maxWidth: 10 });
  assert.deepEqual([rotated.width, rotated.height], [10, 1]);
  const portrait = await prepare(tiny, "portrait.png", { maxDimension: 10, maxWidth: 2 });
  assert.deepEqual([portrait.width, portrait.height], [1, 10]);
  assert.equal(portrait.keptOriginal, false);
  const vector = await prepare(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "vector.svg");
  assert.equal(vector.keptOriginal, true);
  const tiff = await prepare(await sharp(tiny).tiff().toBuffer(), "legacy.tif");
  assert.equal(tiff.mimeType, "image/webp");

  const frames = await Promise.all(["red", "blue"].map(background =>
    sharp({ create: { width: 12, height: 20, channels: 3, background } }).png().toBuffer()));
  for (const format of ["gif", "webp"]) {
    const animation = await sharp(frames, { join: { animated: true } })[format]({ delay: [100, 200], loop: 2 }).toBuffer();
    const original = await prepare(animation, "animation." + format);
    assert.deepEqual(original.data, animation);
    assert.deepEqual([original.width, original.height], [12, 20]);
    const resized = await prepare(animation, "animation." + format, { maxDimension: 10 });
    assert.deepEqual([resized.width, resized.height], [6, 10]);
    const meta = await sharp(resized.data, { animated: true }).metadata();
    assert.equal(meta.pages, 2);
    assert.deepEqual(meta.delay, [100, 200]);
    assert.equal(meta.loop, 2);
  }
});

async function listen(t, handler) {
  const service = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => res.writeHead(500).end(error.message));
  }).listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(() => { service.closeAllConnections(); service.close(); });
  return "http://127.0.0.1:" + service.address().port;
}

async function galleryFixture(t) {
  const { dir, env, run } = await fixture(t);
  const calls = { login: [], prepare: [], put: [], complete: [], proxy: [], patch: [], reads: [] };
  const mode = {};
  const cache = new Map();
  const bytes = Buffer.from(svg.replace("</svg>", "<!--" + "x".repeat(5000) + "--></svg>"));
  const key = "archive/2020/01/02/" + md5(bytes) + ".svg";
  const asset = { key, url: "https://cdn.example/" + key };
  const json = (res, data, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));

  const storage = await listen(t, async (req, res) => {
    if (req.method === "PUT") {
      calls.put.push({ body: await buffer(req), headers: req.headers });
      res.writeHead(200).end();
    } else {
      calls.reads.push(req.headers);
      res.writeHead(200, { "content-type": "image/svg+xml" }).end(bytes);
    }
  });
  env.R2_GALLERY_URL = await listen(t, async (req, res) => {
    if (req.url === "/api/auth/login") {
      const body = JSON.parse(await text(req));
      calls.login.push(body);
      if (body.password !== "test-password") return json(res, {}, 401);
      res.setHeader("set-cookie", "auth-token=test-session; HttpOnly; Path=/");
      return json(res, { success: true });
    }
    if (req.headers.cookie !== "auth-token=test-session") return json(res, { fallback: true }, 403);
    if (req.url === "/api/upload/direct") {
      const body = JSON.parse(await text(req));
      if (body.intent === "prepare") {
        calls.prepare.push(body);
        if (mode.fallback) return json(res, { fallback: true }, 409);
        if (mode.redirect) return res.writeHead(307, { location: storage + "/redirect" }).end();
        if (cache.has(body.contentMd5)) return json(res, { success: true, data: { existing: cache.get(body.contentMd5), duplicate: true } });
        return json(res, { success: true, data: { uploadUrl: storage + "/signed?sig=private-test-signature", ticket: body.contentMd5,
          headers: { "Content-MD5": body.contentMd5, "Content-Type": "image/svg+xml" } } });
      }
      calls.complete.push(body);
      if (mode.completeError) return json(res, { fallback: true }, 500);
      cache.set(body.ticket, asset);
      return json(res, { success: true, data: asset });
    }
    if (req.url === "/api/upload") {
      const form = await new Response(await buffer(req), { headers: { "content-type": req.headers["content-type"] } }).formData();
      const file = form.get("file");
      const data = Buffer.from(await file.arrayBuffer());
      calls.proxy.push({ data, name: file.name, mime: file.type, originalName: form.get("originalName"), hash: form.get("useContentHashName") });
      const digest = md5(data, "base64");
      const duplicate = cache.has(digest);
      cache.set(digest, asset);
      return json(res, { success: true, data: { ...asset, duplicate } });
    }
    if (req.url === "/api/images/metadata" && req.method === "PATCH") {
      calls.patch.push(JSON.parse(await text(req)));
      return json(res, { success: !mode.patchError, data: {} }, mode.patchError ? 500 : 200);
    }
    json(res, {}, 404);
  });
  env.R2_GALLERY_PASSWORD = "test-password";
  await fs.writeFile(path.join(dir, "原图.svg"), bytes);
  await fs.writeFile(path.join(dir, "别名.svg"), bytes);
  return { dir, env, run, calls, bytes, asset, mode, storage };
}

test("gallery direct upload joins occurrences and a later migration reuses the cached object before PUT", async t => {
  const { run, env, calls, bytes, asset, storage } = await galleryFixture(t);
  const images = [{ source: "原图.svg", alt: "入栈", widthPercent: 60, caption: "第一次调用", assetAlt: "栈帧示意", tags: ["JVM"] },
    { source: "别名.svg", alt: "出栈", caption: "返回调用者", sourcePage: "https://example.org/article" }];
  const first = await run(["--input", "-", "--output", "first.json"], JSON.stringify(images));
  assert.equal(first.code, 0, JSON.stringify(first.result));
  const [a, b] = first.result.items;
  assert.deepEqual(calls.login, [{ password: "test-password" }]);
  assert.deepEqual(calls.prepare, [{ intent: "prepare", fileName: "原图.svg", fileSize: bytes.length,
    fileHeader: bytes.subarray(0, 4096).toString("base64"), contentMd5: md5(bytes, "base64"), useContentHashName: true }]);
  assert.equal(calls.put.length, 1);
  assert.deepEqual(calls.put[0].body, bytes);
  assert.equal(calls.put[0].headers["content-md5"], md5(bytes, "base64"));
  assert.equal(calls.put[0].headers.cookie, undefined);
  assert.equal(calls.put[0].headers.authorization, undefined);
  assert.deepEqual(calls.patch, [{ key: asset.key, metadata: { alt: "栈帧示意", tags: ["JVM"] } }]);
  assert.equal(a.key, asset.key);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.url, a.url);
  assert.equal(a.markdown, `![入栈 w-60%](${asset.url} "第一次调用")`);
  assert.equal(b.markdown, `![出栈](${asset.url} "返回调用者")`);
  assert.equal(b.sourcePage, images[1].sourcePage);
  assert.equal(b.originalName, "别名.svg");

  // A separate CLI process with a different source, name and caption asks the gallery again.
  const source = storage + "/chapter-two.svg?v=2";
  const second = await run(["migrate", "--input", "-", "--output", "migrated.json"], JSON.stringify([{ source, caption: "新图注", assetAlt: "另一描述" }]));
  assert.equal(second.code, 0);
  assert.equal(second.result.items[0].source, source);
  assert.equal(second.result.items[0].key, asset.key);
  assert.equal(second.result.items[0].duplicate, true);
  assert.equal(calls.reads[0].cookie, undefined);
  assert.equal(calls.prepare.length, 2);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.proxy.length, 0);
  assert.doesNotMatch(JSON.stringify(first), /test-session|test-password|private-test-signature/);
  assert.equal((await run(["原图.svg", "--prefix", "article"])).code, 2);
  const picgo = await run(["原图.svg", "--backend", "picgo", "--prefix", "article", "--output", "picgo.json"]);
  assert.equal(picgo.code, 0);
  assert.equal(picgo.result.items[0].key, undefined);
  assert.match(await fs.readFile(env.CALLS, "utf8"), /^article-/);
});

test("gallery multipart fallback preserves original name, final format, and duplicate status", async t => {
  const { run, env, mode, calls, bytes } = await galleryFixture(t);
  mode.fallback = true;
  env.R2_GALLERY_TOKEN = "test-session";
  env.R2_GALLERY_PASSWORD = "";
  const args = ["--backend", "gallery", "--output", "result.json"];
  const a = await run(["原图.svg", ...args]);
  const b = await run(["别名.svg", ...args]);
  assert.equal(a.code, 0, JSON.stringify(a.result));
  assert.equal(b.code, 0);
  assert.equal(a.result.items[0].duplicate, false);
  assert.equal(b.result.items[0].duplicate, true);
  assert.equal(calls.login.length, 0);
  assert.equal(calls.put.length, 0);
  assert.equal(calls.proxy.length, 2);
  assert.deepEqual(calls.proxy[0], { data: bytes, originalName: "原图.svg", name: md5(bytes) + ".svg", mime: "image/svg+xml", hash: "true" });
});

test("gallery failures preserve transport boundaries and keep the URL on metadata failure", async t => {
  const { run, env, mode, calls } = await galleryFixture(t);
  const args = ["--input", "-", "--output", "result.json"];
  const manifest = JSON.stringify([{ source: "原图.svg", assetAlt: "素材说明" }]);
  env.R2_GALLERY_TOKEN = "invalid-token";
  let response = await run(args, manifest);
  assert.equal(response.code, 1);
  assert.match(response.result.items[0].error, /403/);
  assert.doesNotMatch(JSON.stringify(response), /invalid-token|test-password/);
  env.R2_GALLERY_TOKEN = "test-session";
  mode.redirect = true;
  response = await run(args, manifest);
  assert.equal(response.code, 1);
  assert.equal(calls.reads.length, 0);
  mode.redirect = false;
  mode.completeError = true;
  response = await run(args, manifest);
  assert.equal(response.code, 1);
  assert.match(response.result.items[0].error, /确认上传/);
  assert.equal(response.result.items[0].url, undefined);
  mode.completeError = false;
  mode.patchError = true;
  response = await run(args, manifest);
  assert.equal(response.code, 1);
  assert.equal(response.result.items[0].ok, true);
  assert.match(response.result.items[0].markdown, /^!\[/);
  assert.match(response.result.items[0].metadataError, /500/);
  assert.equal(calls.proxy.length, 0);
  await assert.rejects(fs.access(env.CALLS));
});

test("gallery web previews preserve the source name on restart and can upload legacy file IDs", async t => {
  const { dir, env, calls, bytes, asset } = await galleryFixture(t);
  const first = await startWeb(t, dir, env);
  assert.equal((await (await fetch(first.base + "/api/health")).json()).backend, "gallery");
  const form = new FormData();
  form.set("images", new Blob([bytes], { type: "image/svg+xml" }), "栈帧.svg");
  const stream = await fetch(first.base + "/api/compress", { method: "POST", body: form });
  const ready = (await stream.text()).trim().split("\n").map(line => JSON.parse(line)).find(row => row.type === "compressed");
  assert.equal(ready.keptOriginal, true);
  assert.equal(ready.outputName, md5(bytes) + ".svg");
  assert.equal(calls.prepare.length, 0);
  assert.deepEqual(Buffer.from(await (await fetch(first.base + ready.previewUrl)).arrayBuffer()), bytes);
  await first.stop();
  const { base } = await startWeb(t, dir, env);
  const upload = async body => (await fetch(base + "/api/cli/upload", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirm: true }) })).json();
  const result = await upload({ jobId: ready.fileId.split("/")[0] });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].key, asset.key);
  assert.equal(calls.prepare[0].fileName, "栈帧.svg");
  assert.equal((await fetch(base + ready.previewUrl)).status, 404);

  const previous = path.join(dir, "previews", "previous");
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, "legacy.svg"), bytes);
  const legacy = await upload({ fileIds: ["previous/legacy.svg"] });
  assert.equal(legacy.items[0].duplicate, true);
  assert.equal(legacy.items[0].url, asset.url);
  assert.equal(calls.prepare[1].fileName, "legacy.svg");
  assert.equal(calls.put.length, 1);
});
