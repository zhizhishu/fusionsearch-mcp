import { useEffect, useState } from "react";
import {
  updateMailboxCommunicationSettings,
  type CommunicationSettingsInput,
  type Mailbox
} from "../api";
import { usePrefs } from "../i18n";

type CommLevel = 0 | 1 | 2;
type ExternalRange = 0 | 1;

type Props = {
  open: boolean;
  mailbox: Mailbox | null;
  onClose: () => void;
  onSaved: (mailbox: Mailbox, message: string) => void;
  onError: (msg: string) => void;
};

function normalizeCommLevel(value: number | null | undefined): CommLevel {
  return value === 0 || value === 1 || value === 2 ? value : 1;
}

function normalizeRange(value: number | null | undefined, fallback: ExternalRange): ExternalRange {
  return value === 0 || value === 1 ? value : fallback;
}

export function CommunicationRulesDrawer({
  open,
  mailbox,
  onClose,
  onSaved,
  onError
}: Props) {
  const { t } = usePrefs();
  const [commLevel, setCommLevel] = useState<CommLevel>(1);
  const [extReceiveType, setExtReceiveType] = useState<ExternalRange>(1);
  const [extSendType, setExtSendType] = useState<ExternalRange>(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mailbox) return;
    setCommLevel(normalizeCommLevel(mailbox.comm_level));
    setExtReceiveType(normalizeRange(mailbox.ext_receive_type, 1));
    setExtSendType(normalizeRange(mailbox.ext_send_type, 0));
    setBusy(false);
  }, [mailbox]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mailbox) return null;

  async function handleSave() {
    if (!mailbox || busy) return;
    const input: CommunicationSettingsInput = commLevel === 2
      ? { commLevel, extReceiveType, extSendType }
      : { commLevel };

    setBusy(true);
    try {
      const updated = await updateMailboxCommunicationSettings(mailbox.id, input);
      onSaved(updated, t("flash.rules.saved", { email: updated.email }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer rules-drawer" role="dialog" aria-label={t("rules.title")}>
        <header className="head">
          <div>
            <h2>
              {t("rules.title")}
              <span style={{ color: "var(--accent-fg)" }}>.</span>
            </h2>
            <div className="drawer-subtitle">{mailbox.email}</div>
          </div>
          <button className="ghost icon-btn" onClick={onClose} aria-label={t("rules.action.cancel")}>×</button>
        </header>

        <div className="body rules-body">
          <section className="rule-panel">
            <div className="rule-section-title">{t("rules.mode")}</div>
            <div className="rule-options">
              <button
                type="button"
                className={`rule-option ${commLevel === 0 ? "active" : ""}`}
                onClick={() => setCommLevel(0)}
              >
                <span className="rule-dot" />
                <span>
                  <strong>{t("rules.level.personal")}</strong>
                  <small>{t("rules.level.personal.desc")}</small>
                </span>
              </button>
              <button
                type="button"
                className={`rule-option ${commLevel === 1 ? "active" : ""}`}
                onClick={() => setCommLevel(1)}
              >
                <span className="rule-dot" />
                <span>
                  <strong>{t("rules.level.internal")}</strong>
                  <small>{t("rules.level.internal.desc")}</small>
                </span>
              </button>
              <button
                type="button"
                className={`rule-option ${commLevel === 2 ? "active" : ""}`}
                onClick={() => setCommLevel(2)}
              >
                <span className="rule-dot" />
                <span>
                  <strong>{t("rules.level.external")}</strong>
                  <small>{t("rules.level.external.desc")}</small>
                </span>
              </button>
            </div>
          </section>

          {commLevel === 2 && (
            <section className="rule-panel external-panel">
              <div className="rule-section-title">{t("rules.external")}</div>
              <div className="range-grid">
                <div className="range-block">
                  <div className="range-title">{t("rules.receive")}</div>
                  <button
                    type="button"
                    className={`rule-option compact ${extReceiveType === 1 ? "active" : ""}`}
                    onClick={() => setExtReceiveType(1)}
                  >
                    <span className="rule-dot" />
                    <span>{t("rules.range.everyone")}</span>
                  </button>
                  <button
                    type="button"
                    className={`rule-option compact ${extReceiveType === 0 ? "active" : ""}`}
                    onClick={() => setExtReceiveType(0)}
                  >
                    <span className="rule-dot" />
                    <span>{t("rules.range.trusted")}</span>
                  </button>
                </div>
                <div className="range-block">
                  <div className="range-title">{t("rules.send")}</div>
                  <button
                    type="button"
                    className={`rule-option compact ${extSendType === 1 ? "active" : ""}`}
                    onClick={() => setExtSendType(1)}
                  >
                    <span className="rule-dot" />
                    <span>{t("rules.range.everyone")}</span>
                  </button>
                  <button
                    type="button"
                    className={`rule-option compact ${extSendType === 0 ? "active" : ""}`}
                    onClick={() => setExtSendType(0)}
                  >
                    <span className="rule-dot" />
                    <span>{t("rules.range.trusted")}</span>
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>

        <footer className="actions">
          <div className="left">{t("rules.footer")}</div>
          <div className="right">
            <button className="ghost" onClick={onClose} disabled={busy}>{t("rules.action.cancel")}</button>
            <button className="primary" onClick={handleSave} disabled={busy}>
              {busy ? t("rules.action.saving") : t("rules.action.save")}
            </button>
          </div>
        </footer>
      </aside>
    </>
  );
}
