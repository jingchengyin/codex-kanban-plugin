# Codex Taskboard · 对话看板

本机 Codex 插件，使用 React 19 和 affectUI。提供全局侧边栏入口、对话侧面板入口和独立浏览器预览。读取真实本地数据，不内置演示对话。

## 功能

- 默认五列看板：需要你处理、正在运行、未读、暂时空闲、执行异常。「状态待同步」列默认隐藏，可通过运行状态筛选显示。每条对话只出现在一列；需要处理、运行中或异常优先，其余未读对话进入未读列，已读后按运行状态归列。
- 界面仅保留看板与搜索、筛选、连接设置、刷新和排序；支持运行状态、项目、阅读状态及对话类型筛选。选择运行状态后仅显示对应列，符合所选运行状态的未读对话仍保留在未读列；对话计数与当前显示结果一致。
- 卡片展示会话记录中的模型和思考等级；字段缺失时显示未知。主题直接使用 Codex 宿主提供的颜色变量，跟随深浅色切换。
- 卡片展示计划/默认模式、目标模式状态，以及当前一轮或最近一轮的累计 token 和耗时。Token 优先使用逐轮统计，旧记录以整段对话累计值的差额计算，包含缓存输入；不会把单次模型请求当作整轮用量。运行中更新耗时，结束后保留该轮数值；断线或未加载时暂停计时，缺失数据保持未知。
- 卡片展示对应轮次最近一条用户输入的原文，保留空白、换行与 Markdown 字符；最多显示 5 行，超出部分显示省略号。新一轮开始后清空上一轮输入，直到读取到本轮输入；不会使用对话标题代替原文。
- 默认筛选普通对话，可在筛选器中显示子 Agent。
- 原生 `waitingOnApproval` / `waitingOnUserInput` 标记映射到待处理列；实际失败通知映射到异常列。
- 异步问题弹窗也进入「需要你处理」，即使原生状态仍为普通运行中。逐题回答或跳过后恢复运行状态，回合结束后清除。
- 点击卡片直接通过 `codex://threads/<id>` 请求打开原对话，不弹出详情框。跳转是否允许由宿主决定。
- 读取客户端持久化的已读/未读记录。若只有一个持久化账号和本地主机可自动使用；多份本地主机记录时需在「连接与数据源」中明确选择，不合并、不猜测。账号变化后旧选择失效。
- 连接断开保留最后快照，实时状态失效后归入待同步，避免把陈旧的运行状态当作当前状态。

## 开发与预览

需要 Node.js >= 22.13（使用只读 `node:sqlite`）。

```sh
npm ci
npm run build
npm run preview
```

打开 http://127.0.0.1:4318 。`npm run dev` 可启动 Vite 开发界面；同时需运行上述预览服务提供 `/api`。

预览服务仅绑定 127.0.0.1，有 Host 校验，不开放跨域访问。插件内通过 MCP 自有工具读取快照，不依赖 iframe 访问本机 HTTP 服务。

## 安装插件

```sh
npm run package:plugin
codex plugin marketplace add ./releases/marketplace
codex plugin add codex-taskboard@codex-taskboard-local
```

打包会生成 `releases/codex-taskboard-0.1.0.zip`，以及包含生产依赖的本地 marketplace。依赖从锁文件安装，包内不包含对话记录、测试证据、截图或 Codex 凭据。根据当前客户端的插件刷新行为，可能需要重新打开 Codex 后才显示「对话看板」入口。

这是本地桌面插件，不是公开目录发布；没有上传数据或提交审核。卸载使用 `codex plugin remove codex-taskboard@codex-taskboard-local`。

## 接入实时状态

**安装插件本身不能观察现有私有 stdio 后端。** 需要让 Codex 桌面与观察器连接同一个官方 App Server WebSocket 后端。用户已在本机验证过这条链路。

在项目目录的独立 Terminal 中运行：

```sh
npm run codex-kanban-plugin
```

命令会启动共享后端，并自动以共享模式打开 Codex。如果 Codex 已打开，终端会等待你按 `⌘Q` 完全退出，然后自动继续启动，无需复制第二条命令。打开「对话看板」，等待「实时已连接」。`npm run live` 保留为兼容别名。

- 点击 Codex 图标：普通启动，使用客户端自己的后端。
- 运行 `npm run codex-kanban-plugin`：共享启动，Codex 与看板连接同一个后端。

