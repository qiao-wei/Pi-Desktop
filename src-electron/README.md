# src-electron — Pi Desktop 的 Electron 外壳

与 `src-tauri` 平级的第二个桌面外壳。同样是**薄壳**：只负责建窗口、拉起 sidecar、把 7 个原生能力
桥接给渲染进程；业务逻辑仍然全在 `server/index.mjs`（bun sidecar）+ `src/`（React）。

## 文件

| 文件 | 对应 src-tauri | 作用 |
| --- | --- | --- |
| `main.js` | `lib.rs::run` | 窗口配置、生命周期、生产模式启停 sidecar |
| `preload.js` | Tauri IPC 层 | 用 `contextBridge` 暴露 `window.__TAURI_INTERNALS__.invoke` |
| `host-commands.js` | `#[tauri::command]` × 7 | `ipcMain.handle` 实现同名命令 |
| `host-policy.js` | `is_openable_target` / `dialog_starting_directory` | 纯函数策略（有单测，不依赖 electron） |
| `sidecar.js` | `start_bridge` / `stop_bridge` | 复刻同一套环境变量与内置 runtime 定位 |
| `paths.js` | `BaseDirectory::Resource` 解析 | dev / 打包两种资源布局 |
| `static-server.js` | Tauri 的自定义协议 | 生产模式用自定义协议把 `dist/` 伺服到固定源 `app://pi-desktop/` |
| `../scripts/dev-electron.mjs` | `build.beforeDevCommand` + `devUrl` | 起 dev 服务（bridge + vite）并挂上外壳 |
| `electron-builder.json` | `tauri.conf.json` 的 `bundle` | 打包配置 |

## 运行

```bash
npm install                      # 装 electron / electron-builder
npm run electron:dev             # 自动起 bridge(6474) + vite(5176)，再挂上外壳
```

和 Tauri 的 `beforeDevCommand: npm run dev` + `devUrl` 等价。5176 已经有服务在跑时只做“接上”，
不会重复起一套；想手动控制：先 `npm run dev`，再 `npm run electron:dev`。

- `PI_DESKTOP_DEV_URL`：外壳连的地址（默认 `http://127.0.0.1:5176`）。
- `PI_DESKTOP_ELECTRON_ARGS="--remote-debugging-port=9223"`：给外壳传 Chromium/Electron 启动参数。
- dev 模式外壳**不**启动 sidecar（和 Tauri 的 `#[cfg(debug_assertions)]` 一致），bridge 由 dev 脚本持有。
- dev 模式外壳使用**独立 userData 目录** `~/Library/Application Support/Pi Desktop Dev`（打包版是 `.../Pi Desktop`）。
  两个 Chromium 进程共用同一目录时会抢 `Local Storage/leveldb` 的 LOCK：后启动的那个进程
  `localStorage` 写入只留在内存，退出即丢——表现就是「主题 / 语言 / 侧栏折叠每次重启都回默认」。
  分开后 dev 的偏好能跨重启保留，也不会踩到正式版的用户数据。
- 连不上 dev 服务时会弹一个带“先跑 npm run dev”提示的错误框，而不是一句 ERR_CONNECTION_REFUSED。

打包：

```bash
npm run electron:build            # = build + python/node:build + bridge:build + gate + electron-builder（自带运行时）
npm run electron:build:slim       # 精简版：不带 node/python，用机器上已有的（需要 Node 22+）
npm run electron:build -- --mac   # 只出 mac；产物在 dist-electron/
CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:build -- --mac   # 本地不出签名包
```

两种变体的开关是 `PI_DESKTOP_RUNTIME_MODE`（`bundled` 缺省 / `system`），产物清单只在
`src-electron/electron-builder.config.cjs` 里派生出差异；运行期由 `paths.js` 自己从“有没有那两个
directory”推出模式，不需要把模式烘进包里。详见仓库根 `README.md` 的 “Packaging without the
embedded runtimes”。

> **macOS 签名不是可选项**：本机没有证书时 electron-builder 会跳过签名，产物 `.app` 保留 Electron 自带的
> linker 签名（`Identifier=Electron`），macOS 会拒绝它的一切**系统通知**（`UNErrorDomain error 1`，还不弹权限框），
> 也就是「任务完成后系统提醒」在打包版里静默失效。`afterPack` 钩子 `scripts/electron-sign-adhoc.mjs`
> 会在检测不到证书时补一个 ad-hoc 签名（identifier 与 `CFBundleIdentifier` 对齐）——实测这样就够，
> 有真实证书时不插手。另外通知只对 `/Applications` 下的包生效，装在临时目录会被静默拒绝。

## 关键设计

- **渲染层零改动**：`src/app/App.tsx`、`src/lib/open-target.ts` 里那 7 处 `invoke()` 和
  `isTauriRuntime()` 检测的都是 `window.__TAURI_INTERNALS__`。`@tauri-apps/api/core` 的
  `invoke` 本身只是 `window.__TAURI_INTERNALS__.invoke(cmd, args, options)` 的一行转发，
  preload 实现这一个入口就能让同一份 `dist/` 在两个外壳里跑。未知命令直接 reject，不会静默。
- **资源布局与 Tauri 打包一致**：sidecar 和内置 python/node runtime 直接复用
  `src-tauri/binaries/*` 里 `npm run sidecar:build` 等脚本的产物，不另建一套构建。
- **生产用自定义协议伺服 dist**：vite 的 `base` 是默认的 `/`，`file://` 下绝对资源路径会 404；
  自定义协议 `app://pi-desktop/` 既有稳定的 origin（`localStorage` 里的主题 / 面板宽度 / 侧栏折叠 /
  语言等偏好才能跨重启保留），又是可信安全上下文（`crypto.subtle` 可用），绝对资源路径也正常。
  之前用 `http://127.0.0.1:<随机端口>`，每次启动都是新 origin，等于所有偏好每次重启都被重置。
  从 `app://` 调 `http://127.0.0.1:<bridge>` 的 API 不受混合内容限制（loopback 属于 potentially
  trustworthy origin，Chromium 不拦）。
- **API 端口固定 6474**：前端的默认 API base 是构建期烧进 bundle 的（`src/lib/api.ts`）。

## 已知差异

- `start_window_drag` 是空实现：Electron 没有可编程拖窗 API，拖拽由标题栏已有的
  `-webkit-app-region: drag` 生效（双击最大化走 OS 原生行为）。
- 只支持请求/响应式的 `invoke`，Tauri 的 streaming channel（`transformCallback`）会显式抛错，
  目前前端没用到了。
- Windows 打包前需要先用 `TAURI_ENV_TARGET_TRIPLE=x86_64-pc-windows-msvc` 跑
  `sidecar:build` / `node:build` / `python:build` 产出 win 版 runtime（与 Tauri 交叉编译同样的前置条件）。
