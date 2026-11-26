# 模板：摄影选片平台

这是教程配套的**可运行模板**，零第三方依赖。

## 运行

```bash
npm start
# → http://localhost:8000
```

首次打开会让设置管理员密码（PBKDF2 哈希只存本机）。

## 使用顺序

1. 输入场次名（如 `2026-11-26 人像`）
2. 把 JPG 拖进上传区（自动压到长边 1600 / ≤900KB）
3. 勾选照片 → 「暂存」或「✓ 确认选片」
4. 「🔗 模特链接」→ 生成 → 复制 `/m/<token>` 发给模特
5. 模特提交后，在「📋 选片结果」复制文件名或 AI 整理提示词

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.js` | HTTP 服务：静态页、分享快照、模特选片接口 |
| `public/index.html` | 管理员控制台（含两套皮肤） |
| `public/model.html` | 模特选片页 |
| `public/auth.js` | 首次设密码 / 登录 / 改密码 |
| `public/local-api.js` | 管理员端：把 `/api/*` 接到 IndexedDB |
| `public/model-api.js` | 模特端：把 `/api/*` 接到服务端快照 |
| `public/sw.js` | Service Worker：`/img/*` 从 IndexedDB 出图 |

## 常用改法

- 标题与文案：两个 HTML 里的 `<title>`、`<h1>`
- 配色：HTML 顶部 `:root` 的 CSS 变量
- 分享有效期：`server.js` 的 `SHARE_TTL_MS`
- 单张大小：`server.js` 的 `MAX_IMAGE_BYTES`、`local-api.js` 里的 900KB 判断
- 端口：环境变量 `PORT`（默认 8000）

## 部署

保持"单进程、监听 `PORT`、绑定 `0.0.0.0`"即可部署到任意 Node 20 平台。
完整步骤（含 build.sh / run.sh / 执行配置）见 [../docs/06-部署上线.md](../docs/06-部署上线.md)。

## 注意

- 照片库在浏览器 IndexedDB：换设备/换域名看不到
- 服务端链接快照是临时的：实例重启后需重新生成
- 密码不可找回，忘记只能清除本站 localStorage 后重设
