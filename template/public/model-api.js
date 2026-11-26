"use strict";

/**
 * 模特端 API 适配：把原站的 /api/* 与 /img/* 请求翻译成分享令牌对应的服务端快照接口。
 */

(function () {
  const match = location.pathname.match(/^\/m\/([^/]+)/);
  const token = match ? decodeURIComponent(match[1]) : "";
  if (!token) return;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    let url;
    try {
      const raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      url = new URL(raw, location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin === location.origin) {
      const prefix = "/api/shares/" + encodeURIComponent(token);
      if (url.pathname === "/api/photos") return nativeFetch(prefix + "/photos", init);
      if (url.pathname === "/api/selection") return nativeFetch(prefix + "/selection", init);
      if (url.pathname.startsWith("/img/")) {
        const key = decodeURIComponent(url.pathname.slice("/img/".length));
        const name = key.split("/").pop();
        return nativeFetch(prefix + "/img/" + encodeURIComponent(name), init);
      }
    }
    return nativeFetch(input, init);
  };
})();
