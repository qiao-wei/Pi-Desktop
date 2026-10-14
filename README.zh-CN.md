# Pi Desktop

`@earendil-works/pi-coding-agent` 的桌面端。

它不是基于 pi 另做的一个工作助手，而是把同一个 agent 放进桌面窗口，顺手补上终端别扭的地方：
粘贴截图、从长回答里复制文字、往回翻一段会话。用法和 pi 一致 —— 已有的会话、技能、扩展在桌面端
照旧可用。

目前还是早期版本，一直在变：有 bug、有没做完的地方、行为也可能随时调整，都属正常，它会一版一版
地完善。

两个原生外壳共用同一份 React 渲染层和同一个本地 Node「桥」：

- **Tauri**（`src-tauri/`）—— 用系统 web view，不含浏览器内核。
- **Electron**（`src-electron/`）—— 自带 Chromium，产物体积主要就是它。

桥（`server/index.mjs`）把 pi 嵌进来 —— `ModelRuntime`、`SessionManager`、`SettingsManager`、
`DefaultResourceLoader` —— 并对外提供渲染层要用的 HTTP/WebSocket 接口。Pi 的资源走
`DefaultResourceLoader` 加载：全局的来自 `~/.pi/agent`，项目级的来自 `<project>/.pi`，
再加上内置的系统技能 `skills/`。会话的工作目录可以是托管 worktree，那条 worktree 的 `.pi`
是指回项目 `.pi` 的软链，项目级 skills / 扩展 / 包因此共用同一份。

[English README](README.md)

## 目录

```
server/          桥：pi 宿主 + HTTP/WS 接口
src/             React 渲染层（Vite）
src-electron/    Electron 主进程 + 打包配置
src-tauri/       Tauri 外壳（Rust）+ 打包配置
scripts/         开发 / 构建 / 诊断脚本
skills/          内置系统技能
tests/           node:test 用例
```

## 开发环境

### 需要装什么

