import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { readArtifactRules, saveArtifactRules } from "./client";
import { useI18n } from "./i18n";
import { Button } from "./vendor/affectui/button";
import { ThinkingLoader } from "./vendor/affectui/thinking-loader";

/** 在连接设置中编辑额外成果前缀，保存后通知所有成果视图刷新。 */
export function ArtifactRulesSettings({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void readArtifactRules()
      .then((rules) => {
        if (cancelled) return;
        const text = rules.urlPrefixes.join("\n");
        setValue(text);
        setSavedValue(text);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "读取成果规则失败",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** 每行只接受网页地址前缀，实际规范化和缓存失效由服务统一处理。 */
  async function save() {
    if (saving || loading || savedValue === null) return;
    const urlPrefixes = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const prefix of urlPrefixes) {
      try {
        const url = new URL(prefix);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        setError(
          "每行填写一个有效的 HTTP 或 HTTPS 前缀，不含账号、查询参数或片段。",
        );
        return;
      }
    }
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const rules = await saveArtifactRules({ urlPrefixes });
      const text = rules.urlPrefixes.join("\n");
      setValue(text);
      setSavedValue(text);
      setSaved(true);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存成果规则失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="artifact-rules-settings"
      aria-labelledby="artifact-rules-heading"
      aria-busy={loading || saving}
    >
      <h3 id="artifact-rules-heading">{t("成果解析规则")}</h3>
      <p className="settings-note" id="artifact-rules-description">
        {t(
          "每行一个 URL 前缀。助手最终答复中匹配的链接会显示为成果，保留原有 MR 和本地方案识别。",
        )}
      </p>
      {loading ? (
        <ThinkingLoader phases={[t("读取成果规则")]} size="sm" />
      ) : savedValue === null ? (
        <Button
          variant="secondary"
          onClick={() => setAttempt((current) => current + 1)}
        >
          {t("重试")}
        </Button>
      ) : (
        <>
          <label htmlFor="artifact-url-prefixes">{t("成果 URL 前缀")}</label>
          <textarea
            id="artifact-url-prefixes"
            rows={3}
            value={value}
            disabled={saving}
            placeholder="https://bytedance.sg.larkoffice.com/docx"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-describedby={`artifact-rules-description${error ? " artifact-rules-error" : ""}`}
            aria-invalid={!!error}
            onChange={(event) => {
              setValue(event.target.value);
              setSaved(false);
              setError("");
            }}
          />
          <div className="artifact-rules-actions">
            <Button
              icon={<Save size={14} />}
              loading={saving}
              disabled={value === savedValue || saving}
              onClick={() => void save()}
            >
              {t("保存规则")}
            </Button>
            <span className="settings-note" role="status">
              {saved
                ? t("已保存，正在更新成果缓存。")
                : t("保存后会重新识别已有对话的成果，并缓存到磁盘。")}
            </span>
          </div>
        </>
      )}
      {error && (
        <p
          className="artifact-rules-error"
          id="artifact-rules-error"
          role="alert"
        >
          {t(error)}
        </p>
      )}
    </section>
  );
}
