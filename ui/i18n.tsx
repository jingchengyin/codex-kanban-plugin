import { createContext, useContext, useEffect, useState } from "react";

export type Language = "EN" | "CN";

const english: Record<string, string> = {
  "搜索标题、输入或事项…": "Search titles, input, or work items…",
  排序方式: "Sort conversations",
  优先处理: "Action priority",
  布局方式: "Conversation layout",
  自动布局: "Auto layout",
  看板: "Board",
  紧凑列表: "Compact list",
  当前没有需要关注的对话: "No conversations need attention",
  "可调整搜索或筛选条件。": "Try changing the search or filters.",
  "从本次连接首次观察到等待开始计时，不代表问题实际发出时间。":
    "Timed from the first observed wait on this connection, not when the question was sent.",
  "已观察到等待 {duration}": "Observed waiting for {duration}",
  "打开原对话查看异常并处理。":
    "Open the conversation to review and resolve the error.",
  运行详情: "Run details",
  监听关系: "Monitoring relationships",
  "监听 {title}": "Monitoring {title}",
  "被 {title} 监听": "Monitored by {title}",
  加入事项: "Add to work item",
  "打开事项：{title}": "Open work item: {title}",
  "将对话加入事项：{title}": "Add conversation to work item: {title}",
  搜索已有事项: "Search existing work items",
  已关联: "Linked",
  "正在关联…": "Linking…",
  加入: "Add",
  "没有匹配的事项，可在下方新建。": "No matching work items. Create one below.",
  "还没有工作事项，可在下方新建。": "No work items yet. Create one below.",
  新事项名称: "New work item name",
  事项图标: "Work item icon",
  选择事项图标: "Choose work item icon",
  终端: "Terminal",
  分支: "Branch",
  合并请求: "Pull request",
  提交: "Commit",
  处理器: "Processor",
  工作流: "Workflow",
  网络: "Network",
  云服务: "Cloud",
  服务器: "Server",
  硬盘: "Hard drive",
  容器: "Container",
  组件: "Components",
  地球: "Globe",
  搜索: "Search",
  扫描: "Scan",
  过滤: "Filter",
  设置: "Settings",
  调节: "Adjustments",
  计时器: "Timer",
  时钟: "Clock",
  日历: "Calendar",
  检查清单: "Checklist",
  完成: "Completed",
  圆点: "Dot",
  里程碑: "Milestone",
  待办列表: "To-do list",
  公文包: "Briefcase",
  建筑: "Building",
  团队: "Team",
  用户: "User",
  讨论: "Discussion",
  邮件: "Mail",
  通知: "Notification",
  公告: "Announcement",
  钢笔: "Pen",
  画笔: "Paintbrush",
  图片: "Image",
  相机: "Camera",
  视频: "Video",
  音乐: "Music",
  耳机: "Headphones",
  爱心: "Heart",
  星标: "Star",
  星光: "Sparkles",
  奖杯: "Trophy",
  宝石: "Gem",
  叶子: "Leaf",
  咖啡: "Coffee",
  图标颜色: "Icon color",
  "选择颜色：{name}": "Choose color: {name}",
  蓝色: "Blue",
  紫色: "Purple",
  粉色: "Pink",
  红色: "Red",
  橙色: "Orange",
  金色: "Gold",
  绿色: "Green",
  青绿色: "Teal",
  青色: "Cyan",
  灰蓝色: "Slate",
  搜索图标: "Search icons",
  "搜索图标…": "Search icons…",
  没有匹配的图标: "No matching icons",
  "选择图标：{name}": "Choose icon: {name}",
  火箭: "Rocket",
  目标: "Target",
  灵感: "Idea",
  代码: "Code",
  缺陷: "Bug",
  工具: "Tools",
  图层: "Layers",
  实验: "Experiment",
  文档: "Book",
  图表: "Chart",
  盾牌: "Shield",
  数据库: "Database",
  调色板: "Palette",
  指南针: "Compass",
  闪电: "Lightning",
  旗帜: "Flag",
  新建并关联: "Create and link",
  "关联事项失败，请重试。": "Unable to link the work item. Try again.",
  无法打开成果链接: "Unable to open deliverable link",
  "成果链接需使用 HTTP、HTTPS 或 Codex 地址。":
    "Deliverable links must use HTTP, HTTPS, or Codex addresses.",
  "宿主未允许打开成果链接。": "The host blocked opening this deliverable link.",
  "实时启动器目前仅支持 macOS。":
    "The live launcher currently supports macOS only.",
  "已打开实时启动器。若 Codex 已运行，请在准备好后按 ⌘Q 完全退出，启动器会自动继续。":
    "The live launcher is open. If Codex is running, quit it with ⌘Q when you are ready. The launcher will then continue automatically.",
  工作台视图: "Workspace views",
  工作事项: "Work items",
  工作回顾: "Work review",
  待开始: "Planned",
  进行中: "In progress",
  待验收: "Ready for review",
  已验收: "Accepted",
  "把相关对话放在一起，记录验收清单和成果。":
    "Group related conversations and track acceptance checks and deliverables.",
  新建事项: "New work item",
  搜索事项: "Search work items",
  "搜索事项…": "Search work items…",
  事项状态: "Work item status",
  全部状态: "All statuses",
  "正在读取工作事项…": "Reading work items…",
  "正在读取工作事项与关联成果…": "Reading work items and deliverables…",
  "正在更新关联成果…": "Updating linked deliverables…",
  "请刷新后重试。": "Refresh to try again.",
  没有匹配的事项: "No matching work items",
  创建第一个工作事项: "Create your first work item",
  "调整搜索或状态筛选。": "Change your search or status filter.",
  "例如，把实现、测试和发布说明的对话关联到同一次发布。":
    "For example, group implementation, testing, and release notes for one release.",
  "{count} 条关联对话": "{count} linked conversations",
  "{count} 条运行中": "{count} running",
  "{count} 条待处理": "{count} need your input",
  "验收 {done}/{total}": "Checks {done}/{total}",
  未加载的关联对话: "Linked conversation unavailable",
  无法打开对话: "Unable to open conversation",
  "另有 {count} 条关联对话": "{count} more linked conversations",
  "确认删除事项？": "Delete this work item?",
  取消: "Cancel",
  确认删除: "Delete item",
  "删除事项：{title}": "Delete work item: {title}",
  编辑事项: "Edit work item",
  "编辑事项：{title}": "Edit work item: {title}",
  关闭编辑: "Close editor",
  修改后自动保存: "Changes save automatically",
  "正在保存…": "Saving…",
  已自动保存: "Saved automatically",
  "自动保存失败，修改仍保留在此处。":
    "Auto-save failed. Your changes are still here.",
  "请填写事项名称后自动保存。": "Enter a work item name to save automatically.",
  "请补全成果名称后自动保存。":
    "Complete the deliverable name to save automatically.",
  "请填写有效的成果地址后自动保存。":
    "Enter a valid deliverable URL to save automatically.",
  取消编辑: "Cancel editing",
  事项名称: "Work item name",
  "例如：发布插件新版本": "For example: release a new plugin version",
  预期结果与说明: "Expected outcome and notes",
  "事项状态由你更新；对话空闲不代表已经验收。":
    "You update the work item status. An idle conversation does not mean the work has been accepted.",
  关联对话: "Linked conversations",
  搜索可关联的对话: "Search conversations to link",
  "搜索标题或项目…": "Search by title or project…",
  没有匹配的对话: "No matching conversations",
  "请搜索以缩小对话范围。": "Search to narrow the conversation list.",
  验收清单: "Acceptance checklist",
  "移除验收项：{text}": "Remove acceptance check: {text}",
  新验收项: "New acceptance check",
  "添加验收条件…": "Add an acceptance check…",
  添加验收项: "Add acceptance check",
  成果链接: "Deliverable links",
  成果: "Deliverables",
  收起: "Less",
  自动识别: "Discovered automatically",
  "自动识别 · 来源对话": "Auto-detected · Source conversation",
  "从关联对话的最终答复中识别 GitHub PR、GitLab MR、计划模式文档和本地方案文件。":
    "Find GitHub PRs, GitLab MRs, plan-mode documents, and local plan files in linked conversations' final replies.",
  "暂未发现自动成果；对话产生新的最终答复后会自动更新。":
    "No deliverables found yet. New final replies are checked automatically.",
  "关联对话后，会自动查找其中的 MR、PR 和方案文件。":
    "Link conversations to find their merge requests, pull requests, and plan files.",
  "{count} 条关联对话的成果暂不可读。":
    "Deliverables from {count} linked conversations are unavailable.",
  补充链接: "Add links manually",
  无法打开成果: "Unable to open deliverable",
  "当前入口不支持 Codex 文件预览，请从来源对话查看文件。":
    "This view does not support Codex file previews. Open the source conversation to view this file.",
  读取成果失败: "Unable to read deliverables",
  "正在识别成果…": "Finding deliverables…",
  "未找到方案文件，请刷新成果后重试。":
    "Plan file not found. Refresh the deliverables and try again.",
  "直接打开方案文件目前仅支持 macOS，请从来源对话查看文件。":
    "Opening plan files directly is supported on macOS. Use the source conversation to view this file.",
  "支持网页、PR 和 Codex 对话链接。":
    "Supports web pages, pull requests, and Codex conversation links.",
  "成果名称 {count}": "Deliverable name {count}",
  成果名称: "Deliverable name",
  "成果地址 {count}": "Deliverable URL {count}",
  "移除成果链接 {count}": "Remove deliverable link {count}",
  添加成果链接: "Add deliverable link",
  保存事项: "Save work item",
  工作事项已保存: "Work item saved",
  工作事项已删除: "Work item deleted",
  读取工作事项失败: "Unable to read work items",
  保存工作事项失败: "Unable to save work item",
  删除工作事项失败: "Unable to delete work item",
  "只统计有用户输入记录的主对话回合，包含已归档对话。":
    "Includes turns with recorded user input in main conversations, including archived conversations.",
  "展示用户输入、运行状态和用量。": "Shows user input, run status, and usage.",
  "打开来源对话，不定位到具体回合。":
    "Open the source conversation without jumping to a specific turn.",
  "打开来源对话：{title}，不定位到具体回合。":
    "Open source conversation: {title}, without jumping to a specific turn.",
  时间范围: "Date range",
  今天: "Today",
  "最近 7 天": "Last 7 days",
  "最近 30 天": "Last 30 days",
  全部项目: "All projects",
  未归属项目: "No project",
  "正在读取历史回合…": "Reading turn history…",
  历史回合: "Recorded turns",
  "{count} 轮已结束": "{count} completed",
  "已知 Token 用量": "Known token usage",
  "{count} 轮用量缺失": "Usage missing for {count} turns",
  回合累计耗时: "Combined turn duration",
  "{count} 轮耗时缺失": "Duration missing for {count} turns",
  中断回合: "Interrupted turns",
  "{count} 轮记录未结束": "{count} turns without an end record",
  "Token 包含输入、缓存输入和输出，不代表账单费用。耗时为各回合相加，并行回合会重叠。":
    "Tokens include input, cached input, and output. They do not represent billed cost. Durations are added across turns, including overlapping parallel turns.",
  "{count} 条对话的历史日志不可读，统计可能不完整。":
    "History logs for {count} conversations could not be read. Totals may be incomplete.",
  已归档: "Archived",
  本轮已结束: "Turn completed",
  已中断: "Interrupted",
  记录未结束: "No end record",
  这段时间没有回合记录: "No recorded turns in this date range",
  "尝试扩大时间范围或选择其他项目。":
    "Try a wider date range or another project.",
  "已检查 {count} 条对话": "Checked {count} conversations",
  读取工作回顾失败: "Unable to read work review",
  "读取工作回顾超时，请重试。": "Reading work review timed out. Try again.",
  "部分工作日志不可用，汇总仅包含成功读取的记录。":
    "Some work logs are unavailable. Totals include only records that could be read.",
  "无法读取本机 Codex 工作记录，请检查 CODEX_HOME 或客户端版本。":
    "Unable to read local Codex work records. Check CODEX_HOME or the client version.",
  "工作事项不存在，请刷新后重试。":
    "This work item no longer exists. Refresh and try again.",
  工作台服务暂不可用: "Workspace service unavailable",
  打开实时启动器: "Open live launcher",
  打开兼容启动器: "Open compatibility launcher",
  无法打开实时启动器: "Unable to open live launcher",
  "点击按钮即可打开启动器，无需输入命令。若 Codex 已打开，请按提示用 ⌘Q 完全退出，启动器会自动继续。":
    "Open the launcher with this button. No command is needed. If Codex is already open, quit it with ⌘Q when prompted. The launcher will then continue automatically.",
  "也可在插件目录的独立终端运行：":
    "You can also run this in a separate terminal in the plugin directory:",
  对话看板: "Conversation board",
  全部对话: "All conversations",
  需要关注: "Needs attention",
  对话范围: "Conversation scope",
  搜索对话: "Search conversations",
  "搜索对话…": "Search conversations…",
  筛选: "Filters",
  连接与数据源: "Connection & data sources",
  成果解析规则: "Artifact parsing rules",
  "成果 URL 前缀": "Artifact URL prefixes",
  "每行一个 URL 前缀。助手最终答复中匹配的链接会显示为成果。默认支持 GitHub PR、GitLab MR 和计划模式文档解析，也支持本地方案文件识别。":
    "Enter one URL prefix per line. Matching links in final assistant replies appear as artifacts. GitHub PRs, GitLab MRs, plan-mode documents, and local plan files are supported by default.",
  "保存后会重新识别已有对话的成果，并缓存到磁盘。":
    "Saving reparses artifacts in existing conversations and caches the results on disk.",
  "已保存，正在更新成果缓存。": "Saved. Updating the artifact cache.",
  "每行填写一个有效的 HTTP 或 HTTPS 前缀，不含账号、查询参数或片段。":
    "Enter one valid HTTP or HTTPS prefix per line, without credentials, query parameters or fragments.",
  读取成果规则: "Reading artifact rules",
  读取成果规则失败: "Unable to read artifact rules",
  保存成果规则失败: "Unable to save artifact rules",
  保存规则: "Save rules",
  已连接: "Connected",
  连接中: "Connecting",
  未连接: "Disconnected",
  刷新: "Refresh",
  暂时无法刷新状态: "Unable to refresh status",
  "。当前显示最后一次快照。": ". Showing the last snapshot.",
  筛选对话: "Filter conversations",
  运行状态: "Runtime status",
  阅读状态: "Read status",
  未读: "Unread",
  已读: "Read",
  未知: "Unknown",
  项目: "Project",
  对话类型: "Conversation type",
  普通对话: "Conversations",
  "子 Agent": "Subagent",
  "其他 / 未知": "Other / unknown",
  收起筛选: "Hide filters",
  清除全部: "Clear all",
  "移除 {label}": "Remove {label}",
  "另有 {count} 项：{labels}": "{count} more: {labels}",
  "{count} 项筛选": "{count} selected",
  正在读取本地对话: "Reading local conversations",
  "正在同步最近的对话状态…": "Syncing recent conversations…",
  "{count} 条对话": "{count} conversations",
  更新于: "Updated",
  重置筛选: "Reset filters",
  最近发消息: "Latest user message",
  最近一次用户发消息的时间: "Time of the latest user message",
  发消息时间未知: "Message time unknown",
  标题排序: "Sort by title",
  需要你处理: "Needs your input",
  等待确认或回复: "Waiting for approval or a reply",
  正在运行: "Running",
  任务正在进行: "Tasks are in progress",
  未读对话会显示在这里: "Unread conversations appear here",
  暂时空闲: "Idle",
  当前没有运行中的回合: "No turns are running",
  执行异常: "Error",
  查看原对话处理: "Open the conversation for details",
  状态待同步: "Awaiting sync",
  未加载或实时状态不可用: "Not loaded or live status unavailable",
  等待操作确认: "Waiting for approval",
  待确认内容: "Pending confirmation",
  待回答问题: "Pending questions",
  问题: "Question",
  切换问题: "Navigate questions",
  上一题: "Previous question",
  下一题: "Next question",
  关闭问题: "Close question",
  继续回答: "Continue answering",
  自行撰写回复: "Write your own response",
  或自行撰写回复: "Or write your own response",
  跳过: "Skip",
  下一步: "Next",
  发送: "Send",
  执行操作: "Run operation",
  修改文件: "Change files",
  需要你的选择: "Your choice is needed",
  需要你的回答: "Your answer is needed",
  工作目录: "Working directory",
  请求详情: "Request details",
  允许一次: "Allow once",
  拒绝: "Decline",
  取消本轮: "Cancel turn",
  提交答案: "Submit answer",
  或输入其他答案: "Or enter another answer",
  你的答案: "Your answer",
  已提交确认: "Confirmation submitted",
  答案已发送: "Answer sent",
  "确认提交失败，请重试。": "Could not submit confirmation. Please try again.",
  "该请求已处理或已失效，请刷新看板。":
    "This request was handled or expired. Refresh the board.",
  "此请求需在原对话处理。": "Open the conversation to handle this request.",
  "通过新版实时启动器启动 Codex 后，可在看板处理支持的确认请求。":
    "Start Codex with the updated live launcher to handle supported requests here.",
  "确认连接暂不可用，请在原对话处理。":
    "The confirmation connection is unavailable. Handle this request in its conversation.",
  "确认发送未完成，请在原对话核对结果，避免重复提交。":
    "The reply could not be confirmed. Check its result in the conversation before submitting again.",
  "确认结果尚未同步，请在原对话核对，避免重复提交。":
    "The confirmation result has not synced. Check the conversation before submitting again.",
  "本机对话与事项 · 确认操作仅在点击后提交":
    "Local conversations and work items · Confirmations are sent only when you click",
  等待你的回复: "Waiting for your reply",
  "打开对话：{title}": "Open conversation: {title}",
  阅读状态未知: "Read status unknown",
  本轮输入: "Current turn input",
  最近一轮输入: "Latest turn input",
  上轮输入: "Previous turn input",
  未获取到用户输入: "User input unavailable",
  未输入文字: "No text entered",
  当前模型: "Current model",
  模型未知: "Unknown model",
  思考等级: "Reasoning effort",
  思考: "Reasoning",
  当前或最近一轮的协作模式: "Collaboration mode of the current or latest turn",
  计划模式: "Plan mode",
  默认模式: "Default mode",
  模式未知: "Unknown mode",
  目标模式: "Goal mode",
  "目标 · 已暂停": "Goal · Paused",
  "目标 · 已阻塞": "Goal · Blocked",
  "目标 · 用量受限": "Goal · Usage limited",
  "目标 · 预算用尽": "Goal · Budget exhausted",
  "目标 · 已完成": "Goal · Complete",
  目标未开启: "Goal off",
  目标状态未知: "Goal status unknown",
  本轮: "Current turn",
  最近一轮: "Latest turn",
  上轮: "Previous turn",
  "本轮累计 {count} tokens，包含输入、缓存输入和输出":
    "Turn total: {count} tokens, including input, cached input and output",
  "本轮累计 token 数据不可用": "Turn token total unavailable",
  "这一轮从开始到结束的累计耗时；运行时持续更新，断线后暂停计时":
    "Total turn duration; updates while running and pauses when disconnected",
  "Token 未知": "Tokens unknown",
  耗时未知: "Duration unknown",
  "{count}秒": "{count}s",
  "{minutes}分{seconds}秒": "{minutes}m {seconds}s",
  "{hours}时{minutes}分": "{hours}h {minutes}m",
  "{days}天{hours}时": "{days}d {hours}h",
  对话尚未加载: "Conversation not loaded",
  实时状态未知: "Live status unknown",
  本地对话: "Local conversation",
  刚刚: "Just now",
  "{count} 分钟前": "{count}m ago",
  "{count} 小时前": "{count}h ago",
  "{count} 天前": "{count}d ago",
  未读来源待选择: "Choose an unread source",
  暂无未读对话: "No unread conversations",
  暂无对话: "No conversations",
  选择当前客户端对应的记录: "Select the record for your current client",
  选择未读来源: "Choose unread source",
  "再显示 {count} 条": "Show {count} more",
  关闭: "Close",
  共享状态服务已连接: "Shared status service connected",
  实时状态已连接: "Live status connected",
  "当前 Codex 桌面": "Current Codex desktop",
  实时状态服务未连接: "Live status service disconnected",
  对话列表: "Conversation list",
  "本机 SQLite · 可用": "Local SQLite · Available",
  不可用: "Unavailable",
  "已读 / 未读": "Read / unread",
  "客户端持久化记录 · 可用": "Saved client records · Available",
  "不可用 / 身份不唯一": "Unavailable / ambiguous identity",
  实时运行状态: "Live runtime status",
  "共享 App Server · 已连接": "Shared App Server · Connected",
  "桌面对话 · 已连接": "Desktop conversations · Connected",
  等待共享后端: "Waiting for shared backend",
  等待桌面连接: "Waiting for desktop connection",
  "未连接 Codex 桌面，实时状态暂不可用。":
    "Codex desktop is disconnected. Live status is unavailable.",
  "Codex 桌面状态协议不兼容，实时状态暂不可用。":
    "This desktop version is incompatible with live status connection.",
  "桌面状态连接已关闭。": "The desktop status connection has closed.",
  "桌面状态连接已断开。": "The desktop status connection was lost.",
  "该对话的桌面连接已失效，请刷新后重试。":
    "This conversation's desktop connection is no longer valid. Refresh and try again.",
  "对话原窗口连接已失效，请刷新后重试。":
    "The conversation's original window is no longer connected. Refresh and try again.",
  "Codex 桌面请求超时，请刷新后确认结果。":
    "The desktop request timed out. Refresh to check its result.",
  "Codex 桌面处理请求失败。": "Codex desktop could not handle the request.",
  "看板暂不支持此类桌面操作。":
    "This desktop action is not supported on the board.",
  正在检查数据源: "Checking data sources",
  "。未读记录属于客户端内部格式，兼容性可能随版本变化。":
    ". Unread records use an internal client format that may change between versions.",
  接入实时状态: "Connect live status",
  实时连接: "Live connection",
  兼容连接: "Compatibility connection",
  "正常打开 Codex 后，直接打开看板即可同步，无需重启客户端。":
    "Open Codex normally, then open the board to sync. No client restart is required.",
  "按当前分页、项目和搜索范围同步本地对话。未加载或无法同步的对话显示为「状态待同步」，离开看板或隐藏面板后停止观察。":
    "Sync local conversations for the current page, project, and search. Unloaded or unavailable conversations remain Awaiting sync. Observation ends when you leave the board or hide the panel.",
  "仅在桌面直连不可用时使用。兼容启动器会以共享模式打开 Codex；若客户端已运行，需要按提示完全退出。":
    "Use this only when direct desktop connection is unavailable. The compatibility launcher opens Codex in shared mode. If the client is already running, quit it when prompted.",
  "连接断开后保留最后快照，并取消实时状态标记；对话执行失败会单独显示。":
    "Keep the last snapshot after disconnection and mark it as no longer live. Conversation errors are shown separately.",
  "在插件目录的独立终端运行以下命令，会自动以共享模式打开 Codex。若 Codex 已打开，按提示退出即可，命令会继续启动。":
    "Run this command in a separate terminal in the plugin directory to open Codex in shared mode. If Codex is already open, quit when prompted so startup can continue.",
  "关闭启动终端不会影响 Codex。退出 Codex 后，后端会自动停止；以后直接点击 Codex 图标即可普通启动。":
    "Closing the launch terminal does not affect Codex. Quitting Codex stops the backend. Open Codex normally from its icon afterward.",
  "仅观察共享后端上的本地对话。未加载、失去连接或没有数据的状态会显示为「状态待同步」，不会猜测任务已经完成。实时连接断开与单条对话执行失败分别显示。":
    "Only local conversations on the shared backend are observed. Unloaded, disconnected or unavailable states show as awaiting sync. Connection failures and individual conversation errors are shown separately.",
  未读记录来源: "Unread record source",
  "自动（优先普通启动记录）": "Automatic (prefer normal startup records)",
  "{count} 条未读": "{count} unread",
  本地记录: "Local record",
  普通启动记录: "Normal startup records",
  "自动优先复用普通启动记录，未读数只统计看板中的普通对话。来源无法自动确定时，请手动选择。":
    "Automatically prefers normal startup records. Unread counts include only regular conversations on the board. Select a source manually if it cannot be determined automatically.",
  账号信息缺失或存在多个账号:
    "Account information is missing or multiple accounts exist",
  本地主机数据不可用: "Local host data unavailable",
  "所选记录已失效或账号已变化，请重新选择":
    "The selected record is no longer valid or the account has changed. Select it again",
  "本地主机记录不唯一，请在连接设置中明确选择；不会自动合并":
    "Multiple local host records exist. Select one in connection settings; records are not merged automatically",
  "使用你明确选择的本地记录；当前登录身份未经独立确认":
    "Using your selected local record; the signed-in identity has not been independently verified",
  "复用普通启动的未读记录；当前登录身份未经独立确认":
    "Using unread records from normal startup; the signed-in identity has not been independently verified",
  "本机唯一持久化账号与主机；当前登录身份未经独立确认":
    "Using the only saved local account and host; the signed-in identity has not been independently verified",
  未读信息不可用: "Unread information unavailable",
  "无法读取本机 Codex 对话索引，请检查 CODEX_HOME 或客户端版本。":
    "Unable to read the local Codex conversation index. Check CODEX_HOME or the client version.",
  插件状态服务暂不可用: "Plugin status service unavailable",
  本地状态服务暂不可用: "Local status service unavailable",
  收到的状态数据格式不受支持: "Unsupported status data format",
  "对话 ID 格式无效": "Invalid conversation ID",
  "宿主未允许跳转，请通过 Codex 对话列表打开。":
    "The host blocked navigation. Open the conversation from the Codex conversation list.",
};

export type TranslationValues = Record<string, string | number>;

export function translate(
  language: Language,
  text: string,
  values: TranslationValues = {},
) {
  const template = language === "EN" ? (english[text] ?? text) : text;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

const LanguageContext = createContext<{
  language: Language;
  setLanguage: (language: Language) => void;
}>({ language: "EN", setLanguage: () => {} });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("taskboard:language") ?? '"EN"',
      ) === "CN"
        ? "CN"
        : "EN";
    } catch {
      return "EN";
    }
  });
  useEffect(() => {
    document.documentElement.lang = language === "CN" ? "zh-CN" : "en";
    document.title =
      language === "CN" ? "Codex Taskboard · 对话看板" : "Codex Taskboard";
    try {
      localStorage.setItem("taskboard:language", JSON.stringify(language));
    } catch {
      /* The language still works when storage is unavailable. */
    }
  }, [language]);
  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n() {
  const { language, setLanguage } = useContext(LanguageContext);
  return {
    language,
    setLanguage,
    locale: language === "CN" ? "zh-CN" : "en-US",
    t: (text: string, values?: TranslationValues) =>
      translate(language, text, values),
  };
}
