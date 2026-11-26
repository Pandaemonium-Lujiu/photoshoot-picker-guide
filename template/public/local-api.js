"use strict";

/**
 * 管理端本地数据层
 * 拦截页面原有的 /api/* 与 /img/* 请求，把照片与选片记录改存到浏览器 IndexedDB：
 *   - 照片不会离开本机，刷新、关浏览器都还在
 *   - 生成模特链接时，才把该场次的压缩预览图上传到服务器做临时快照
 */

(function () {
  const DB_NAME = "pick-local";
  const DB_VERSION = 1;
  const nativeFetch = window.fetch.bind(window);
  let dbPromise = null;

  // 让 /img/<key> 的图片请求由 Service Worker 从 IndexedDB 直出
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        if (navigator.serviceWorker.controller) {
          try { sessionStorage.removeItem("pick.sw.reload"); } catch {}
          return;
        }
        try {
          if (sessionStorage.getItem("pick.sw.reload")) return;
          sessionStorage.setItem("pick.sw.reload", "1");
        } catch {}
        location.reload();
      })
      .catch(() => {});
  }

  /* ---------- IndexedDB ---------- */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("photos")) {
          const store = db.createObjectStore("photos", { keyPath: "key" });
          store.createIndex("session", "session", { unique: false });
        }
        if (!db.objectStoreNames.contains("selections")) {
          db.createObjectStore("selections", { keyPath: "session" });
        }
        if (!db.objectStoreNames.contains("shares")) {
          const store = db.createObjectStore("shares", { keyPath: "token" });
          store.createIndex("session", "session", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
    });
    return dbPromise;
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本地数据库操作失败"));
    });
  }

  async function dbGet(store, key) {
    const db = await openDb();
    return wrap(db.transaction(store, "readonly").objectStore(store).get(key));
  }

  async function dbAll(store) {
    const db = await openDb();
    return wrap(db.transaction(store, "readonly").objectStore(store).getAll());
  }

  async function dbByIndex(store, index, value) {
    const db = await openDb();
    const tx = db.transaction(store, "readonly");
    return wrap(tx.objectStore(store).index(index).getAll(value));
  }

  async function dbPut(store, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("本地数据库写入失败"));
      tx.onabort = () => reject(tx.error || new Error("本地数据库写入被中止"));
    });
  }

  async function dbDelete(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("本地数据库删除失败"));
    });
  }

  /* ---------- 工具 ---------- */

  function cleanSession(value) {
    return String(value || "").replace(/[/\\]/g, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  }

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  function setStatus(text) {
    const el = document.querySelector("#status");
    if (el) el.textContent = text;
  }

  function fmtBytes(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }

  async function readJson(init) {
    const body = init && init.body;
    if (!body) return {};
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        throw new Error("请求格式错误");
      }
    }
    return {};
  }

  function base(key) {
    return String(key).split("/").pop();
  }

  /* ---------- 业务实现 ---------- */

  async function listSessions() {
    const sessions = new Set();
    for (const photo of await dbAll("photos")) if (photo.session) sessions.add(photo.session);
    for (const record of await dbAll("selections")) if (record.session) sessions.add(record.session);
    for (const share of await dbAll("shares")) if (share.session) sessions.add(share.session);
    return [...sessions].sort();
  }

  async function listPhotos(session) {
    if (!session) return [];
    const rows = await dbByIndex("photos", "session", session);
    return rows.map((row) => row.key).sort();
  }

  async function getPhotoResponse(key) {
    const record = await dbGet("photos", key);
    if (!record) return new Response("Not found", { status: 404 });
    return new Response(record.blob, {
      status: 200,
      headers: {
        "Content-Type": record.mime || "image/jpeg",
        "Cache-Control": "private, max-age=86400"
      }
    });
  }

  async function uploadPhoto(url, init) {
    const key = url.searchParams.get("obj") || "";
    if (!key) return jsonResponse({ error: "缺少 obj 参数" }, 400);
    if (!/\.(jpe?g|png)$/i.test(key)) return jsonResponse({ error: "只支持 JPG/PNG" }, 400);
    const overwrite = url.searchParams.get("overwrite") === "1";
    const existing = await dbGet("photos", key);
    if (existing && !overwrite) {
      return jsonResponse({ ok: true, key, skipped: true, reason: "duplicate" });
    }
    const blob = init && init.body;
    if (!(blob instanceof Blob) || !blob.size) return jsonResponse({ error: "空文件" }, 400);
    if (blob.size > 900 * 1024) {
      return jsonResponse({ error: "单张超过 900KB，请导出长边 1600px 左右的预览图" }, 413);
    }
    const parts = key.split("/");
    const session = parts[0];
    const name = parts.slice(1).join("/");
    if (!session || !name) return jsonResponse({ error: "key 含非法字符" }, 400);
    try {
      await dbPut("photos", {
        key,
        session,
        name,
        mime: blob.type || (/\.png$/i.test(key) ? "image/png" : "image/jpeg"),
        size: blob.size,
        blob,
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      if (err && (err.name === "QuotaExceededError" || /quota/i.test(String(err.message)))) {
        return jsonResponse({ error: "本机浏览器存储空间不足，请清理后重试", code: "STORAGE_FULL" }, 507);
      }
      throw err;
    }
    return jsonResponse({ ok: true, key, size: blob.size, skipped: false, replaced: overwrite && !!existing });
  }

  async function getSelection(session) {
    const record = session ? await dbGet("selections", session) : null;
    return jsonResponse({
      filenames: record ? record.filenames : [],
      status: record ? record.status : "draft"
    });
  }

  async function saveSelection(init) {
    const body = await readJson(init);
    const session = cleanSession(body.session);
    const status = body.status === "confirmed" ? "confirmed" : "draft";
    const filenames = Array.isArray(body.filenames)
      ? body.filenames.map((name) => String(name).slice(0, 200)).slice(0, 5000)
      : [];
    if (!session) return jsonResponse({ error: "身份或场次缺失" }, 400);
    if (status === "confirmed" && !filenames.length) {
      return jsonResponse({ error: "一张都没选，无法确认" }, 400);
    }
    await dbPut("selections", { session, filenames, status, updatedAt: new Date().toISOString() });
    return jsonResponse({ ok: true, count: filenames.length, session, status });
  }

  async function getStats(url) {
    const photos = await dbAll("photos");
    const shares = await dbAll("shares");
    const selections = await dbAll("selections");
    const session = cleanSession(url.searchParams.get("session") || "");
    if (session) {
      const own = photos.filter((photo) => photo.session === session);
      return jsonResponse({
        photoCount: own.length,
        photoBytes: own.reduce((sum, photo) => sum + Number(photo.size || 0), 0),
        selectionCount: selections.filter((record) => record.session === session).length,
        shareCount: shares.filter((share) => share.session === session).length
      });
    }
    let quota = 0;
    try {
      const estimate = await navigator.storage.estimate();
      quota = Number(estimate.quota || 0);
    } catch {}
    const bytes = photos.reduce((sum, photo) => sum + Number(photo.size || 0), 0);
    return jsonResponse({
      photoCount: photos.length,
      photoBytes: bytes,
      sessionCount: new Set(photos.map((photo) => photo.session)).size,
      selectionCount: selections.length + shares.length,
      shareCount: shares.length,
      quotaBytes: quota,
      databases: [{ name: "本机照片库", photoBytes: bytes, limitBytes: quota || 0 }]
    });
  }

  async function deleteSession(init) {
    const body = await readJson(init);
    const session = cleanSession(body.session);
    const purge = body.purge !== false;
    if (!session) return jsonResponse({ error: "缺少场次" }, 400);
    const photos = await dbByIndex("photos", "session", session);
    for (const photo of photos) await dbDelete("photos", photo.key);
    let selections = 0;
    let shares = 0;
    if (purge) {
      if (await dbGet("selections", session)) {
        await dbDelete("selections", session);
        selections = 1;
      }
      const own = await dbByIndex("shares", "session", session);
      for (const share of own) {
        try {
          await nativeFetch("/api/shares/" + encodeURIComponent(share.token) + "/delete", { method: "POST" });
        } catch {}
        await dbDelete("shares", share.token);
        shares++;
      }
    }
    return jsonResponse({
      ok: true,
      photos: photos.length,
      bytes: photos.reduce((sum, photo) => sum + Number(photo.size || 0), 0),
      selections,
      shares
    });
  }

  async function changePassword(init) {
    const body = await readJson(init);
    if (!window.PickAuth) return jsonResponse({ error: "认证模块未加载" }, 500);
    if (!(await window.PickAuth.verifyPassword(body.current || ""))) {
      return jsonResponse({ error: "当前密码不正确" }, 401);
    }
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 512) {
      return jsonResponse({ error: "新密码须为 8 至 512 个字符" }, 400);
    }
    await window.PickAuth.writeAuth(body.password);
    return jsonResponse({ ok: true });
  }

  async function listShares(url) {
    const session = cleanSession(url.searchParams.get("session") || "");
    let list = await dbAll("shares");
    if (session) list = list.filter((share) => share.session === session);
    list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const now = Date.now();
    const result = [];
    for (const share of list) {
      let alive = true;
      try {
        const response = await nativeFetch("/api/shares/" + encodeURIComponent(share.token), { cache: "no-store" });
        alive = response.ok;
      } catch {
        alive = false;
      }
      result.push({
        token: share.token,
        session: share.session,
        title: share.title || "",
        url: "/m/" + share.token,
        expires_at: share.expiresAt || null,
        permanent: !share.expiresAt,
        expired: !alive || (!!share.expiresAt && new Date(share.expiresAt).getTime() < now),
        created_at: share.createdAt
      });
    }
    return jsonResponse(result);
  }

  async function publishShare(init) {
    const body = await readJson(init);
    const session = cleanSession(body.session);
    if (!session) return jsonResponse({ error: "缺少场次" }, 400);
    const photos = (await dbByIndex("photos", "session", session))
      .filter((photo) => photo.blob)
      .sort((a, b) => a.key.localeCompare(b.key));
    if (!photos.length) {
      return jsonResponse({ error: "这个场次还没有照片，先上传后再生成链接" }, 400);
    }
    const total = photos.reduce((sum, photo) => sum + Number(photo.size || 0), 0);
    if (total > 30 * 1024 * 1024) {
      return jsonResponse({ error: "本场照片约 " + fmtBytes(total) + "，超过单次发布上限 30MB，请分批发布" }, 413);
    }

    setStatus("正在创建模特链接…");
    const created = await nativeFetch("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, permanent: !!body.permanent })
    });
    const info = await created.json().catch(() => ({}));
    if (!created.ok || !info.token) {
      return jsonResponse({ error: info.error || "创建链接失败，请稍后重试" }, created.status || 500);
    }

    let done = 0;
    const queue = photos.slice();
    const worker = async () => {
      while (queue.length) {
        const photo = queue.shift();
        const response = await nativeFetch(
          "/api/shares/" + info.token + "/photos?name=" + encodeURIComponent(photo.name),
          { method: "PUT", headers: { "Content-Type": photo.mime || "image/jpeg" }, body: photo.blob }
        );
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || "预览图上传失败（HTTP " + response.status + "）");
        }
        done++;
        setStatus("正在发布预览图 " + done + "/" + photos.length + "…");
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
    } catch (err) {
      try {
        await nativeFetch("/api/shares/" + info.token + "/delete", { method: "POST" });
      } catch {}
      return jsonResponse({ error: err.message || "发布失败，请稍后重试" }, 502);
    }

    await dbPut("shares", {
      token: info.token,
      session,
      title: "",
      expiresAt: info.expires_at || null,
      permanent: !!info.permanent,
      createdAt: new Date().toISOString(),
      url: "/m/" + info.token
    });
    setStatus("模特链接已生成 · 共 " + photos.length + " 张");
    return jsonResponse({
      ok: true,
      token: info.token,
      url: "/m/" + info.token,
      session,
      expires_at: info.expires_at || null,
      permanent: !!info.permanent
    });
  }

  async function setSharePermanent(init) {
    const body = await readJson(init);
    const token = String(body.token || "");
    if (!token) return jsonResponse({ error: "缺少 token" }, 400);
    const response = await nativeFetch("/api/shares/" + encodeURIComponent(token) + "/permanent", { method: "POST" });
    if (!response.ok) return jsonResponse({ error: "设置失败，链接可能已失效" }, response.status);
    const record = await dbGet("shares", token);
    if (record) {
      record.expiresAt = null;
      record.permanent = true;
      await dbPut("shares", record);
    }
    return jsonResponse({ ok: true, permanent: true });
  }

  async function deleteShare(init) {
    const body = await readJson(init);
    const token = String(body.token || "");
    if (!token) return jsonResponse({ error: "缺少 token" }, 400);
    try {
      await nativeFetch("/api/shares/" + encodeURIComponent(token) + "/delete", { method: "POST" });
    } catch {}
    await dbDelete("shares", token);
    return jsonResponse({ ok: true });
  }

  async function getSelections(url) {
    const session = cleanSession(url.searchParams.get("session") || "");
    if (!session) return jsonResponse({ error: "缺少场次" }, 400);
    const results = [];
    const local = await dbGet("selections", session);
    if (local) {
      results.push({
        token: "admin",
        tokenShort: "管理员",
        status: local.status,
        count: local.filenames.length,
        filenames: local.filenames,
        updated_at: local.updatedAt,
        share_created: null
      });
    }
    for (const share of await dbByIndex("shares", "session", session)) {
      try {
        const response = await nativeFetch("/api/shares/" + encodeURIComponent(share.token) + "/results", { cache: "no-store" });
        if (!response.ok) continue;
        const items = await response.json();
        if (Array.isArray(items)) results.push(...items);
      } catch {}
    }
    results.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return jsonResponse(results);
  }

  async function getNotifications(url) {
    const rawSince = url.searchParams.get("since") || "";
    const since = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/.test(rawSince)
      ? rawSince
      : new Date(Date.now() - 600000).toISOString();
    const items = [];
    for (const share of await dbAll("shares")) {
      try {
        const response = await nativeFetch(
          "/api/shares/" + encodeURIComponent(share.token) + "/results",
          { cache: "no-store" }
        );
        if (!response.ok) continue;
        const records = await response.json();
        for (const record of Array.isArray(records) ? records : []) {
          if (record.status !== "confirmed") continue;
          if (String(record.updated_at || "") <= since) continue;
          items.push({
            token: record.token,
            tokenShort: record.tokenShort || "链接 " + String(record.token).slice(0, 8),
            session: record.session || share.session,
            count: Number(record.count || 0),
            updated_at: record.updated_at
          });
        }
      } catch {}
    }
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return jsonResponse({
      serverTime: new Date().toISOString(),
      since,
      items: items.slice(0, 20)
    });
  }

  /* ---------- 路由 ---------- */

  async function route(url, method, init) {
    const path = url.pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/img/")) return null;

    if (path === "/api/sessions" && method === "GET") return jsonResponse(await listSessions());
    if (path === "/api/photos" && method === "GET") {
      return jsonResponse(await listPhotos(cleanSession(url.searchParams.get("session") || "")));
    }
    if (path.startsWith("/img/") && method === "GET") {
      const key = decodeURIComponent(path.slice("/img/".length));
      return getPhotoResponse(key);
    }
    if (path === "/api/upload" && method === "PUT") return uploadPhoto(url, init);
    if (path === "/api/selection" && method === "GET") {
      return getSelection(cleanSession(url.searchParams.get("session") || ""));
    }
    if (path === "/api/selection" && method === "POST") return saveSelection(init);
    if (path === "/api/stats" && method === "GET") return getStats(url);
    if (path === "/api/sessions/delete" && method === "POST") return deleteSession(init);
    if (path === "/api/password" && method === "POST") return changePassword(init);
    if (path === "/api/shares" && method === "GET") return listShares(url);
    if (path === "/api/shares" && method === "POST") return publishShare(init);
    if (path === "/api/shares/permanent" && method === "POST") return setSharePermanent(init);
    if (path === "/api/shares/delete" && method === "POST") return deleteShare(init);
    if (path === "/api/selections" && method === "GET") return getSelections(url);
    if (path === "/api/notifications" && method === "GET") return getNotifications(url);
    return null;
  }

  window.fetch = async function (input, init) {
    let url;
    try {
      const raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      url = new URL(raw, location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin !== location.origin) return nativeFetch(input, init);
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    try {
      const handled = await route(url, method, init);
      if (handled) return handled;
    } catch (err) {
      return jsonResponse({ error: (err && err.message) || "本地存储操作失败" }, 500);
    }
    return nativeFetch(input, init);
  };

  // 供页面工具函数使用（保持与原站一致的 key 语义）
  window.PickLocal = { base };
})();
