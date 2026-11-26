"use strict";

/**
 * 本地管理员密码闸门
 * 首次打开：设置密码；之后：验证密码。
 * 密码只以 PBKDF2-SHA256 加盐哈希保存在本浏览器 localStorage，不存明文、不上传服务器。
 */

(function () {
  const AUTH_KEY = "pick.auth.v1";
  const SESSION_KEY = "pick.auth.session";
  const SESSION_TTL = 30 * 86400000;
  const ITERATIONS = 150000;
  const enc = new TextEncoder();

  function b64url(bytes) {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(value) {
    const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function equal(left, right) {
    if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
  }

  async function hashPassword(password, saltB64, iterations) {
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromB64url(saltB64), iterations: iterations || ITERATIONS },
      key,
      256
    );
    return b64url(new Uint8Array(bits));
  }

  function readAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.salt || !data.hash) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeAuth(password) {
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    return hashPassword(password, salt).then((hash) => {
      localStorage.setItem(AUTH_KEY, JSON.stringify({
        v: 1,
        alg: "PBKDF2-SHA256",
        iter: ITERATIONS,
        salt,
        hash,
        createdAt: new Date().toISOString()
      }));
    });
  }

  async function verifyPassword(password) {
    const auth = readAuth();
    if (!auth) return false;
    const hash = await hashPassword(password, auth.salt, auth.iter);
    return equal(hash, auth.hash);
  }

  function sessionValid() {
    try {
      const data = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      return !!data && Number(data.expires) > Date.now();
    } catch {
      return false;
    }
  }

  function openSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ expires: Date.now() + SESSION_TTL }));
  }

  function closeSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function unlock() {
    document.body.classList.remove("auth-locked");
    const gate = document.getElementById("authGate");
    if (gate) gate.remove();
  }

  const CSS = `
  body.auth-locked{overflow:hidden}
  body.auth-locked > *:not(#authGate){display:none!important}
  #authGate{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:24px;
    background:#0B0817;color:#F7F3FF;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
    background-image:linear-gradient(#AE6BFF0D 1px,transparent 1px),linear-gradient(90deg,#AE6BFF0D 1px,transparent 1px);
    background-size:24px 24px}
  #authGate .ac-card{width:min(100%,420px);padding:28px;background:#141025;border:1px solid #6D3AA2;border-radius:14px;box-shadow:0 0 28px #AE6BFF20}
  #authGate .ac-eyebrow{font-size:11px;letter-spacing:.18em;color:#8F83AA}
  #authGate h1{margin:10px 0 6px;font-size:23px;color:#AE6BFF;font-weight:700}
  #authGate p{margin:0 0 20px;color:#B7AFCB;font-size:14px;line-height:1.7}
  #authGate label{display:block;margin-bottom:7px;font-size:13px;color:#B7AFCB}
  #authGate input{width:100%;height:46px;padding:0 12px;border-radius:7px;border:1px solid #40315B;background:#1C1534;color:#F7F3FF;font:inherit}
  #authGate input:focus{outline:2px solid #AE6BFF;outline-offset:2px}
  #authGate .ac-field{margin-bottom:14px}
  #authGate .ac-error{min-height:22px;margin:8px 0 4px;color:#FF6879;font-size:13px}
  #authGate button{width:100%;height:46px;border:0;border-radius:8px;background:#B7FF45;color:#0B0817;font:inherit;font-weight:700;cursor:pointer}
  #authGate button:hover{background:#CBFF80}
  #authGate button:disabled{opacity:.5;cursor:default}
  #authGate .ac-foot{margin-top:16px;color:#8F83AA;font-size:12px;text-align:center;line-height:1.6}
  `;

  function render() {
    const hasCredential = !!readAuth();
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const gate = document.createElement("div");
    gate.id = "authGate";
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-modal", "true");
    gate.innerHTML = `
      <main class="ac-card">
        <div class="ac-eyebrow">ALBUM CONTROL · UNIT-01</div>
        <h1>摄影选片工作台</h1>
        <p id="acHint">${hasCredential
          ? "输入管理员密码。此浏览器登录后可保持 30 天。"
          : "初次使用，请设置管理员密码。密码只以哈希保存在本浏览器，不会上传。"}</p>
        <form id="acForm" novalidate>
          <div class="ac-field">
            <label for="acKey">管理员密码</label>
            <input id="acKey" name="key" type="password" autocomplete="${hasCredential ? "current-password" : "new-password"}" maxlength="512" required autofocus>
          </div>
          <div class="ac-field" id="acConfirmWrap" ${hasCredential ? "hidden" : ""}>
            <label for="acKey2">再次输入密码</label>
            <input id="acKey2" type="password" autocomplete="new-password" maxlength="512">
          </div>
          <div class="ac-error" id="acError" role="alert"></div>
          <button type="submit" id="acSubmit">${hasCredential ? "验证并打开工作台" : "设置密码并进入工作台"}</button>
        </form>
        <div class="ac-foot">${hasCredential
          ? "仅在可信任的个人设备上保持登录"
          : "至少 8 位 · 忘记密码无法找回，但照片仍保存在本浏览器"}</div>
      </main>`;
    document.body.appendChild(gate);

    const form = gate.querySelector("#acForm");
    const input = gate.querySelector("#acKey");
    const confirm = gate.querySelector("#acKey2");
    const error = gate.querySelector("#acError");
    const submit = gate.querySelector("#acSubmit");

    form.onsubmit = async (event) => {
      event.preventDefault();
      error.textContent = "";
      const password = input.value;
      if (!hasCredential && password.length < 8) {
        error.textContent = "密码至少 8 位";
        return;
      }
      if (!hasCredential && password !== confirm.value) {
        error.textContent = "两次输入的密码不一致";
        return;
      }
      submit.disabled = true;
      try {
        if (hasCredential) {
          if (!(await verifyPassword(password))) {
            error.textContent = "密码不正确，请重试。";
            submit.disabled = false;
            return;
          }
        } else {
          await writeAuth(password);
        }
        openSession();
        unlock();
      } catch (err) {
        error.textContent = "无法完成验证，请刷新页面后重试。";
        submit.disabled = false;
      }
    };

    input.focus();
  }

  window.PickAuth = { verifyPassword, writeAuth, readAuth, sessionValid, closeSession, hashPassword, equal };

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      closeSession();
      location.reload();
    });
  }

  if (sessionValid()) unlock();
  else render();
})();
