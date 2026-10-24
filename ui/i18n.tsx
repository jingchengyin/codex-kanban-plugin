import { createContext, useContext, useEffect, useState } from "react";

export type Language = "EN" | "CN";

const english: Record<string, string> = {
  对话看板: "Conversation board",
  全部对话: "All conversations",
  需要关注: "Needs attention",
  对话范围: "Conversation scope",
  搜索对话: "Search conversations",
  "搜索对话…": "Search conversations…",
  筛选: "Filters",
  连接与数据源: "Connection & data sources",
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
  "{count} 条对话": "{count} conversations",
  更新于: "Updated",
  重置筛选: "Reset filters",
  最近更新: "Recently updated",
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
  "在本项目目录的独立终端运行以下命令，会自动以共享模式打开 Codex。若 Codex 已打开，按提示退出即可，命令会继续启动。保持终端运行。":
    "Run this command in a separate terminal in the project directory to open Codex in shared mode. If Codex is already open, quit when prompted so startup can continue. Keep the terminal running.",
  "退出本次 Codex 后，命令会自动清理自己创建的后端。以后直接点击 Codex 图标即可普通启动，无需恢复命令。":
    "When this Codex session exits, the command cleans up the backend it created. Open Codex normally from its icon afterward; no restore command is needed.",
  "仅观察共享后端上的本地对话。未加载、失去连接或没有数据的状态会显示为「状态待同步」，不会猜测任务已经完成。实时连接断开与单条对话执行失败分别显示。":
    "Only local conversations on the shared backend are observed. Unloaded, disconnected or unavailable states show as awaiting sync. Connection failures and individual conversation errors are shown separately.",
  "仅展示本机数据 · 不处理审批 · 不修改 Codex 数据":
    "Local data only · No approval handling · No changes to Codex data",
  未读记录来源: "Unread record source",
  "自动（仅有唯一记录时启用）": "Automatic (only when one record exists)",
  "{count} 条未读": "{count} unread",
  本地记录: "Local record",
  "多份本地记录时，请选择与你当前客户端对应的记录；无法确认时保持自动，未读将显示为未知。":
    "When multiple local records exist, select the one for your current client. If unsure, leave it on automatic; unread status will show as unknown.",
  账号信息缺失或存在多个账号:
    "Account information is missing or multiple accounts exist",
  本地主机数据不可用: "Local host data unavailable",
  "所选记录已失效或账号已变化，请重新选择":
    "The selected record is no longer valid or the account has changed. Select it again",
  "本地主机记录不唯一，请在连接设置中明确选择；不会自动合并":
    "Multiple local host records exist. Select one in connection settings; records are not merged automatically",
  "使用你明确选择的本地记录；当前登录身份未经独立确认":
    "Using your selected local record; the signed-in identity has not been independently verified",
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
