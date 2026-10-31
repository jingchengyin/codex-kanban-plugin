# 看板免重启接入调研

实现进展（2026-10-30）：默认桌面 IPC、增量同步、确认回传和观察退订已接入，169 项测试通过。本机插件已更新，安装后的运行时已直接读取当前桌面的真实状态。确认闭环使用隔离的真实 App Server、本地固定响应模型和模拟桌面 owner 验证，没有替用户处理真实桌面的确认请求。结果见[实现验收记录](/Users/bytedance/Documents/nowork/codex-kanban-plugin/docs/research/no-restart-evidence/installed-runtime.json)。以下保留实现前的调研过程与当时的验证边界。

研究日期：2026-10-30（Asia/Shanghai）。本机客户端：Codex 26.1023.51421，build 22530；内置 CLI：0.165.0-alpha.1.2。以下结论只覆盖这台机器的 macOS 本地对话。

**结论：找到可行入口，实时读取已验证；卡片确认还没有完成实际验证。**

当前运行的 Codex 已有桌面 IPC socket。观察者可以连接它，订阅已有对话，取得状态快照和后续增量更新，不必重启客户端，也不必重启 App Server。研究过程中，桌面主进程 PID 1161、原后端 PID 3115 和 8210 均未变化。

这需要修正上一轮判断。`Codex app tools pipe closed` 并不能证明桌面接口不能独立连接。原生 App Tools 会检查连接进程及其祖先的代码签名。把整个探针放到 Codex 自带的签名运行时中直接运行后，状态查询成功；在 shell 重定向导致额外祖先进程保留的对照实验中，连接仍被拒绝。

更适合本项目继续验证的是桌面协调 IPC。它不需要依赖 App Tools 的这套签名运行时调用链，本次使用普通 Node 也做了复测。它属于客户端内部协议，不能把本机可行性验证等同于稳定公开 API，更不能等同于已发布插件已经可用。

**本次具体验证了什么**

研究分两轮进行。首轮分别检查官方 App Server 接口、桌面 IPC 和本地持久化数据；第二轮针对签名校验、实际订阅、增量推送、owner 路由和旧确认请求做交叉检查。

| 实验                                    | 结果                                                                                                                 | 结论范围                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 原版 App Tools 探针，普通 Node 父进程   | 在 `tools/list` 被关闭连接                                                                                           | 这条启动进程链未通过桌面校验                 |
| 原版 App Tools 探针，签名运行时直接启动 | `tools/list`、`list_threads` 成功，直接启动重复实验也成功                                                            | 能读取当前运行桌面的状态                     |
| 同一连接连续读取三次状态快照            | 均成功；耗时分别为 1588、209、215 毫秒                                                                               | 当前目录快照可持续刷新；这些数字不是性能承诺 |
| 桌面 IPC，真实自命名观察者初始化        | 成功分配新的 clientId                                                                                                | 不需要冒充已有窗口或取得 owner 身份          |
| 对当前已运行对话订阅                    | 收到 version 11 状态快照，状态为 `active`、`resumed`                                                                 | 已验证读取同一运行中对话                     |
| IPC 订阅与独立复测                      | 两轮均收到增量；独立复测收到三条，revision 从 5 连续推进到 8，路径包含 `turnHistory.history`、`latestTokenUsageInfo` | 已验证实时推送，而非仅能轮询                 |
| 实际确认提交                            | 没有执行；快照中的待确认请求数为 0                                                                                   | 不能声称确认闭环已经通过                     |

所有实验只做观察。没有调用 `thread/start`、`thread/resume`，没有提交审批、回答问题、修改配置或开启远程控制。观察结束后发送 `following:false` 并断开连接。保存的证据只有字段名、状态、版本和聚合计数，没有对话正文、命令、diff 或原始请求 ID。

**为什么现有启动器需要重启**

现有实现依靠桌面启动时注入转发器。转发器创建 App Server，并在创建时加上 `--listen ws://127.0.0.1:19429`。它同时持有桌面的原始连接，用来转发确认请求。因此已经按普通方式运行的 stdio 后端不能直接被当前启动器复用。

官方文档列出了 stdio、WebSocket 和 Unix socket 启动方式，但没有找到给任意已运行的 stdio 后端动态增加 listener 的公开接口。`config/mcpServer/reload` 只刷新 MCP 配置。managed daemon 的 proxy 也要求桌面原本就在使用那个 daemon；另起一个 daemon 不会接管原后端的内存状态。remote-control 的官方说明还明确指出，它不是本地协议客户端的 `app-server --listen` 替代。

