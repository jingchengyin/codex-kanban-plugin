import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Pencil,
  X,
} from "lucide-react";
import type { Confirmation } from "../shared/confirmations";
import { useI18n } from "./i18n";
import "./async-question.css";

/** 按原生卡片逐题作答，草稿留在本地，最后只提交非空答案。 */
export function AsyncQuestionCard({
  request,
  busy,
  submitted,
  error,
  onSubmit,
}: {
  request: Confirmation;
  busy: boolean;
  submitted: boolean;
  error: string;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const card = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const question = request.questions[index];
  const last = index === request.questions.length - 1;
  const answer = answers[question.id] ?? "";
  const disabled = busy || advancing;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(120, field.scrollHeight)}px`;
  }, [index, answer, dismissed]);

  /** 跳过的题目不代填答案；全部跳过时只收起卡片。 */
  function advance(values: Record<string, string>) {
    if (!last) {
      setIndex(index + 1);
      card.current?.focus();
      return;
    }
    const filled = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim()),
    );
    if (Object.keys(filled).length) void onSubmit(filled);
    else setDismissed(true);
  }

  /** 保留短暂选中反馈后前进，末题沿用原生行为直接发送。 */
  function select(value: string) {
    if (disabled) return;
    const next = { ...answers, [question.id]: value };
    setAnswers(next);
    setAdvancing(true);
    timer.current = setTimeout(() => {
      setAdvancing(false);
      advance(next);
    }, 180);
  }

  function skip() {
    if (disabled) return;
    const next = { ...answers, [question.id]: "" };
    setAnswers(next);
    advance(next);
  }

  if (submitted)
    return (
      <div className="async-question-card async-question-status" role="status">
        <Check size={14} /> {t("答案已发送")}
      </div>
    );

  return (
    <section
      ref={card}
      tabIndex={-1}
      className={`async-question-card${dismissed ? " is-dismissed" : ""}`}
      aria-label={t("待回答问题")}
      aria-busy={disabled}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || disabled || dismissed) return;
        if (event.key === "Escape") {
          event.preventDefault();
          skip();
          return;
        }
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        const option = Number(event.key) - 1;
        if (/^[1-9]$/.test(event.key) && question.options[option]) {
          event.preventDefault();
          select(question.options[option].label);
        }
      }}
    >
      <header className="async-question-header">
        <span className="async-question-heading">
          <CircleHelp size={14} aria-hidden="true" /> {t("问题")}
        </span>
        {dismissed ? (
          <button
            className="async-question-skip"
            type="button"
            onClick={() => {
              setIndex(0);
              setDismissed(false);
            }}
          >
            {t("继续回答")}
          </button>
        ) : (
          <nav className="async-question-navigation" aria-label={t("切换问题")}>
            <button
              className="async-question-icon-button"
              type="button"
              aria-label={t("上一题")}
              disabled={disabled || index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="async-question-count" aria-live="polite">
              {index + 1} of {request.questions.length}
            </span>
            <button
              className="async-question-icon-button"
              type="button"
              aria-label={t("下一题")}
              disabled={disabled || last}
              onClick={() => setIndex(index + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <button
              className="async-question-icon-button"
              type="button"
              aria-label={t("关闭问题")}
              disabled={disabled}
              onClick={skip}
            >
              <X size={15} />
            </button>
          </nav>
        )}
      </header>
      {!dismissed && (
        <>
          <h4 className="async-question-title" id={titleId}>
            {question.question}
          </h4>
          <div
            className="async-question-options"
            role="group"
            aria-labelledby={titleId}
          >
            {question.options.map((option, optionIndex) => (
              <button
                key={option.label}
                className="async-question-option"
                type="button"
                aria-pressed={answer === option.label}
                disabled={disabled}
                onClick={() => select(option.label)}
              >
                <span
                  className="async-question-option-number"
                  aria-hidden="true"
                >
                  {optionIndex + 1}
                </span>
                <span className="async-question-option-label">
                  {option.label}
                </span>
              </button>
            ))}
          </div>
          <form
            className="async-question-footer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && answer.trim()) advance(answers);
            }}
          >
            <label className="async-question-composer">
              <Pencil size={15} aria-hidden="true" />
              <textarea
                ref={composer}
                rows={1}
                aria-label={t("自行撰写回复")}
                placeholder={t(
                  question.options.length ? "或自行撰写回复" : "自行撰写回复",
                )}
                maxLength={20000}
                value={answer}
                disabled={disabled}
                onChange={(event) =>
                  setAnswers({ ...answers, [question.id]: event.target.value })
                }
                onKeyDown={(event) => {
                  // 中文输入法确认候选时不触发下一步，Shift+Enter 仍可换行。
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!disabled && answer.trim()) advance(answers);
                  }
                }}
              />
            </label>
            <div className="async-question-actions">
              <button
                className="async-question-skip"
                type="button"
                disabled={disabled}
                onClick={skip}
              >
                {t("跳过")}
              </button>
              <button
                className="async-question-next"
                type="submit"
                disabled={disabled || !answer.trim()}
              >
                {busy && <LoaderCircle size={14} className="spin" />}
                {t(last ? "发送" : "下一步")}
              </button>
            </div>
          </form>
          {error && (
            <p className="async-question-error" role="alert">
              {t(error)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
