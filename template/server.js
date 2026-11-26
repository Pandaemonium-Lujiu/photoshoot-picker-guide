"use strict";

/**
 * 摄影选片工作台 · 服务端
 * 只负责：托管静态页面 + 保存「已发布的模特链接」快照（照片与选片记录）。
 * 管理员自己的照片库保存在浏览器 IndexedDB；这里的数据是发布快照，
 * 实例重启后可能丢失，重新发布即可。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORE_ROOT = path.join(process.env.TMPDIR || "/tmp", "photoshoot-picker-store");
const STORE_SUBDIR = path.join(STORE_ROOT, "shares");

const SHARE_TTL_MS = 30 * 86400000;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 220 * 1024 * 1024;

/** token -> { token, session, title, expiresAt, createdAt, photos: Map<name,{mime,buf}>, selection } */
const shares = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function text(res, status, body) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(buf);
}

function sendFile(res, filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    text(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const isWorker = path.basename(filePath) === "sw.js";
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": ext === ".html" || isWorker ? "no-store" : "public, max-age=300",
    ...(isWorker ? { "Service-Worker-Allowed": "/" } : {}),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求格式错误"), { code: 400 });
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return origin === `${proto}://${host}` || origin === `https://${host}` || origin === `http://${host}`;
}

function cleanSession(value) {
  return String(value || "").replace(/[/\\]/g, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
}

function cleanName(value) {
  const name = String(value || "").replace(/[/\\]/g, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 180);
  if (!name || name === "." || name === "..") return "";
  return name;
}

function shareDir(token) {
  return path.join(STORE_SUBDIR, token);
}

function persistMeta(share) {
  try {
    fs.mkdirSync(shareDir(share.token), { recursive: true });
    const meta = {
      token: share.token,
      session: share.session,
      title: share.title,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      photos: [...share.photos.keys()],
      selection: share.selection
    };
    fs.writeFileSync(path.join(shareDir(share.token), "meta.json"), JSON.stringify(meta));
  } catch (err) {
    console.error("[pick] persist meta failed:", err && err.message);
  }
}

function persistPhoto(share, name, record) {
  try {
    fs.mkdirSync(shareDir(share.token), { recursive: true });
    fs.writeFileSync(path.join(shareDir(share.token), encodeURIComponent(name)), record.buf);
  } catch (err) {
    console.error("[pick] persist photo failed:", err && err.message);
  }
}

function removeShareFiles(token) {
  try {
    fs.rmSync(shareDir(token), { recursive: true, force: true });
  } catch (err) {
    console.error("[pick] remove share files failed:", err && err.message);
  }
}

function loadStore() {
  let tokens = [];
  try {
    tokens = fs.readdirSync(STORE_SUBDIR);
  } catch {
    return;
  }
  for (const token of tokens) {
    try {
      const dir = path.join(STORE_SUBDIR, token);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
      if (!meta || !meta.token) continue;
      const share = {
        token: meta.token,
        session: meta.session,
        title: meta.title || "",
        expiresAt: meta.expiresAt || null,
        createdAt: meta.createdAt || nowIso(),
        photos: new Map(),
        selection: meta.selection || null
      };
      for (const name of meta.photos || []) {
        try {
          const buf = fs.readFileSync(path.join(dir, encodeURIComponent(name)));
          share.photos.set(name, { mime: /\.png$/i.test(name) ? "image/png" : "image/jpeg", buf });
        } catch {}
      }
      shares.set(share.token, share);
    } catch {}
  }
  if (shares.size) console.log(`[pick] restored ${shares.size} share(s) from disk`);
}

function totalStoredBytes() {
  let total = 0;
  for (const share of shares.values()) {
    for (const photo of share.photos.values()) total += photo.buf.length;
  }
  return total;
}

function activeShare(token) {
  const share = shares.get(token);
  if (!share) return null;
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) return null;
  return share;
}

function shareInfo(share) {
  return {
    ok: true,
    token: share.token,
    session: share.session,
    title: share.title,
    url: "/m/" + share.token,
    expires_at: share.expiresAt,
    permanent: !share.expiresAt,
    created_at: share.createdAt,
    photoCount: share.photos.size,
    photos: [...share.photos.keys()]
  };
}

async function handleApi(req, res, segments, url) {
  const method = req.method || "GET";
  const write = method === "POST" || method === "PUT" || method === "DELETE";

  if (write && !sameOrigin(req)) {
    json(res, 403, { error: "请求来源无效" });
    return true;
  }

  // POST /api/shares —— 创建分享
  if (segments.length === 2 && segments[1] === "shares" && method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      json(res, err.code || 400, { error: err.message });
      return true;
    }
    const session = cleanSession(body.session);
    if (!session) {
      json(res, 400, { error: "缺少场次" });
      return true;
    }
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = body.permanent === true ? null : new Date(Date.now() + SHARE_TTL_MS).toISOString();
    const share = {
      token,
      session,
      title: String(body.title || "").slice(0, 100),
      expiresAt,
      createdAt: nowIso(),
      photos: new Map(),
      selection: null
    };
    shares.set(token, share);
    persistMeta(share);
    json(res, 200, {
      ok: true,
      token,
      url: "/m/" + token,
      session,
      expires_at: expiresAt,
      permanent: expiresAt === null
    });
    return true;
  }

  if (segments.length < 3 || segments[1] !== "shares") return false;

  const token = String(segments[2] || "");
  const share = shares.get(token);
  if (!share) {
    json(res, 404, { error: "链接不存在或已失效" });
    return true;
  }

  // GET /api/shares/:token —— 元信息（管理端探测链接是否还在）
  if (segments.length === 3 && method === "GET") {
    json(res, 200, shareInfo(share));
    return true;
  }

  if (activeShare(token) === null && segments.length === 3) {
    json(res, 410, { error: "链接已过期" });
    return true;
  }

  // GET /api/shares/:token/photos —— 模特端照片 key 列表
  if (segments.length === 4 && segments[3] === "photos" && method === "GET") {
    if (!activeShare(token)) {
      json(res, 404, { error: "链接无效或已过期" });
      return true;
    }
    json(res, 200, [...share.photos.keys()].sort().map((name) => share.session + "/" + name));
    return true;
  }

  // PUT /api/shares/:token/photos?name=xxx —— 上传一张快照
  if (segments.length === 4 && segments[3] === "photos" && method === "PUT") {
    const name = cleanName(url.searchParams.get("name"));
    if (!name) {
      json(res, 400, { error: "缺少文件名" });
      return true;
    }
    let buf;
    try {
      buf = await readBody(req, MAX_IMAGE_BYTES);
    } catch (err) {
      json(res, err.code || 400, { error: err.message });
      return true;
    }
    if (!buf.length) {
      json(res, 400, { error: "空文件" });
      return true;
    }
    if (totalStoredBytes() + buf.length > MAX_TOTAL_BYTES) {
      json(res, 507, { error: "服务端快照空间已满，请稍后重试", code: "STORAGE_FULL" });
      return true;
    }
    const mime = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
    const record = { mime, buf };
    share.photos.set(name, record);
    persistPhoto(share, name, record);
    persistMeta(share);
    json(res, 200, { ok: true, name, size: buf.length });
    return true;
  }

  // GET /api/shares/:token/img/:name —— 图片内容
  if (segments.length === 5 && segments[3] === "img" && method === "GET") {
    if (!activeShare(token)) {
      json(res, 404, { error: "链接无效或已过期" });
      return true;
    }
    const name = segments[4];
    const photo = share.photos.get(name);
    if (!photo) {
      text(res, 404, "Not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": photo.mime,
      "Content-Length": photo.buf.length,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(photo.buf);
    return true;
  }

  // GET/POST /api/shares/:token/selection —— 模特选片记录
  if (segments.length === 4 && segments[3] === "selection") {
    if (!activeShare(token)) {
      json(res, 404, { error: "链接无效或已过期" });
      return true;
    }
    if (method === "GET") {
      const record = share.selection;
      json(res, 200, {
        filenames: record ? record.filenames : [],
        status: record ? record.status : "draft"
      });
      return true;
    }
    if (method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        json(res, err.code || 400, { error: err.message });
        return true;
      }
      const status = body.status === "confirmed" ? "confirmed" : "draft";
      const filenames = Array.isArray(body.filenames)
        ? body.filenames.map((f) => String(f).slice(0, 200)).slice(0, 5000)
        : [];
      if (status === "confirmed" && !filenames.length) {
        json(res, 400, { error: "一张都没选，无法确认" });
        return true;
      }
      share.selection = { filenames, status, updatedAt: nowIso() };
      persistMeta(share);
      json(res, 200, { ok: true, count: filenames.length, session: share.session, status });
      return true;
    }
  }

  // GET /api/shares/:token/results —— 管理端查看该链接的提交
  if (segments.length === 4 && segments[3] === "results" && method === "GET") {
    const record = share.selection;
    json(res, 200, record ? [{
      token,
      tokenShort: "链接 " + token.slice(0, 8),
      session: share.session,
      status: record.status,
      count: record.filenames.length,
      filenames: record.filenames,
      updated_at: record.updatedAt,
      share_created: share.createdAt
    }] : []);
    return true;
  }

  // POST /api/shares/:token/permanent
  if (segments.length === 4 && segments[3] === "permanent" && method === "POST") {
    share.expiresAt = null;
    persistMeta(share);
    json(res, 200, { ok: true, permanent: true });
    return true;
  }

  // POST /api/shares/:token/delete
  if (segments.length === 4 && segments[3] === "delete" && method === "POST") {
    shares.delete(token);
    removeShareFiles(token);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

    if (pathname === "/api/health") {
      json(res, 200, { ok: true, shares: shares.size, bytes: totalStoredBytes() });
      return;
    }

    if (segments[0] === "api") {
      const handled = await handleApi(req, res, segments, url);
      if (!handled) json(res, 404, { error: "Not found" });
      return;
    }

    // 模特链接
    if (segments[0] === "m" && segments.length >= 2) {
      if (!activeShare(segments[1])) {
        text(res, 404, "链接无效或已过期，请联系摄影师重新获取。");
        return;
      }
      sendFile(res, path.join(PUBLIC_DIR, "model.html"));
      return;
    }

    if (pathname === "/") {
      sendFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }

    const allow = new Set(["/index.html", "/model.html", "/auth.js", "/local-api.js", "/model-api.js", "/sw.js"]);
    if (allow.has(pathname)) {
      sendFile(res, path.join(PUBLIC_DIR, pathname.slice(1)));
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    text(res, 404, "Not found");
  } catch (err) {
    console.error("[pick] request failed:", err && err.message);
    if (!res.headersSent) json(res, 500, { error: "服务内部错误" });
    else res.end();
  }
});

server.on("error", (err) => {
  console.error("[pick] server error:", err && err.message);
  process.exit(1);
});

loadStore();
server.listen(PORT, HOST, () => {
  console.log(`[pick] listening on http://${HOST}:${PORT}`);
});
