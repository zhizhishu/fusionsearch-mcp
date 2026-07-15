import { useEffect, useState } from "react";
import {
  fetchSentMail,
  fetchSentMails,
  type SentMailDetail,
  type SentMailSummary
} from "../api";
import { useResizableWidth } from "../hooks";
import { plural, usePrefs } from "../i18n";
import { parseMailTime } from "../time";

type Props = {
  /** Single mailbox filter; empty string = all mailboxes (统一发件箱). */
  selectedMailbox: string;
  /** Whether Claw send is available (gates the compose button). */
  canCompose: boolean;
  onCompose: () => void;
  onError: (msg: string) => void;
};

function fmtTime(value: string | null): string {
  if (!value) return "—";
  const date = parseMailTime(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "2-digit" });
}

function fmtFull(value: string | null): string {
  if (!value) return "—";
  const date = parseMailTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function recipientLine(detail: SentMailDetail): string {
  return detail.to.length ? detail.to.join(", ") : "—";
}

export function SentView({ selectedMailbox, canCompose, onCompose, onError }: Props) {
  const { t } = usePrefs();
  const list = useResizableWidth({
    storageKey: "sent.listWidth",
    initial: 360,
    min: 260,
    max: 560
  });

  const [items, setItems] = useState<SentMailSummary[]>([]);
  const [partialErrors, setPartialErrors] = useState<Array<{ mailbox: string; error: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [detail, setDetail] = useState<SentMailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const unified = !selectedMailbox;

  async function load() {
    setLoading(true);
    try {
      const data = await fetchSentMails(selectedMailbox || undefined, 50);
      setItems(data.items);
      setPartialErrors(data.errors ?? []);
      if (selectedKey && !data.items.some((m) => `${m.mailbox_email}/${m.id}` === selectedKey)) {
        setSelectedKey("");
        setDetail(null);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedKey("");
    setDetail(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMailbox]);

  async function openDetail(mail: SentMailSummary) {
    const key = `${mail.mailbox_email}/${mail.id}`;
    setSelectedKey(key);
    setDetailLoading(true);
    try {
      const data = await fetchSentMail(mail.mailbox_email, mail.id);
      setDetail(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="sent-view">
      <div className="sent-toolbar">
        <span className="sent-toolbar-label">
          {unified ? t("sent.list.all") : selectedMailbox}
        </span>
        <span className="sent-toolbar-actions">
          <span className="tag muted">{plural(t, "sent.list.count", items.length)}</span>
          <button onClick={load} disabled={loading}>
            {loading ? t("sent.loading") : t("toolbar.refresh")}
          </button>
          <button className="primary" onClick={onCompose} disabled={!canCompose}>
            {t("toolbar.compose")}
          </button>
        </span>
      </div>

      {partialErrors.length > 0 && (
        <div className="sent-partial-note">
          {t("sent.partialError", { n: partialErrors.length })}
        </div>
      )}

      <div
        className="inbox"
        style={{ ["--list-width" as string]: `${list.width}px` }}
      >
        <section className="list-pane">
          <div className="pane-head">
            <span className="label">{t("sent.pane.label")}</span>
          </div>
          <div className="scroll">
            {items.length === 0 && !loading && (
              <div className="empty-state" style={{ margin: 16, border: "1px dashed var(--line)" }}>
                <span className="big">{t("sent.empty.head")}</span>
                {t("sent.empty.body")}
              </div>
            )}
            {items.map((mail) => {
              const key = `${mail.mailbox_email}/${mail.id}`;
              return (
                <button
                  key={key}
                  className={`mail-row ${selectedKey === key ? "selected" : ""}`}
                  onClick={() => openDetail(mail)}
                >
                  <span className="subj">{mail.subject || t("inbox.subject.empty")}</span>
                  <span className="time">{fmtTime(mail.date)}</span>
                  <span className="meta">
                    <span className="from">{mail.from || mail.mailbox_email}</span>
                    {unified && <span className="sent-mb-tag">{mail.mailbox_email}</span>}
                  </span>
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
          aria-label="resize sent list"
        />

        <section className="detail-pane">
          {!detail && !detailLoading && (
            <div className="detail-empty">
              {t("sent.detail.empty.head")}
              <small>{t("sent.detail.empty.hint")}</small>
            </div>
          )}
          {detailLoading && (
            <div className="detail-empty">{t("sent.loading")}</div>
          )}
          {detail && !detailLoading && (
            <>
              <div className="detail-head">
                <div className="crumbs">
                  <span>{t("sent.detail.crumb")}</span>
                  <span style={{ color: "var(--text-4)" }}>/</span>
                  <span className="mono">{detail.mailbox_email}</span>
                  {detail.hasAttachments ? (
                    <span className="tag ok">{t("inbox.detail.attachments")}</span>
                  ) : null}
                </div>
                <h2>{detail.subject || t("inbox.subject.empty")}</h2>
                <dl>
                  <dt>{t("inbox.detail.from")}</dt>
                  <dd className="mono">{detail.from.join(", ") || detail.mailbox_email}</dd>
                  <dt>{t("inbox.detail.to")}</dt>
                  <dd className="mono">{recipientLine(detail)}</dd>
                  {detail.cc.length > 0 && (
                    <>
                      <dt>{t("compose.field.cc")}</dt>
                      <dd className="mono">{detail.cc.join(", ")}</dd>
                    </>
                  )}
                  <dt>{t("inbox.detail.at")}</dt>
                  <dd className="mono">{fmtFull(detail.date)}</dd>
                </dl>
              </div>

              <div className="detail-body">
                {detail.html ? (
                  <div className="frame">
                    <iframe title="sent-html" sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={detail.html} />
                  </div>
                ) : (
                  <pre>{detail.text || t("inbox.body.empty")}</pre>
                )}
              </div>

              {detail.attachments.length > 0 && (
                <div className="attachments">
                  <span className="label">
                    {plural(t, "inbox.attCount", detail.attachments.length)}
                  </span>
                  {detail.attachments.map((item) => (
                    <span key={item.id} className="sent-att-name">
                      {item.filename || item.id}
                      {item.size ? (
                        <span style={{ color: "var(--text-4)" }}>
                          {" · "}{Math.ceil(item.size / 1024)} {t("size.kb")}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
