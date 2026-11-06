import type { Thread } from "../shared/types";
import { useI18n } from "./i18n";
import "./thread-composer.css";

export type ComposerState = {
  text: string;
  id: string;
  busy: boolean;
  error: string;
  sent: boolean;
};
export const emptyComposer: ComposerState = {
  text: "",
  id: "",
  busy: false,
  error: "",
  sent: false,
};

export function ThreadComposer({
  thread,
  state,
  onChange,
  onSend,
}: {
  thread: Thread;
  state: ComposerState;
  onChange: (text: string) => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {thread.latestReply && (
        <div className="card-reply">
          <strong>{t("最近回复")}</strong>
          <p>{thread.latestReply}</p>
        </div>
      )}
      <details
        className="card-composer"
        data-conversation-id={thread.id}
        open={!!state.text || state.busy || state.sent || !!state.error}
      >
        <summary>{t(state.text ? "继续编辑消息" : "发送消息")}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
          aria-busy={state.busy}
        >
          <textarea
            aria-label={t("给此会话发消息")}
            placeholder={t("输入要发送到此会话的内容…")}
            value={state.text}
            maxLength={20000}
            disabled={state.busy || !thread.canSend}
            onChange={(event) => onChange(event.target.value)}
          />
          {!thread.canSend && (
            <p>{t("会话尚未加载或连接已断开，请先打开原对话。")}</p>
          )}
          <button
            type="submit"
            disabled={state.busy || !thread.canSend || !state.text.trim()}
          >
            {t(state.busy ? "正在发送…" : "发送到会话")}
          </button>
          {state.sent && <p role="status">{t("消息已由原会话接收")}</p>}
          {state.error && (
            <p className="confirmation-error" role="alert">
              {t(state.error)}
            </p>
          )}
        </form>
      </details>
    </>
  );
}