依据：[现有后端创建代码](/Users/bytedance/Documents/nowork/codex-kanban-plugin/scripts/desktop-cli.mjs:44)、[App Server 协议](https://learn.chatgpt.com/docs/app-server#protocol)、[API overview](https://learn.chatgpt.com/docs/app-server#api-overview)、[remote-control 说明](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control)。

**新入口：桌面已有的 owner/follower 通道**

本机 socket 位于 `CODEX_HOME/ipc/ipc.sock`，默认是 `~/.codex/ipc/ipc.sock`。目录权限为 0700，socket 为 0600。它由现有桌面主进程持有，用于窗口之间协调同一对话。它与 `app-server-control.sock`、App Tools pipe 是三个不同的入口。

消息使用四字节 UInt32LE 长度加 JSON。观察者先发送 `initialize`，用自己的 clientType 取得新的 clientId；再发布 `thread-stream-following-changed`，订阅目标对话。原 owner 随后向该观察者发送完整快照，之后推送带 revision 的 patches。观察者不需要设置 ownership，也不应发布对话状态来冒充 owner。

实测快照包含 50 个顶层字段，其中有 `threadRuntimeStatus`、`requests`、`latestModel`、`latestReasoningEffort`、`latestCollaborationMode`、`latestTokenUsageInfo`、`threadGoal` 和 `hasUnreadTurn`。这比 `list_threads` 的简要状态更接近看板现有的数据需求。首期可以只提取这些字段，继续让本地 SQLite 和 rollout 负责目录、历史与用量索引。

协议版本按方法分别维护。本机代码中的状态广播版本为 11，following 广播版本为 1，read-state 广播版本为 3；接收端严格比较版本。版本不匹配可能没有数据。因此适配器必须明确支持范围，不能假定客户端升级后仍兼容。

本机实现依据：`/Applications/ChatGPT.app/Contents/Resources/app.asar` 内的 `.vite/build/src-tOjGKoT3.js`（`AM`、`FM`、`Oe`）和 `.vite/build/main-UOTY8NmV.js`（`tPe`、`Xxe.handleThreadStreamFollowingChanged`、`sendConversationSnapshot`）。解包源码只用于本机只读核对，没有加入仓库。可复测探针和脱敏结果见文末。

**卡片确认：存在回传路径，仍须验证原请求是否真正完成**

桌面代码已有 `thread-follower-command-approval-decision`、`thread-follower-file-approval-decision`、`thread-follower-permissions-request-approval-response` 和 `thread-follower-submit-user-input`。它们会路由到原 owner，再由 owner 使用原 App Server 连接答复。快照还包含原始 `requests` 集合，所以不必从日志猜请求 ID 或重造审批接口。

但本次没有实际待确认请求，也没有提交任何决定。这一部分只有源码依据。尤其要注意：IPC 返回 `{ok:true}` 不能单独证明确认生效。源码中有旧 request ID 查不到后直接返回的分支，而外层仍可能返回成功。未来按钮必须结合请求移除、resolved 通知或原回合继续执行来判断结果，并验证桌面先处理后旧按钮失效。

确认还需要跟随当前 owner。不能把请求固定发给第一个窗口；owner 退出后，旧 clientId 也不能继续使用。命令、文件、权限和用户答案之外的交互类型需逐项核对，不能一次承诺全部支持。

依据：本机 bundle 中的 `kCe`、`aCe`、`ZSe`、`Gy`、`eCe`；[官方审批说明](https://learn.chatgpt.com/docs/app-server#approvals)；[项目现有确认入口](/Users/bytedance/Documents/nowork/codex-kanban-plugin/server/confirmations.ts:25)。

**各条路线的取舍**

| 路线                                     | 能否免重启接入当前桌面               | 状态覆盖                           | 确认覆盖                        | 本项目建议                                   |
| ---------------------------------------- | ------------------------------------ | ---------------------------------- | ------------------------------- | -------------------------------------------- |
| 已存在的同一 App Server Unix/WS listener | 有入口时可以；本机普通后端没有该入口 | 官方运行态和事件                   | 跨连接旧请求接管未获保证        | 作为条件可用方案                             |
| 给 stdio 后端动态加 listener             | 未找到公开支持                       | 无实测                             | 无实测                          | 不作为当前主攻方向                           |
| 新起 daemon 或开启 remote-control        | 不能直接接管原 stdio 后端            | 需要另行迁移桌面连接               | 不能据此恢复旧请求              | 不解决本次切换问题                           |
| 原生 App Tools                           | 指定启动进程链已成功                 | 简要状态、未读；可轮询             | 未发现等价确认工具              | 可作目录和状态补充；还需验证插件自身的启动链 |
| 桌面协调 IPC                             | 快照和增量推送已成功                 | 已加载且有 owner 的对话状态        | 有原 owner 回传代码，未实际提交 | 优先做小范围集成验证                         |
| SQLite、rollout、调试日志                | 可以直接读                           | 历史和近期事件，不足以证明实时状态 | 缺完整请求生命周期              | 保留基础数据用途                             |

本地文件路线有实际反例：只读查询发现 28 条 `inProgress` 历史 turn，其中最早开始于 2026-06-02，仍无完成时间。因此“没有结束记录”不能可靠判定仍在运行，也不能据此区分等待审批、进程退出和长期任务。项目现有文件探针已经明确保留 unknown/null，这个边界应继续保持。

依据：[文件状态探针](/Users/bytedance/Documents/nowork/codex-kanban-plugin/scripts/probe-file-status.py:139)、[本地数据读取](/Users/bytedance/Documents/nowork/codex-kanban-plugin/server/local-data.ts:237)、[看板状态映射](/Users/bytedance/Documents/nowork/codex-kanban-plugin/shared/types.ts:114)。

**适配前必须解决的具体问题**

观察订阅会登记 follower，并增加快照、增量传输和内存开销。源码还会在有 follower 时延后线程卸载与历史裁剪。因此建议只订阅面板中可见或正在执行的对话，关闭面板时退订。它是可逆观察订阅，但不是完全没有副作用的旁听。

没有 owner 或尚未加载的历史对话不保证返回快照，应继续展示本地目录和明确的未知状态。快照之后必须按 owner 和 `baseRevision` 接受补丁；断线、owner 改变或版本不连续时重新获取快照。重连时重新初始化 clientId，不能沿用旧会话身份。

本次只验证了当前 macOS 客户端和 local host。SSH、remote-control、云端对话、其他操作系统与不同客户端版本都没有验证。私有协议兼容性是这条路线的主要维护成本。

**建议的下一步与完成标准**

建议先新增一个 IPC 状态来源，接到现有 `StatusBridge` 的数据聚合中，复用现有本地索引、类型和界面。第一步只接入状态读取；确认按钮在实际闭环验证通过后启用。保留原共享模式，供需要现有兼容方式的用户使用。

具体完成标准是：从正常启动的 Codex 打开已安装插件，直接收到快照和持续更新；核对运行、等待、完成、异常和中断；关面板后观察订阅清理；断线与 owner 窗口退出后状态正确失效。随后用明确授权的无害测试验证允许、拒绝、用户答案和旧请求失效。仅有探针成功，还不足以宣布插件改造已经完成。

成熟度判断：原生 App Tools 的状态快照和桌面 IPC 的实时读取已有本机证据，可以开始小范围集成；IPC 确认只有源码证据，仍处于验证阶段；日志推断和动态 listener 方向不足以作为完整替代方案。

**复测与证据**

新增的研究探针只会初始化、拒绝承担其他客户端的 owner 请求、订阅、记录脱敏结构、退订。它不包含确认提交或回合操作。

```sh
node scripts/probe-desktop-ipc.mjs "$CODEX_THREAD_ID"
```

也可把正在桌面加载的真实对话 ID 作为第一个参数，第二个参数指定结果文件。默认结果写到 `/tmp/kanban-desktop-ipc-probe.json`。探针最多观察 20 秒；没有快照时返回非零退出码。没有增量消息只说明该观察窗口没有收到变化，不能把快照成功写成增量成功。

- [只读 IPC 探针](/Users/bytedance/Documents/nowork/codex-kanban-plugin/scripts/probe-desktop-ipc.mjs)
- [独立复测结果](/Users/bytedance/Documents/nowork/codex-kanban-plugin/docs/research/no-restart-evidence/ipc-probe.json)
- [App Tools 三次状态快照聚合](/Users/bytedance/Documents/nowork/codex-kanban-plugin/docs/research/no-restart-evidence/mcp-snapshots.json)
- [研究环境与范围](/Users/bytedance/Documents/nowork/codex-kanban-plugin/docs/research/no-restart-evidence/environment.json)
- [现有 App Tools 探针](/Users/bytedance/Documents/nowork/codex-kanban-plugin/scripts/probe-status-chain.mjs)
