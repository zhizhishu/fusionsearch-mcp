import { useEffect } from "react";
import type { ListenerSnapshot } from "../api";
import { usePrefs } from "../i18n";
import { parseServerTime } from "../time";

type Props = {
  open: boolean;
  busy: boolean;
  items: ListenerSnapshot[];
  onClose: () => void;
  onRefresh: () => void;
};

function fmt(value?: string | null): string {
  if (!value) return "—";
  const date = parseServerTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusToTag(status: string): "ok" | "muted" | "danger" {
  if (status === "running" || status === "open") return "ok";
  if (status === "error" || status === "closed") return "danger";
  return "muted";
}

export function ListenersDrawer({ open, busy, items, onClose, onRefresh }: Props) {
  const { t } = usePrefs();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t("lis.drawer.title")}>
        <header className="head">
          <div>
            <h2>
              {t("lis.drawer.title")}
              <span style={{ color: "var(--accent-fg)" }}>.</span>
            </h2>
          </div>
          <button className="ghost icon-btn" onClick={onClose} aria-label={t("lis.drawer.close")}>×</button>
        </header>

        <div className="body lis-drawer-body">
          {items.length === 0 ? (
            <div className="empty-state">
              <span className="big">{busy ? t("lis.empty.busy") : t("lis.empty.idle")}</span>
              {t("lis.empty.body")}
            </div>
          ) : (
            <div className="listeners-grid stagger">
              {items.map((item) => {
                const tag = statusToTag(item.status);
                const live = item.status === "running" || item.status === "open";
                return (
                  <div className="listener-card" key={item.email}>
                    <div className="top">
                      <div className="em">{item.email}</div>
                      <span className={`tag ${tag}`}>
                        <span className={`dot ${live ? "live" : tag === "danger" ? "danger" : ""}`} />
                        {item.status}
                      </span>
                    </div>
                    <dl>
                      <dt>{t("lis.field.started")}</dt>
                      <dd>{fmt(item.startedAt)}</dd>
                      <dt>{t("lis.field.lastEvt")}</dt>
                      <dd>{fmt(item.lastEventAt)}</dd>
                      {item.error ? (
                        <>
                          <dt>{t("lis.field.error")}</dt>
                          <dd style={{ color: "var(--danger)" }}>{item.error}</dd>
                        </>
                      ) : null}
                    </dl>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="actions">
          <div className="left" />
          <div className="right">
            <button onClick={onRefresh} disabled={busy}>
              {busy ? t("lis.empty.busy") : t("lis.drawer.refresh")}
            </button>
            <button className="ghost" onClick={onClose}>{t("lis.drawer.close")}</button>
          </div>
        </footer>
      </aside>
    </>
  );
}