| 依赖 | 用途 |
| --- | --- |
| Node.js 22 或更高 | 开发、测试，以及所有 `slim` 打包（桥声明了 `engines.node >= 22`） |
| Rust stable + [Tauri v2 的系统依赖](https://tauri.app/start/prerequisites/) | 只做 Tauri 外壳才需要 |
| 网络（下载钉版本的 Node / Python 载荷） | 只做 `bundled` 打包才需要，见[打包机需要什么](#打包机需要什么) |

### 跑起来

```bash
npm install
npm run dev              # 一个进程里同时起桥和 Vite
npm run tauri:dev        # Tauri 窗口（自己会把开发栈拉起来）
npm run electron:dev     # Electron 窗口（开发栈没起就起，起了就复用）
```

`npm run dev` 会把桥和 Vite UI 一起拉起来，UI 在 `http://127.0.0.1:5176`。桥自己挑端口（优先
6474），并**把真实端口打到 stdout**；渲染层拿到的是这个地址，经 `VITE_PI_DESKTOP_API_BASE`
烘进去（打包版则由外壳注入 `window.__PI_DESKTOP_API_BASE__`）。如果 6474 被占了，`dev` 会明确
告警：窗口打到别人的桥上，表现出来就是「切会话很慢」—— 这正是以前钉死端口所掩盖的问题。

只起一边（排查时用）：

```bash
npm run dev:api                                                    # 只起桥
VITE_PI_DESKTOP_API_BASE=http://127.0.0.1:6474 npm run dev:web       # 只起 UI
```

- `PI_DESKTOP_REUSE_API=1 npm run dev`：复用已经在监听的桥，不再起一个。
- Electron 主进程代码不热更新，改完 `src-electron/` 要重启 `electron:dev`。给外壳加参数用
  `PI_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9223`。
- 改完 `server/` 下的任何东西，判断打包版行为之前先跑 `npm run bridge:sync`。打包版跑的是
  `src-tauri/binaries/bridge/` 里的那份拷贝，不是你的工作区。

### 状态放在哪

`~/.pi/agent` 里放鉴权（`auth.json`）、会话、技能、项目、能力开关、`bin/` 下的 launcher，
以及 `bundled` 模式下隔离出来的 `node/`、`python/` 前缀。用 `PI_CODING_AGENT_DIR` 可以把这
一整套挪到别处 —— 想复现「全新安装」时最省事。

### 测试

```bash
npm test                                  # PI_DESKTOP_LOCALE=zh node --test "tests/**/*.test.ts"
node --test tests/runtimeModes.test.ts    # 单跑一个文件
```

用 `node:test` + Node 原生的 TypeScript 类型擦除：不引入框架、不加依赖。测试侧的值导入必须
带 `.ts`/`.mjs` 扩展名。

这几组用例值得知道，因为它们守住的是普通运行看不出来的东西：

| 用例 | 守的是什么 |
| --- | --- |
| `electronAppPayload.test.ts` | `app.asar` 里只有主进程，没有别的东西 |
| `launcherRefresh.test.ts` | 真的把桥起起来，检查它写出的 `~/.pi/agent/bin` launcher |
| `packagingVariants.test.ts` | `bundled` / `slim` 两份配置逐项对齐 |
| `runtimeModes.test.ts` | bundled 与 slim 的运行时判定、host PATH 查找、旧 launcher 清理 |
| `sidecarGate.test.ts` | 组装好的桥必须先通过自检，打包器才允许运行 |
| `bridgeEndpoint.test.ts` | 两个外壳找桥的方式一致 |

### 诊断

桥可以写 NDJSON 探针日志；渲染层可以采样自己的绘制耗时。

```bash
PI_DESKTOP_DIAGNOSTICS_ENABLED=1 VITE_PI_DESKTOP_PERF=1 VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1 npm run dev
node scripts/diag-scan.mjs --since=30m     # 在日志里找异常窗口
```

上下文压缩很难用短会话触发，因为 pi 需要同时满足「窗口快满」和「可折叠历史够多」。
`node scripts/compaction-env.mjs change`（64k 窗口 + 很低的 `keepRecentTokens`）能造出真会
压缩的会话，`reset` 恢复默认。它改的是 pi 的全局配置，改完要重启 app。

## 打包

两个彼此独立的维度：**外壳**（Tauri / Electron）× **运行时模式**（`bundled` / `slim`）。

### 两种运行时模式

- **`bundled`**（现状）带钉版本的 Node 25 与 CPython 3.13 载荷，机器上两者都没有也能用上
  `node`、`npm`、`python3`、`pip`。载荷是**构建期下载**官方发行版（sha256 记进 `SOURCES.json`），
  不是从打包机上拷一份现成安装。
- **机器上已有的解释器优先，而且是按运行时分别判定的。** 用户自己装的 `node` / `python3`
  （nvm、pyenv、Homebrew、python.org）会被直接使用，它的 PATH、全局 prefix、site-packages
  我们都不碰；内置载荷只补缺的那一个——只缺 node、只缺 python、或者两个都缺。macOS 的
  `/usr/bin/python3`（Command Line Tools）和 Windows 的 `WindowsApps` 别名**不算**「用户已有」，
  判定靠真的 spawn 探测，不是 `existsSync`。
- 接管某个运行时时，安装落点才会被重定向：`pip install` 落到 `~/.pi/agent/python`，`npm i -g`
  落到 `~/.pi/agent/node` 并用自己的 cache；随包的解释器目录**从不被写**（这也是签名后的
  `.app` 还能验签的原因）。Python 只带标准库和 `pip`。
- **`slim`** 两个运行时都不带，要求目标机器装了 Node 22+；所有运行时都等同「用户自己的」
  （不再有隔离：`npm i -g` 装到用户的全局 prefix）。

模式**不烘进产物，而是推断**：只要产物里那两个 runtime 目录都在，两个外壳都判成 `bundled`，
否则判成 `system` —— 于是打包配置和运行期读的是同一个事实，不可能互相矛盾。打包链会按你选
的入口下发 `PI_DESKTOP_RUNTIME_MODE=bundled|system`，它就是同时作用到 electron-builder、bridge
剪包和门禁的那一个开关；运行期也可以用同一个变量覆盖，便于排障。

命名规则就一行：**`pack:<外壳>:<目标>[:<架构>][:slim]`** —— 目标必须写出来，`:slim` 永远是最后一段，
不带就是 `bundled`。每个入口都是 `scripts/pack.mjs` 的一行包装，步骤只在它里面写一遍。

| 外壳 / 目标 | bundled | slim |
| --- | --- | --- |
| Electron，macOS arm64 | `npm run pack:electron:mac:arm64` | `npm run pack:electron:mac:arm64:slim` |
| Electron，macOS x64 | `npm run pack:electron:mac:x64` | `npm run pack:electron:mac:x64:slim` |
| Electron，Windows（x64） | `npm run pack:electron:windows` | `npm run pack:electron:windows:slim` |
| Tauri，macOS arm64 | `npm run pack:tauri:mac:arm64` | `npm run pack:tauri:mac:arm64:slim` |
| Tauri，macOS x64 | `npm run pack:tauri:mac:x64` | `npm run pack:tauri:mac:x64:slim` |
| Tauri，Windows（x64） | `npm run pack:tauri:windows` | `npm run pack:tauri:windows:slim` |

一次性参数：`--arch arm64|x64`、`--mode bundled|slim`、`--sign local|release`、`--cross`、`--dry-run`（只打印计划不构建）；
`--` 之后的参数原样转交打包器（`npm run pack:electron:mac:arm64 -- --dry-run`）。Windows 目前只出
x64；要出 Windows on ARM 时在 `scripts/lib/packPlan.mjs` 的 `PACK_ARCHES` 里加 `arm64`。

**旧名字是故意删掉的**（`electron:build`、`package:mac`、`package:windows:cross` …）：不带目标的
入口说不清它到底出什么包，也不能保证别人机器上跑出同样的东西。对照就是上面那张表。

### 流水线做了什么

两条外壳走同一条链，只在 `scripts/pack.mjs` 里定义一次：

```
tsc -b → vite build → python:build + node:build（仅 bundled）→ bridge:build → sidecar:verify → 打包器
```

`sidecar:verify` 现在**两条外壳都守**。只有交叉构建才跳过它，而且会把原因打印出来 —— 那种情况
下 bridge 已按目标平台剪过平台包，在构建机上本来也起不来。Tauri 通过
`beforeBuildCommand: npm run tauri:prepare` 接入同一条链；`pack.mjs` 已经跑过时它是空转（slim 的
overlay 现在只剩两个资源 null，不再抄一份步骤链）。

`bridge:sync` 从链里去掉了：它带 `--skip-install` 又跑一遍组装，产物字节级完全一样，却跳过了唯一
那道强校验。作为离线开发入口它还在（见上面“判断打包版行为”那段）。

桥是**组装**出来的、从不编译成单文件：未打包的 `server/` 与 `src/` 源码 + 一份真实的生产
`node_modules`，由内置 Node 通过 `pi-desktop-server` launcher 执行。pi 的运行时扩展是按它
在磁盘上解析到的包来加载的；编译成单个可执行文件的桥会把这些包内联一份、并按构建改名
导出，让扩展能不能加载取决于构建运气。`sidecar:verify` 会把组装好的桥起起来，只要有一个被
选中的能力包没加载成功就报错，因此坏掉的组装根本到不了打包器。

装完之后，`bridge:build` 还会删掉这个产物永远跑不了的平台专属包
（`scripts/lib/platformPackages.mjs`）。npm 的 `os`/`cpu` 过滤对一棵由 `npm-shrinkwrap.json`
描述的树不生效，而 pi 正好自带一个：pi 通过 `@earendil-works/chord` 用到的 esbuild，是以
"每个平台一个包"的形式来的 —— 每个平台都有，而这里只有一个跑得了。`npm install --os/--cpu`
改不了这一点，装完再删就可以；判定规则就是 npm 自己那套（声明了匹配的 `os`/`cpu` 就留，含
`any` 和 `!` 否定式）。平台取 `PI_DESKTOP_TARGET_TRIPLE`（`scripts/pack.mjs` 按你指定的目标/
架构下发），直接跑 `tauri build` 时退回它自己导出的 `TAURI_ENV_TARGET_TRIPLE`，都没有才用构建机
自己的 —— 所以 Windows 包留下的是 `win32` 那套，而不是 Mac 的。`node:build` 与 `python:build` 读
的是同一个变量，“按哪个平台剪包”和“给哪个平台打包”因此不可能再漂开。

清单里记的版本来自**仓库 `node_modules` 里实际装的**，而不是 `package.json` 声明的范围。一次
提交把依赖升了级，但没人跑 `npm install` 的话，`node_modules` 还是旧的 —— 用这棵过期树装出来的桥
会悄悄发布旧包，所以构建会把两边对一下并发出警告（不失败：`--skip-install` 构建、以及本地比
声明下限更新的树，都是合理的）。

Windows 没有 launcher 脚本：两个外壳都是 `node-runtime\node.exe` + `bridge\server\index.mjs`
（Electron 在 `src-electron/paths.js`，Tauri 在 `src-tauri/src/lib.rs`），任何产物里都不存在
`pi-desktop-server.exe`。

### 打包机需要什么

- **`bundled`** 需要网络：载荷是下载来的，不是从机器上拿的。
  - Node：目标平台的官方发行版，版本是 `scripts/lib/runtimePayloads.mjs` 里的 `NODE_VERSION`
    （默认 npmmirror，用 `PI_DESKTOP_NODE_DIST_MIRROR` 换源）。
  - Python：python-build-standalone 的 `install_only_stripped` CPython，版本 + release tag 同样
    钉在那个模块里（默认 npmmirror，`PI_DESKTOP_PYTHON_DIST_MIRROR` 可指向 GitHub Releases 或内网镜像）。
  - `scripts/lib/runtimePins.json` 记每个目标平台的预期 sha256：对不上直接构建失败；还没钉过的
    目标只记录到 `SOURCES.json` 并打警告（第一个 pin 就是这么产生的）。
  - 离线/内网：`PI_DESKTOP_NODE_SOURCE_DIR` / `PI_DESKTOP_PYTHON_SOURCE_DIR` 指向已经解开的
    发行版根目录，跳过下载。
  - 打包机上**不需要**装目标原生解释器。只有目标平台就是构建机时才会真的执行载荷
    （`isNativeTarget`）；交叉组装的载荷走文件级门禁（可重定位、shebang、软链）。
- **`slim`** 两样都不需要：不用载荷、不用额外网络，打包机上有 Node 22+ 就行。

### 交叉构建

运行时载荷是按目标平台组装的（每个归档都按目标寻址，所以 macOS 上能解开 win32 载荷），但
`--cross` 仍然拒掉 `bundled`：目标平台的 `node.exe` / `python.exe` 在这里跑不起来，
`node:build` / `python:build` 就没法证明刚打进包的这份解释器真的能用。这是一条**验收边界**，
不是技术上做不到——门禁的报错本身就写明了这一点和几条出路。
**`slim` 交叉没问题**：它不带 runtime。

| 打包机 | macOS 目标 | Windows 目标 |
| --- | --- | --- |
| macOS | bundled + slim | **仅 slim** |
| Windows | 不可能 | bundled + slim |
| Linux | 不可能 | **仅 slim** |

macOS 永远不能作为交叉目标：dmg、签名、公证都绑在 Mac 上。

在 Apple Silicon Mac 上交叉构建 Windows 安装包（仅 slim）：

```bash
brew install nsis llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
npm run pack:tauri:windows:slim -- --cross      # Tauri：cargo-xwin
npm run pack:electron:windows:slim -- --cross   # Electron：需要 wine（计划里缺 wine 会先提示）
```

### 产物里都有什么

两个外壳共同的资源：`bridge/`、`renderer/`、`skills/`、`capabilities.defaults.json`，POSIX 上
还有 `pi-desktop-server` launcher，bundled 模式下再加 `node-runtime` / `python-runtime`。

Electron 另外有 `app.asar`，里面**只有主进程**。它的 `files` 是**故意**排除
`node_modules` 的：`directories.app` 指向 `src-electron`，而那里既没有 `dependencies` 也没有
`node_modules`，于是 electron-builder 会回退到仓库根，把渲染层整份依赖树打进 asar —— 那是 Vite
早就打好的那些库的第二份未压缩拷贝（渲染层在 `<resources>/renderer`）。`tests/electronAppPayload.test.ts` 负责守住这条排除：只要
`src-electron/` 下出现第三方依赖就报红。开发期读的是仓库的 `node_modules`，所以那种错误只会在
打包版暴露。

### 从 bundled 升级 / 机器后来自己装了运行时

旧 bundled 安装写下的 launcher 指向的 `node-runtime` 新包里已经没有（slim 包，或者用户后来自己
装了 Node），而 `~/.pi/agent/bin` 在 PATH 最前 —— 留下的后果是用 `exit 127` 把真正的解释器遮掉。
因此桥只删它能证明是**自己的**那些（内容里有 `PI_DESKTOP_BUNDLED_*` 标记，或软链指向 `-runtime`
目录），而且是**按运行时**分别处理，用户自己的文件不碰；逻辑见 `server/agentShimFiles.mjs`。

「按运行时接管」带来的后果：

- 用内置 npm 装过的全局 CLI 仍然可调用（它的输出目录是**追加**在用户 PATH 之后，不是前插）；
- 装进 `~/.pi/agent/python` 的包对用户自己的解释器不可见，也不做迁移 —— 目录留在那里，用户要
  用可以自己取;
- `pi` launcher 和桥自己永远跑随包的 Node，与 agent 的 `node` 解析到谁无关（桥声明了
  `engines.node >= 22`，用户的可能更旧）。

缺 Node 要报出来，而不是静默活着：Electron 走 `reportStartupFailure`，Tauri 弹
`MessageDialog` 再退出，而不是 panic 成一次无声闪退。

macOS 和 Linux 上会回读登录 shell 的 PATH，因为 GUI 启动的应用拿不到它（`launchctl getenv PATH`
是空的，`/etc/paths` 里也没有 `/opt/homebrew/bin`），用户自己装在包外的工具——`/opt/homebrew/bin`、
`~/.local/bin`——只能这样找到。回读的是**交互式**那一次（`-lic`）：nvm / pyenv / asdf 只从交互式
rc 文件里导 PATH，而那些解释器正是我们要让位的对象。交互式也是最贵的那次，所以当应用手上这条 PATH
已经能解析出一个**用户的** node **和**一个用户的 python 时就跳过回读。`PI_DESKTOP_HOST_PATH` 可以
整个覆盖掉。

### 签名档位（macOS）

签名是一个**档位**，不是随手加的开关：它同时决定用哪张证书、要不要安全时间戳、要不要公证。
默认就是 `local`，所以最常见的那条路不需要任何 env。

| 档位 | 怎么出包 | 实际动作 | 用途 |
| --- | --- | --- | --- |
| `local`（默认） | `npm run pack:electron:mac:arm64` | ad-hoc 签名（`identity: "-"`），不取时间戳、不公证、不联网 | 本机自用、开发验收（含系统通知） |
| `release` | `npm run pack:electron:mac:arm64 -- --sign release` | Developer ID 真签名 + 安全时间戳 + Apple 公证 | 对外分发 |

档位由 `scripts/lib/macSigning.cjs` 一处决定，electron-builder 的配置、出包计划、`--dry-run` 的输出
念的都是同一份；`--sign` 只认命令行，shell 里导过的 `PI_DESKTOP_SIGN` 不会改变一条命令的含义。

档位只从 pack 入口下发（出包计划带 `--config src-electron/electron-builder.config.cjs`），所以手跑
`electron-builder` 或 `tauri build` 绕过的既是档位也是 release 档的凭证门槛。mac 的那段配置还顺手把
Electron 自带的 220 个 locale 目录裁到 `en` / `zh_CN` / `zh_TW` —— 那是 49MB 的 `.lproj`，每个都要单独
签一次名。

- `release` 档要 Apple 凭证（二选一）：`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`，或
  `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`（Tauri 认 `APPLE_PASSWORD`，同一个值再导
  一遍即可）。缺凭证会在出包**之前**报错：electron-builder 自己只会 `skipped macOS notarization` 一句
  warn 然后照常出包，那种“签了但没公证”的包 `codesign` 检查全过、Gatekeeper 照样拦。
- 证书本身用 `PI_DESKTOP_SIGN_IDENTITY` 覆盖；默认值是 `Developer ID Application` 这个限定词，它顺带
  堵掉“钥匙串里恰好有张非 Apple 证书就被选去签整个包”的洞 —— macOS 包当初动辄几分钟（300+ 个文件
  逐个签名，每个都联网取一次时间戳）就是这么来的。
- 系统通知只对 `/Applications` 下的包生效，两个档位都一样。`local` 档确实能弹通知 —— 它就是为此才签名的。
  动过任何签名相关的东西之后，用 `npm run notification:verify` 验收（它在一个一次性实例里通过真实 IPC
  调 `notify_turn_complete` 并读回 `{delivered, reason}`）；加 `--control` 跑阴性对照 —— 同一套探针对着
  Electron 自带的 linker 签名包跑一遍，它**必须**失败，否则说明探针分辨不出签名好坏。

### 产物路径

- Electron：`dist-electron/mac-arm64/Pi Desktop.app`、
  `dist-electron/Pi Desktop-<version>-arm64.dmg`（x64 在 `dist-electron/mac/`，Windows 在
  `dist-electron/win-unpacked/` 加 NSIS 安装器）。
- Tauri：`src-tauri/target/<目标三元组>/release/bundle/{macos,dmg,nsis}/` —— 出包入口总显式传
  `--target`，产物按三元组分目录（不带三元组的裸 `npm run tauri:build` 才写在
  `src-tauri/target/release/`）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_DESKTOP_HOST`、`PI_DESKTOP_PORT` | 桥的监听地址 / 端口。显式指定端口就是契约，否则桥回退到空闲端口并把真实地址打出来 |
| `PI_DESKTOP_REUSE_API=1` | 开发期：复用已经在监听的桥 |
| `PI_DESKTOP_DEV_URL`、`PI_DESKTOP_ELECTRON_ARGS` | `electron:dev`：要接的开发服务器地址 / 额外的 Electron 参数 |
| `PI_CODING_AGENT_DIR` | pi 的状态目录（默认 `~/.pi/agent`） |
| `PI_DESKTOP_LOCALE=zh\|en` | 钉住界面语言，不做系统探测 |
| `VITE_PI_DESKTOP_API_BASE` | 渲染层：桥的基地址，只跑 `dev:web` 时用 |
| `PI_DESKTOP_RUNTIME_MODE` | 强制 `bundled` 或 `system`，不走推断 |
| `PI_DESKTOP_SIGN`、`PI_DESKTOP_SIGN_IDENTITY` | macOS 的签名档位（`local`\|`release`）与用哪张证书；平时由 `--sign` 和 `Developer ID Application` 默认值下发，只用于覆盖 |
| `PI_DESKTOP_HOST_PATH` | 覆盖桥用来判定和注入的 PATH —— 也就是去哪里找用户自己的 `node`/`python3` |
| `PI_DESKTOP_DIAGNOSTICS_ENABLED=1` | 打开桥的 NDJSON 探针日志 |
| `PI_DESKTOP_DIAGNOSTIC_LOG` | 日志位置（默认 `~/.pi/agent/pi-desktop-runtime.ndjson`） |
| `PI_DESKTOP_DIAGNOSTICS_STDERR=1` | 探针行同时打到 stderr |
| `VITE_PI_DESKTOP_PERF=1`、`VITE_PI_DESKTOP_DIAGNOSTICS_ENABLED=1` | 渲染层性能探针，供 `scripts/diag-scan.mjs` 使用 |
| `PI_DESKTOP_COMPACTION_RESERVE_TOKENS`、`PI_DESKTOP_COMPACTION_KEEP_RECENT_TOKENS` | 压缩阈值（默认 2200 / 1400） |
| `PI_DESKTOP_NODE_DIST_MIRROR`、`PI_DESKTOP_PYTHON_DIST_MIRROR` | `node:build` / `python:build` 从哪里下载钉版本的归档（默认 npmmirror；python 上游是 python-build-standalone 的 GitHub Releases） |
| `PI_DESKTOP_PYTHON_SOURCE_DIR`、`PI_DESKTOP_NODE_SOURCE_DIR` | 离线出路：用已经解开的发行版根目录组装载荷，不下载 |
| `PI_DESKTOP_TARGET_TRIPLE` | 出包链下发给 `node:build` / `python:build` / `bridge:build` 的目标三元组（优先于 Tauri 自己的 `TAURI_ENV_TARGET_TRIPLE`） |
| `PI_DESKTOP_PACK_PREPARED=1` | 由 `scripts/pack.mjs` 设置，让 `tauri:prepare` 空转，准备步骤每个包只跑一次 |
| `PI_DESKTOP_SIDECAR_BIN`、`PI_DESKTOP_GATE_NODE_RUNTIME`、`PI_DESKTOP_GATE_PYTHON_RUNTIME`、`PI_DESKTOP_GATE_CWD`、`PI_DESKTOP_GATE_TIMEOUT_MS` | `sidecar:verify` 起什么、在哪起 |

以下是外壳或 launcher 自己设的，不要手工设：`PI_DESKTOP_BUNDLED_NODE_BIN`、
`PI_DESKTOP_BUNDLED_NPM_CLI`、`PI_DESKTOP_BUNDLED_PYTHON_BIN`、`PI_DESKTOP_BUNDLED_PYTHON_HOME` ——
它们只说载荷**在哪**；用不用内置的那份，由桥拿着传给它的 PATH 按运行时分别探测决定
（`server/agentEnv.mjs`）。slim 包一个载荷都不带，两个运行时自然都落到机器自带的解释器上。
另外还会设：`PI_DESKTOP_APP_SKILLS_DIR`、`PI_DESKTOP_APP_PACKAGES_DIR`、
`PI_DESKTOP_CAPABILITIES_DEFAULTS_FILE`。生成的 POSIX launcher 还接受 `PI_DESKTOP_BRIDGE_DIR`、
`PI_DESKTOP_BRIDGE_NODE`，用于换位置。

## 其它文档

- [README.md](README.md) —— 同一份文档的英文版
- [docs/plan.md](docs/plan.md) —— 早期的产品方案，写于这还是「英语陪练」原型时；它不是当前
  应用的说明