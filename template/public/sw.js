"use strict";

/**
 * Service Worker：把管理员页面里 <img src="/img/<key>"> 的请求，
 * 直接由浏览器 IndexedDB 中的照片 Blob 响应，照片不经过网络。
 */

const DB_NAME = "pick-local";
const DB_VERSION = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function openDb() {
  return new Promise((resolve, reject) => {
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
    request.onerror = () => reject(request.error || new Error("SW db open failed"));
  });
}

async function readPhoto(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("photos", "readonly").objectStore("photos").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

self.addEventListener("fetch", (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/img/")) return;
  const key = decodeURIComponent(url.pathname.slice("/img/".length));
  event.respondWith((async () => {
    try {
      const record = await readPhoto(key);
      if (!record || !record.blob) return new Response("Not found", { status: 404 });
      return new Response(record.blob, {
        status: 200,
        headers: {
          "Content-Type": record.mime || "image/jpeg",
          "Cache-Control": "no-store"
        }
      });
    } catch {
      return new Response("Service worker error", { status: 500 });
    }
  })());
});
