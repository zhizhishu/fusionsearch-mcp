import { useEffect, useState } from "react";
import { fetchListeners, type ListenerSnapshot } from "../api";
import { usePrefs } from "../i18n";
import { parseServerTime } from "../time";

type Props = {
  refreshSignal: number;
  onError: (msg: string) => void;
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

export function ListenersView({ refreshSignal, onError }: Props) {
  const { t } = usePrefs();
  const [items, setItems] = useState<ListenerSnapshot[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const data = await fetchListeners();
      setItems(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, [refreshSignal]);

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <span className="big">{busy ? t("lis.empty.busy") : t("lis.empty.idle")}</span>
        {t("lis.empty.body")}
      </div>
    );
  }

  return (
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
  );
}