共享模式只为本次启动的进程设置环境，不修改全局环境、shell 配置或应用设置。退出共享模式的 Codex 后，下次点击图标即可普通启动，无需恢复命令。普通模式仍可使用对话列表、搜索和已读/未读；运行状态显示为未知。若 Codex 仍在运行，点击图标只会回到当前进程，切换启动方式需先完全退出。

脚本同时打印本次后端日志路径。启动失败时会显示退出原因和最后一段日志；日志保存在本机临时目录，只有当前用户可读写。

保持终端运行。退出本次 Codex 进程后，命令会自动停止自己创建的后端并结束。已存在的官方共享后端会被复用，已有共享模式的 Codex 不会被重复打开；本命令不会停止其他终端创建的后端。若在 Codex 仍运行时中断终端，会保留后端，下次运行命令可复用它。

`CODEX_APP_SERVER_WS_URL` 是当前客户端的内部集成变量，可能随版本变化；官方 WebSocket 协议与这个桌面开关的稳定性应分开看。共享启动不会自动复制原 stdio 分支的全部配置覆盖，其他插件、内置工具和权限策略仍需在使用的客户端版本上单独确认。Taskboard 不复制私有 app-tools 管道凭据。

可选环境变量：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | 本机对话索引与未读数据目录 |
| `TASKBOARD_WS_URL` | `ws://127.0.0.1:19429` | 已存在的共享状态后端，仅接受无凭据 loopback 地址 |
| `TASKBOARD_PORT` | `4318` | 浏览器预览端口 |
| `TASKBOARD_CODEX_CLI` | 当前 macOS 应用的随附 CLI | 共享启动命令使用的官方后端程序 |

## 数据边界与状态含义

- 只读 SQLite 索引、目标状态、客户端未读映射，以及会话 JSONL 中的模式、执行时间、token 元数据和对应轮次的用户输入，不写 Codex 数据。JSONL 首次从末尾扫描，后续增量读取；用户输入原文仅在内存和看板快照中保留，不写日志或本地存储。助手回复、工具正文和客户端注入上下文不保留、不返回。
- 通过官方 WebSocket 发送 initialize、loaded/list 和 includeTurns=false 的 thread/read；对活跃对话额外读取最新一轮 `thread/turns/list`（`limit=1, itemsView=full`），识别摘要中缺失的异步问题与已回答标记。正文只在内存中即时处理，仅保留问题 ID，不写入日志或返回给看板；不 start/resume 对话，不执行工具，不回答审批。
- `idle` 仅表示当前没有活跃回合，不代表业务验收完成；`notLoaded` 保留为状态待同步。
- 连接故障和单条对话失败分别显示；没有真实状态时保留未知。
- 前端只在本地保存视图偏好和明确选择的读取来源，不缓存对话正文或标题。
- 只观察共享后端的本地对话；不推断其他设备、云端或远程主机状态。

## 验证

```sh
npm run build
npm test
python3 -m unittest discover -s tests -v
```

自动测试包括临时 SQLite 索引、真实本机测试 WebSocket、审批不代答、失败恢复、断线快照失效、未读身份隔离，以及打包后真实 MCP stdio 的 tools/list、resources/read、tools/call。测试 WebSocket 的待确认/异常样本是受控协议样本，不等于已经在用户桌面实测这些状态。

macOS 安装了随附 CLI 时，还会通过 Python 标准库创建真实终端，验证官方后端启动、WebSocket 连接、等待现有桌面退出后继续启动、退出后自动清理、已有后端复用、重复命令与端口冲突。测试使用临时数据目录和随机端口，桌面启动及退出由测试替身模拟，不退出或重开用户的 Codex。

此前真实桌面测试已捕获 3 条线程各自 active → idle，至少一条确认是用户线程。待确认与线程失败的真实桌面样本仍待补齐。原始验证资料保留在 outputs/；最新链路结论见 outputs/state-chain-follow-up.md。

## affectUI

实际采用 affectUI 开源组件源码：Button (Clean)、Filter Menu (Clean)、Segmented Control (Clean)、Thinking Loader (Clean)。原始组件和 MIT 许可位于 ui/vendor/affectui，应用层另行添加布局和主题。字体和所有 UI 代码都内联到 HTML，可在 MCP App 的隔离界面中运行。

来源：https://github.com/flohoeller/affectui#use-it-with-ai-tools 。完整第三方声明见 THIRD_PARTY_NOTICES.md。
