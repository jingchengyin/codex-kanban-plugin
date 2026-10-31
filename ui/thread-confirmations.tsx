import { useRef, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import type { Confirmation, ConfirmationReply } from "../shared/confirmations";
import { replyToConfirmation } from "./client";
import { useI18n } from "./i18n";
import "./thread-confirmations.css";

/** 卡片内展示原生请求和异步问题，按钮独立于对话跳转区域。 */
export function ThreadConfirmations({
  requests,
  onSubmitted,
}: {
  requests: Confirmation[];
  onSubmitted: () => void;
}) {
  return requests.map((request) => (
    <ConfirmationForm
      key={request.id}
      request={request}
      onSubmitted={onSubmitted}
    />
  ));
}

/** 只提交用户选中的决策；提交期间禁止重复操作，成功后等待快照移除请求。 */
function ConfirmationForm({
  request,
  onSubmitted,
}: {
  request: Confirmation;
  onSubmitted: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const sending = useRef(false);
  const asyncInput = request.kind === "asyncUserInput";
  /** 只回传用户明确提交的内容，完成后刷新原对话状态。 */
  async function submit(reply: ConfirmationReply) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await replyToConfirmation(reply);
      setSubmitted(true);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("确认提交失败，请重试。"),
      );
    } finally {
      setBusy(false);
      sending.current = false;
      onSubmitted();
    }
  }
  const identity = { id: request.id, threadId: request.threadId };
  const sendAnswers = (values: Record<string, string>) =>
    submit({
      ...identity,
      answers: Object.fromEntries(
        request.questions.map((q) => [q.id, { answers: [values[q.id]] }]),
      ),
    });
  if (submitted)
    return (
      <div className="card-confirmation" role="status">
        <Check size={14} /> {t(asyncInput ? "答案已发送" : "已提交确认")}
      </div>
    );
  return (
    <section
      className="card-confirmation"
      aria-label={t(asyncInput ? "待回答问题" : "待确认内容")}
      aria-busy={busy}
    >
      <strong>
        {t(
          request.kind === "command"
            ? "执行操作"
            : request.kind === "fileChange"
              ? "修改文件"
              : asyncInput
                ? "需要你的回答"
                : "需要你的选择",
        )}
      </strong>
      {request.reason && <p>{request.reason}</p>}
      {request.command && (
        <pre className="confirmation-command">{request.command}</pre>
      )}
      {request.cwd && (
        <p className="confirmation-cwd">
          {t("工作目录")}：{request.cwd}
        </p>
      )}
      {request.details && (
        <details>
          <summary>{t("请求详情")}</summary>
          <pre>{request.details}</pre>
        </details>
      )}
      {request.kind === "userInput" || asyncInput ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendAnswers(answers);
          }}
        >
          {request.questions.map((q) => (
            <fieldset key={q.id} disabled={busy}>
              <legend>{q.question}</legend>
              <div className="confirmation-options">
                {q.options.map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    aria-pressed={answers[q.id] === option.label}
                    onClick={() => {
                      const next = { ...answers, [q.id]: option.label };
                      setAnswers(next);
                      // 异步问题先选答案再提交，原生单题保留点击即提交的行为。
                      if (!asyncInput && request.questions.length === 1)
                        void sendAnswers(next);
                    }}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
              {(q.allowOther || !q.options.length) && (
                <label className="confirmation-answer">
                  <span>
                    {t(q.options.length ? "或输入其他答案" : "你的答案")}
                  </span>
                  {asyncInput && !q.isSecret ? (
                    <textarea
                      rows={3}
                      value={answers[q.id] ?? ""}
                      maxLength={20000}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q.id]: e.target.value })
                      }
                    />
                  ) : (
                    <input
                      type={q.isSecret ? "password" : "text"}
                      value={answers[q.id] ?? ""}
                      maxLength={20000}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q.id]: e.target.value })
                      }
                    />
                  )}
                </label>
              )}
            </fieldset>
          ))}
          {(asyncInput ||
            request.questions.length > 1 ||
            request.questions.some(
              (q) => q.allowOther || !q.options.length,
            )) && (
            <button
              className="confirmation-accept"
              type="submit"
              disabled={
                busy || request.questions.some((q) => !answers[q.id]?.trim())
              }
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              {t("提交答案")}
            </button>
          )}
        </form>
      ) : (
        <div className="confirmation-actions">
          {request.decisions.map((decision) => (
            <button
              type="button"
              key={decision}
              disabled={busy}
              className={decision === "accept" ? "confirmation-accept" : ""}
              onClick={() => void submit({ ...identity, decision })}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : decision === "accept" ? (
                <Check size={14} />
              ) : (
                <X size={14} />
              )}
              {t(
                decision === "accept"
                  ? "允许一次"
                  : decision === "decline"
                    ? "拒绝"
                    : "取消本轮",
              )}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="confirmation-error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}
