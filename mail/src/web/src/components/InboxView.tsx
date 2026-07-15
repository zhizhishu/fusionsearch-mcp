import { useState } from "react";
import { apiUrl, deleteMail, type MailDetail, type MailSummary } from "../api";
import { useResizableWidth } from "../hooks";
import { plural, usePrefs } from "../i18n";
import { parseMailTime, parseServerTime } from "../time";

type Props = {
  selectedMailbox: string;
  mails: MailSummary[];
  selectedMail: MailDetail | null;
  onSelectMail: (id: number) => void;
  onRefresh: () => void;
  onDeleted: (id: number, msg: string) => void;
  onReply: (mail: MailDetail) => void;
  onError: (msg: string) => void;
  adminPassword: string;
};

function fmtTime(value: string | null, source: "mail" | "db" = "db"): string {
  if (!value) return "—";
  const date = source === "mail" ? parseMailTime(value) : parseServerTime(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "2-digit" });
}

function fmtFull(value: string | null, source: "mail" | "db" = "db"): string {
  if (!value) return "—";
  const date = source === "mail" ? parseMailTime(value) : parseServerTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function mailTime(mail: MailSummary | MailDetail): { value: string | null; source: "mail" | "db" } {
  return mail.received_at
    ? { value: mail.received_at, source: "mail" }
    : { value: mail.created_at, source: "db" };
}

// 给邮件 HTML 注入一套排版 + 柔纸底，避免渲染成"纯白板/白色404"
function wrapEmailHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0}
  body{
    padding:24px 28px;
    font-family:"Nunito","PingFang SC","Microsoft YaHei",-apple-system,system-ui,"Segoe UI",sans-serif;
    font-size:14.5px; line-height:1.75; color:#283142;
    background:#ecf0f6; /* 柔纸底，不刺眼纯白 */
    word-break:break-word; overflow-wrap:anywhere;
  }
  img{max-width:100%;height:auto;border-radius:10px}
  a{color:#3a72b8;text-decoration:underline;text-underline-offset:2px}
  blockquote{margin:10px 0;padding:4px 0 4px 14px;border-left:3px solid #c9d2e0;color:#5b6675}
  p{margin:0 0 12px} pre{white-space:pre-wrap;word-break:break-word}
  table{max-width:100%} hr{border:none;border-top:1px solid #e2e7f0;margin:16px 0}
</style></head><body>${html}</body></html>`;
}

export function InboxView({
  selectedMailbox,
  mails,
  selectedMail,
  onSelectMail,
  onRefresh,
  onDeleted,
  onReply,
  onError,
  adminPassword
}: Props) {
  const { t, lang } = usePrefs();
  const list = useResizableWidth({
    storageKey: "inbox.listWidth",
    initial: 360,
    min: 260,
    max: 560
  });
  const [query, setQuery] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function handleDeleteMail() {
    if (!selectedMail || !confirm(t("inbox.confirm.delete"))) return;
    setDeleteBusy(true);
    try {
      await deleteMail(selectedMail.id);
      onDeleted(selectedMail.id, t("flash.mail.deleted"));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div
      className="inbox"
      style={{ ["--list-width" as string]: `${list.width}px` }}
    >
      <section className="list-pane">
        <div className="pane-head">
          <span className="label">{selectedMailbox || t("inbox.list.noMailbox")}</span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="tag muted">{plural(t, "inbox.list.count", mails.length)}</span>
            <button onClick={onRefresh}>{t("toolbar.refresh")}</button>
          </span>
        </div>
        {mails.length > 0 && (
          <div className="list-search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={lang === "zh" ? "搜索邮件…" : "Search mail…"}
            />
          </div>
        )}
        <div className="scroll">
          {mails.length === 0 && (
            <div className="empty-state" style={{ margin: 16, border: "1px dashed var(--line)" }}>
              <span className="big">{t("inbox.list.empty.head")}</span>
              {t("inbox.list.empty.body")}
            </div>
          )}
          {mails
            .filter((mail) => {
              const q = query.trim().toLowerCase();
              if (!q) return true;
              return (
                (mail.subject || "").toLowerCase().includes(q) ||
                (mail.source || "").toLowerCase().includes(q) ||
                (mail.text || "").toLowerCase().includes(q)
              );
            })
            .map((mail) => {
              const time = mailTime(mail);
              const preview = (mail.text || "").replace(/\s+/g, " ").trim();
              return (
                <button
                  key={mail.id}
                  className={`mail-row ${selectedMail?.id === mail.id ? "selected" : ""}`}
                  onClick={() => onSelectMail(mail.id)}
                >
                  <span className="subj">{mail.subject || t("inbox.subject.empty")}</span>
                  <span className="time">{fmtTime(time.value, time.source)}</span>
                  <span className="meta">
                    <span className="from">{mail.source || t("inbox.unknownSender")}</span>
                    {!selectedMailbox && mail.mailbox_email ? <span className="mbx-tag">{mail.mailbox_email.split("@")[0]}</span> : null}
                    {mail.has_attachments ? <span className="att">◇</span> : null}
                  </span>
                  {preview && <span className="preview">{preview}</span>}
                </button>
              );
            })}
        </div>
      </section>

      <div
        className={`list-resizer ${list.dragging ? "dragging" : ""}`}
        onPointerDown={list.onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="resize mail list"
      />

      <section className="detail-pane">
        {!selectedMail && (
          <div className="detail-empty">
            <div className="empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m2 7 10 6 10-6" />
              </svg>
            </div>
            {t("inbox.empty.head")}
            <small>{t("inbox.empty.hint")}</small>
          </div>
        )}
        {selectedMail && (() => {
          const time = mailTime(selectedMail);
          return (
          <>
            <div className="detail-head">
              <div className="crumbs">
                <span>{t("inbox.detail.thread")}</span>
                <span style={{ color: "var(--text-4)" }}>/</span>
                <span className="mono">#{selectedMail.id}</span>
                {selectedMail.has_attachments ? (
                  <span className="tag ok">{t("inbox.detail.attachments")}</span>
                ) : null}
                <button className="primary detail-reply" onClick={() => onReply(selectedMail)}>
                  {lang === "zh" ? "回复" : "Reply"}
                </button>
                <button
                  className="danger detail-delete"
                  onClick={handleDeleteMail}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? t("inbox.detail.deleting") : t("inbox.detail.delete")}
                </button>
              </div>
              <h2>{selectedMail.subject || t("inbox.subject.empty")}</h2>
              <dl>
                <dt>{t("inbox.detail.from")}</dt>
                <dd className="mono">{selectedMail.source || "—"}</dd>
                <dt>{t("inbox.detail.to")}</dt>
                <dd className="mono">{selectedMail.address || selectedMail.mailbox_email}</dd>
                <dt>{t("inbox.detail.at")}</dt>
                <dd className="mono">{fmtFull(time.value, time.source)}</dd>
              </dl>
            </div>

            <div className="detail-body">
              {selectedMail.html ? (
                <div className="frame">
                  <iframe
                    title="mail-html"
                    sandbox="allow-same-origin"
                    referrerPolicy="no-referrer"
                    srcDoc={wrapEmailHtml(selectedMail.html)}
                    onLoad={(e) => {
                      const f = e.currentTarget;
                      try {
                        const h = f.contentDocument?.body?.scrollHeight;
                        if (h) f.style.height = `${Math.min(h + 28, 2000)}px`;
                      } catch { /* 跨域兜底：保持 min-height */ }
                    }}
                  />
                </div>
              ) : (
                <pre>{selectedMail.text || t("inbox.body.empty")}</pre>
              )}
            </div>

            {selectedMail.attachments.length > 0 && (
              <div className="attachments">
                <span className="label">
                  {plural(t, "inbox.attCount", selectedMail.attachments.length)}
                </span>
                {selectedMail.attachments.map((item) => (
                  <a
                    key={item.id}
                    href={apiUrl(`/api/mails/${selectedMail.id}/attachments/${encodeURIComponent(item.provider_part_id)}?token=${encodeURIComponent(adminPassword)}`)}
                  >
                    {item.filename || item.provider_part_id}
                    {item.size ? (
                      <span style={{ color: "var(--text-4)" }}>
                        {" · "}{Math.ceil(item.size / 1024)} {t("size.kb")}
                      </span>
                    ) : null}
                  </a>
                ))}
              </div>
            )}

          </>
          );
        })()}
      </section>
    </div>
  );
}
