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
  自动识别: "Discovered automatically",
  "自动识别 · 来源对话": "Auto-detected · Source conversation",
  "从关联对话的最终答复中识别 MR、PR 和本机方案文件。":
    "Find merge requests, pull requests, and local plan files in linked conversations' final replies.",
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
  "每行一个 URL 前缀。助手最终答复中匹配的链接会显示为成果，保留原有 MR 和本地方案识别。":
    "Enter one URL prefix per line. Matching links in final assistant replies appear as artifacts. MR and local plan detection stay enabled.",
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
  实时状态服务未连接: "Live status service disconnected",
  对话列表: "Conversation list",
  "本机 SQLite · 可用": "Local SQLite · Available",
  不可用: "Unavailable",
  "已读 / 未读": "Read / unread",
  "客户端持久化记录 · 可用": "Saved client records · Available",
  "不可用 / 身份不唯一": "Unavailable / ambiguous identity",
  实时运行状态: "Live runtime status",
  "共享 App Server · 已连接": "Shared App Server · Connected",
  等待共享后端: "Waiting for shared backend",
  正在检查数据源: "Checking data sources",
  "。未读记录属于客户端内部格式，兼容性可能随版本变化。":
    ". Unread records use an internal client format that may change between versions.",
  接入实时状态: "Connect live status",
  "在插件目录的独立终端运行以下命令，会自动以共享模式打开 Codex。若 Codex 已打开，按提示退出即可，命令会继续启动。":
    "Run this command in a separate terminal in the plugin directory to open Codex in shared mode. If Codex is already open, quit when prompted so startup can continue.",
  "关闭启动终端不会影响 Codex。退出 Codex 后，后端会自动停止；以后直接点击 Codex 图标即可普通启动。":
    "Closing the launch terminal does not affect Codex. Quitting Codex stops the backend. Open Codex normally from its icon afterward.",
  "仅观察共享后端上的本地对话。未加载、失去连接或没有数据的状态会显示为「状态待同步」，不会猜测任务已经完成。实时连接断开与单条对话执行失败分别显示。":
    "Only local conversations on the shared backend are observed. Unloaded, disconnected or unavailable states show as awaiting sync. Connection failures and individual conversation errors are shown separately.",
  "仅展示本机数据 · 不处理审批 · 不修改 Codex 数据":
    "Local data only · No approval handling · No changes to Codex data",
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
