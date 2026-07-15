import { useState } from "react";
import type { ClawAuthStatus, Mailbox } from "../api";
import { usePrefs } from "../i18n";
import { parseServerTime } from "../time";

const PER_PAGE = 10;

type Props = {
  mailboxes: Mailbox[];
  clawAuth: ClawAuthStatus | null;
  suffix: string;
  setSuffix: (value: string) => void;
  onCreate: () => void;
  onDelete: (mailbox: Mailbox) => void;
  onOpen: (mailbox: Mailbox) => void;
  onConfigureRules: (mailbox: Mailbox) => void;
};

function relTime(value: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!value) return "—";
  const date = parseServerTime(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.mAgo", { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t("time.hAgo", { n: h });
  const d = Math.round(h / 24);
  return t("time.dAgo", { n: d });
}

function ruleLabel(mailbox: Mailbox, t: (key: string) => string): string {
  if (mailbox.comm_level === 0) return t("mb.rules.personal");
  if (mailbox.comm_level === 1) return t("mb.rules.internal");
  if (mailbox.comm_level === 2 && mailbox.ext_receive_type === 1) {
    return t("mb.rules.receiveAll");
  }
  if (mailbox.comm_level === 2) return t("mb.rules.external");
  return t("mb.rules.unknown");
}

export function MailboxesView({
  mailboxes,
  clawAuth,
  suffix,
  setSuffix,
  onCreate,
  onDelete,
  onOpen,
  onConfigureRules
}: Props) {
  const { t, lang } = usePrefs();
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(mailboxes.length / PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const shown = mailboxes.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE);
  const rootPrefix = clawAuth?.hasDashboardCookie ? clawAuth.rootPrefix : null;
  const domain = clawAuth?.hasDashboardCookie ? clawAuth.domain : null;
  const canCreate = Boolean(rootPrefix && domain);

  const isPrimary = (m: Mailbox): boolean => {
    if (!clawAuth) return false;
    const rootEmail = clawAuth.rootPrefix && clawAuth.domain
      ? `${clawAuth.rootPrefix}@${clawAuth.domain}`
      : null;
    return (
      m.id === clawAuth.parentMailboxId ||
      m.email === rootEmail
    );
  };

  return (
    <div className="stagger">
      <div className="create-bar">
        <span className="label">{t("mb.forge")}</span>
        <div className="composer">
          {canCreate ? (
            <>
              <span>{rootPrefix}.</span>
              <input
                value={suffix}
                onChange={(event) => setSuffix(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))}
                placeholder={t("mb.placeholder.suffix")}
              />
              <span>@{domain}</span>
            </>
          ) : (
            <span>{t("mb.root.pending")}</span>
          )}
        </div>
        <span className="hint">{t("mb.hint")}</span>
        <button
          className="primary"
          onClick={onCreate}
          disabled={!suffix || !canCreate}
        >
          {t("mb.create")}
        </button>
      </div>

      {mailboxes.length === 0 ? (
        <div className="empty-state">
          <span className="big">{t("mb.empty.head")}</span>
          {t("mb.empty.body")}
        </div>
      ) : (
        <div className="mb-table">
          <div className="mb-row head">
            <span>{t("mb.head.mailbox")}</span>
            <span>{t("mb.head.status")}</span>
            <span>{t("mb.head.rules")}</span>
            <span>{t("mb.head.created")}</span>
            <span style={{ textAlign: "right" }}>{t("mb.head.ops")}</span>
          </div>
          {shown.map((mailbox) => (
            <div className="mb-row" key={mailbox.id}>
              <div className="email-cell">
                <span className="e">{mailbox.email}</span>
                <span className="pref">
                  {isPrimary(mailbox)
                    ? t("mb.row.primary")
                    : t("mb.row.prefix", { p: mailbox.prefix })}
                </span>
              </div>
              <div>
                <span className={`tag ${mailbox.status === "active" ? "ok" : "muted"}`}>
                  <span className={`dot ${mailbox.status === "active" ? "live" : ""}`} />
                  {mailbox.status}
                </span>
              </div>
              <div>
                <span className={`tag ${mailbox.comm_level === 2 && mailbox.ext_receive_type === 1 ? "ok" : "muted"}`}>
                  <span className={`dot ${mailbox.comm_level === 2 && mailbox.ext_receive_type === 1 ? "live" : ""}`} />
                  {ruleLabel(mailbox, t)}
                </span>
              </div>
              <div className="time-cell">{relTime(mailbox.created_at, t)}</div>
              <div className="ops">
                <button onClick={() => onOpen(mailbox)}>{t("mb.row.open")}</button>
                <button
                  onClick={() => onConfigureRules(mailbox)}
                  disabled={!clawAuth?.hasDashboardCookie}
                >
                  {t("mb.row.rules")}
                </button>
                <button
                  className="danger"
                  onClick={() => onDelete(mailbox)}
                  disabled={isPrimary(mailbox)}
                >
                  {t("mb.row.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {mailboxes.length > PER_PAGE && (
        <div className="mb-pager">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
            {lang === "zh" ? "上一页" : "Prev"}
          </button>
          <span className="mb-pager-info">
            {lang === "zh"
              ? `第 ${safePage + 1}/${pageCount} 页 · 共 ${mailboxes.length} 个`
              : `Page ${safePage + 1}/${pageCount} · ${mailboxes.length} total`}
          </span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}>
            {lang === "zh" ? "下一页" : "Next"}
          </button>
        </div>
      )}
    </div>
  );
}
