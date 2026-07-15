import { useEffect, useState } from "react";
import {
  clearCfConfig,
  createCfAlias,
  deleteCfAlias,
  fetchCfAliases,
  fetchCfConfig,
  fetchCfGlobalForwarding,
  fetchCfInbox,
  fetchCfMessage,
  fetchCfProviders,
  fetchCfStatus,
  saveCfConfig,
  sendCfMail,
  updateCfAliasForwarding,
  updateCfGlobalForwarding,
  type CfAlias,
  type CfConfigStatus,
  type CfMessageDetail,
  type CfMessageSummary,
  type TempProviderPublic
} from "../api";
import { useResizableWidth } from "../hooks";
import { usePrefs } from "../i18n";

type Props = {
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
  focusAlias?: string;
  provider?: string;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CfMailView({ onError, onStatus, focusAlias, provider }: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  const [providerId, setProviderId] = useState<string | undefined>(provider);
  const [providers, setProviders] = useState<TempProviderPublic[]>([]);

  const list = useResizableWidth({
    storageKey: "cf.listWidth",
    initial: 360,
    min: 260,
    max: 560
  });

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [domain, setDomain] = useState("");
  const [aliases, setAliases] = useState<CfAlias[]>([]);
  const [selectedAlias, setSelectedAlias] = useState("");
  const [messages, setMessages] = useState<CfMessageSummary[]>([]);
  const [selected, setSelected] = useState<CfMessageDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [newLocal, setNewLocal] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendBusy, setSendBusy] = useState(false);

  const [fwdOpen, setFwdOpen] = useState(false);
  const [fwdBusy, setFwdBusy] = useState(false);
  const [aliasFwdEnabled, setAliasFwdEnabled] = useState(false);
  const [aliasFwdTo, setAliasFwdTo] = useState("");
  const [globalFwdEnabled, setGlobalFwdEnabled] = useState(false);
  const [globalFwdTo, setGlobalFwdTo] = useState("");

  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgStatus, setCfgStatus] = useState<CfConfigStatus | null>(null);
  const [cfgEndpoint, setCfgEndpoint] = useState("");
  const [cfgDomain, setCfgDomain] = useState("");
  const [cfgPassword, setCfgPassword] = useState("");

  function aliasAddress(local: string): string {
    const found = aliases.find((a) => a.local === local);
    if (found?.address) return found.address;
    return domain ? `${local}@${domain}` : local;
  }

  function loadConfig() {
    return fetchCfConfig()
      .then((c) => {
        setCfgStatus(c);
        setCfgEndpoint(c.endpoint);
        setCfgDomain(c.domain);
        setCfgPassword("");
        return c;
      })
      .catch(() => null);
  }

  useEffect(() => {
    setProviderId(provider);
  }, [provider]);

  useEffect(() => {
    fetchCfProviders().then(setProviders).catch(() => {});
  }, []);

  useEffect(() => {
    setSelectedAlias("");
    setSelected(null);
    fetchCfStatus(providerId)
      .then((s) => {
        setConfigured(s.configured);
        setDomain(s.domain ?? "");
        if (s.error) onError(s.error);
      })
      .catch((e) => {
        setConfigured(false);
        onError(errMsg(e));
      });
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  async function handleSaveConfig() {
    const endpoint = cfgEndpoint.trim();
    if (!endpoint) return;
    if (!cfgStatus?.hasPassword && !cfgPassword.trim()) {
      onError(L("请填写管理员密码", "Admin password is required"));
      return;
    }
    setCfgBusy(true);
    try {
      const c = await saveCfConfig({
        endpoint,
        domain: cfgDomain.trim(),
        password: cfgPassword.trim() || undefined
      });
      setCfgStatus(c);
      setCfgPassword("");
      setCfgOpen(false);
      onStatus(L("已保存连接配置", "connection saved"));
      // re-probe provider + reload aliases now that creds may have changed
      const s = await fetchCfStatus();
      setConfigured(s.configured);
      setDomain(s.domain ?? "");
      if (s.configured) loadAliases(false);
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setCfgBusy(false);
    }
  }

  async function handleClearConfig() {
    if (!confirm(L("清除临时邮箱连接配置？", "Clear temp-mail connection config?"))) return;
    setCfgBusy(true);
    try {
      await clearCfConfig();
      onStatus(L("已清除连接配置", "connection cleared"));
      await loadConfig();
      const s = await fetchCfStatus();
      setConfigured(s.configured);
      setDomain(s.domain ?? "");
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setCfgBusy(false);
    }
  }

  async function loadAliases(autoSelect = true) {
    try {
      const items = await fetchCfAliases(providerId);
      setAliases(items);
      if (autoSelect && !selectedAlias && items.length) {
        setSelectedAlias(items[0].local);
      }
    } catch (e) {
      onError(errMsg(e));
    }
  }

  useEffect(() => {
    if (configured) {
      loadAliases();
      fetchCfGlobalForwarding(providerId)
        .then((f) => {
          setGlobalFwdEnabled(!!f.enabled);
          setGlobalFwdTo((f.forwardTo ?? []).join(", "));
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, providerId]);

  useEffect(() => {
    if (focusAlias) setSelectedAlias(focusAlias);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAlias]);

  useEffect(() => {
    const found = aliases.find((a) => a.local === selectedAlias);
    setAliasFwdEnabled(!!found?.forwardEnabled);
    setAliasFwdTo((found?.forwardTo ?? []).join(", "));
  }, [selectedAlias, aliases]);

  function parseRecipients(raw: string): string[] {
    return raw
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function saveAliasForwarding() {
    if (!selectedAlias) return;
    setFwdBusy(true);
    try {
      const items = await updateCfAliasForwarding(
        aliasAddress(selectedAlias),
        aliasFwdEnabled,
        parseRecipients(aliasFwdTo),
        providerId
      );
      setAliases(items);
      onStatus(
        aliasFwdEnabled
          ? L(`已开启 ${selectedAlias} 转发`, `forwarding on for ${selectedAlias}`)
          : L(`已关闭 ${selectedAlias} 转发`, `forwarding off for ${selectedAlias}`)
      );
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setFwdBusy(false);
    }
  }

  async function saveGlobalForwarding() {
    setFwdBusy(true);
    try {
      const f = await updateCfGlobalForwarding(globalFwdEnabled, parseRecipients(globalFwdTo), providerId);
      setGlobalFwdEnabled(!!f.enabled);
      setGlobalFwdTo((f.forwardTo ?? []).join(", "));
      onStatus(
        f.enabled
          ? L("已开启全局转发", "global forwarding on")
          : L("已关闭全局转发", "global forwarding off")
      );
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setFwdBusy(false);
    }
  }

  async function loadInbox(alias = selectedAlias) {
    if (!alias) {
      setMessages([]);
      return;
    }
    setBusy(true);
    try {
      const items = await fetchCfInbox(alias, providerId);
      setMessages(items);
      setSelected(null);
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (selectedAlias) loadInbox(selectedAlias);
    else {
      setMessages([]);
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAlias]);

  async function openMessage(uid: number) {
    try {
      setSelected(await fetchCfMessage(selectedAlias, uid, providerId));
    } catch (e) {
      onError(errMsg(e));
    }
  }

  async function handleCreate() {
    const local = newLocal.trim().toLowerCase();
    if (!local) return;
    try {
      const created = await createCfAlias(local, providerId);
      setNewLocal("");
      onStatus(L(`已创建 ${created.address ?? local}`, `created ${created.address ?? local}`));
      await loadAliases(false);
      setSelectedAlias(created.local ?? local);
    } catch (e) {
      onError(errMsg(e));
    }
  }

  async function handleDeleteAlias(local: string) {
    if (!confirm(L(`删除别名 ${local}？该地址将不可用`, `Delete alias ${local}?`))) return;
    try {
      await deleteCfAlias(local, providerId);
      onStatus(L(`已删除 ${local}`, `deleted ${local}`));
      if (selectedAlias === local) {
        setSelectedAlias("");
        setMessages([]);
        setSelected(null);
      }
      await loadAliases(false);
    } catch (e) {
      onError(errMsg(e));
    }
  }

  async function handleSend() {
    const toList = to
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!selectedAlias || toList.length === 0) return;
    setSendBusy(true);
    try {
      await sendCfMail({
        from: aliasAddress(selectedAlias),
        to: toList,
        subject,
        body,
        html: false,
        provider: providerId
      });
      onStatus(L("已发送", "sent"));
      setComposeOpen(false);
      setTo("");
      setSubject("");
      setBody("");
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSendBusy(false);
    }
  }

  const configForm = (
    <div className="cf-config">
      <div className="cf-config-grid">
        <label>
          <span>{L("接口地址", "API endpoint")}</span>
          <input
            value={cfgEndpoint}
            onChange={(e) => setCfgEndpoint(e.target.value)}
            placeholder="https://edu.002836.xyz/api.php"
            spellCheck={false}
          />
        </label>
        <label>
          <span>{L("邮箱域名", "Mail domain")}</span>
          <input
            value={cfgDomain}
            onChange={(e) => setCfgDomain(e.target.value)}
            placeholder="edu.002836.xyz"
            spellCheck={false}
          />
        </label>
        <label>
          <span>{L("管理员密码", "Admin password")}</span>
          <input
            type="password"
            value={cfgPassword}
            onChange={(e) => setCfgPassword(e.target.value)}
            placeholder={
              cfgStatus?.hasPassword
                ? L("已设置（留空则不变）", "set — leave blank to keep")
                : L("必填", "required")
            }
            autoComplete="new-password"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="cf-config-foot">
        <span className="cf-config-src">
          {cfgStatus?.source === "env"
            ? L("当前来自服务器环境变量", "currently from server env")
            : cfgStatus?.source === "ui"
              ? L("当前来自界面配置（已持久化）", "from UI config (persisted)")
              : L("尚未配置", "not configured yet")}
        </span>
        <span style={{ flex: 1 }} />
        {cfgStatus?.source === "ui" && (
          <button className="danger" onClick={handleClearConfig} disabled={cfgBusy}>
            {L("清除", "Clear")}
          </button>
        )}
        <button className="primary" onClick={handleSaveConfig} disabled={cfgBusy || !cfgEndpoint.trim()}>
          {cfgBusy ? L("保存中…", "saving…") : L("保存连接", "Save")}
        </button>
      </div>
      <div className="cf-config-hint">
        {L(
          "密码仅保存在服务器并随 Supabase 持久化，不会回传浏览器；保存后重启也不丢。",
          "The password is stored server-side and persisted via Supabase; it is never sent back to the browser and survives restarts."
        )}
      </div>
    </div>
  );

  if (configured === null) {
    return <div className="empty-state" style={{ margin: 16 }}>· · ·</div>;
  }

  if (configured === false) {
    return (
      <div className="cf-view">
        <div className="cf-config-empty">
          <div className="cf-config-head">
            <span className="big">{L("连接临时邮箱服务", "Connect a temp-mail provider")}</span>
            <small>
              {L(
                "填入自建临时邮箱（webhostmost / CF）的接口与密码即可启用，无需改服务器环境变量。",
                "Add your self-hosted temp-mail (webhostmost / CF) endpoint and password to enable — no server env edits needed."
              )}
            </small>
          </div>
          {configForm}
        </div>
      </div>
    );
  }

  return (
    <div className="cf-view">
      <div
        className="cf-toolbar"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "0 0 12px" }}
      >
        {providers.length > 1 && (
          <select
            value={providerId ?? providers[0]?.id ?? ""}
            onChange={(e) => setProviderId(e.target.value || undefined)}
            title={L("临时邮箱源", "Temp-mail source")}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.domain ? ` · ${p.domain}` : ""}
              </option>
            ))}
          </select>
        )}
        <select value={selectedAlias} onChange={(e) => setSelectedAlias(e.target.value)}>
          <option value="">{L("— 选择别名 —", "— select alias —")}</option>
          {aliases.map((a) => (
            <option key={a.local} value={a.local}>
              {a.address}
            </option>
          ))}
        </select>
        <button onClick={() => loadInbox()} disabled={!selectedAlias || busy}>
          {busy ? L("加载中…", "loading…") : L("↻ 刷新", "↻ refresh")}
        </button>
        <button
          className="primary"
          onClick={() => setComposeOpen((v) => !v)}
          disabled={!selectedAlias}
        >
          {L("写信", "Compose")}
        </button>
        <button
          className={fwdOpen ? "active" : ""}
          onClick={() => setFwdOpen((v) => !v)}
          title={L("转发设置", "Forwarding")}
        >
          {L("转发", "Forward")}
          {(aliasFwdEnabled || globalFwdEnabled) && <span className="fwd-dot" />}
        </button>
        <button
          className={cfgOpen ? "active" : ""}
          onClick={() => setCfgOpen((v) => !v)}
          title={L("连接设置（主源）", "Connection settings")}
        >
          {L("连接", "Connection")}
        </button>
        {selectedAlias && (
          <button className="danger" onClick={() => handleDeleteAlias(selectedAlias)}>
            {L("删除此别名", "Delete alias")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <input
          value={newLocal}
          onChange={(e) => setNewLocal(e.target.value.replace(/[^a-z0-9]/gi, "").toLowerCase())}
          placeholder={L("新别名前缀", "new alias")}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          style={{ width: 140 }}
        />
        <span style={{ color: "var(--text-4)" }}>@{domain || "…"}</span>
        <button onClick={handleCreate} disabled={!newLocal.trim()}>
          {L("创建 →", "Create →")}
        </button>
      </div>

      {composeOpen && (
        <div className="reply-box" style={{ marginBottom: 14 }}>
          <div className="head">
            <span className="label">
              {L("从", "From")} {aliasAddress(selectedAlias)}
            </span>
          </div>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={L("收件人（逗号/空格分隔）", "to (comma/space separated)")}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={L("主题", "subject")}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={L("正文", "body")} />
          <div className="row">
            <span />
            <button className="primary" onClick={handleSend} disabled={sendBusy || !to.trim()}>
              {sendBusy ? L("发送中…", "sending…") : L("发送", "Send")}
            </button>
          </div>
        </div>
      )}

      {fwdOpen && (
        <div className="fwd-panel" style={{ marginBottom: 14 }}>
          <div className="fwd-row">
            <div className="fwd-head">
              <label className="fwd-toggle">
                <input
                  type="checkbox"
                  checked={aliasFwdEnabled}
                  disabled={!selectedAlias}
                  onChange={(e) => setAliasFwdEnabled(e.target.checked)}
                />
                <span>{L("此别名转发", "This alias")}</span>
              </label>
              <span className="fwd-target mono">
                {selectedAlias ? aliasAddress(selectedAlias) : L("未选别名", "no alias")}
              </span>
            </div>
            <input
              value={aliasFwdTo}
              disabled={!selectedAlias}
              onChange={(e) => setAliasFwdTo(e.target.value)}
              placeholder={L("转发到（逗号分隔，最多 5 个）", "forward to (comma sep, up to 5)")}
            />
            <button onClick={saveAliasForwarding} disabled={fwdBusy || !selectedAlias}>
              {fwdBusy ? L("保存中…", "saving…") : L("保存", "Save")}
            </button>
          </div>
          <div className="fwd-hint">
            {L(
              "收到的邮件会抄送到上面的地址，标题/正文会标明原始收件别名，方便区分来源。",
              "Inbound mail is CC-forwarded to the targets above; the source alias is tagged so you know which mailbox it hit."
            )}
          </div>
          <div className="fwd-divider" />
          <div className="fwd-row">
            <div className="fwd-head">
              <label className="fwd-toggle">
                <input
                  type="checkbox"
                  checked={globalFwdEnabled}
                  onChange={(e) => setGlobalFwdEnabled(e.target.checked)}
                />
                <span>{L("全局转发", "All aliases")}</span>
              </label>
              <span className="fwd-target mono">@{domain || "…"}</span>
            </div>
            <input
              value={globalFwdTo}
              onChange={(e) => setGlobalFwdTo(e.target.value)}
              placeholder={L("整组转发到（逗号分隔，最多 5 个）", "forward whole group to (comma sep, up to 5)")}
            />
            <button onClick={saveGlobalForwarding} disabled={fwdBusy}>
              {fwdBusy ? L("保存中…", "saving…") : L("保存", "Save")}
            </button>
          </div>
        </div>
      )}

      {cfgOpen && <div style={{ marginBottom: 14 }}>{configForm}</div>}

      <div className="inbox" style={{ ["--list-width" as string]: `${list.width}px` }}>
        <section className="list-pane">
          <div className="pane-head">
            <span className="label">{selectedAlias ? aliasAddress(selectedAlias) : L("未选别名", "no alias")}</span>
            <span className="tag muted">{messages.length}</span>
          </div>
          {selectedAlias && messages.length > 0 && (
            <div className="list-search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={L("搜索邮件…", "Search mail…")}
              />
            </div>
          )}
          <div className="scroll">
            {messages.length === 0 && (
              <div className="empty-state" style={{ margin: 16, border: "1px dashed var(--line)" }}>
                <span className="big">{L("暂无邮件", "No mail")}</span>
                {L("选择或创建别名后在此查看收件。", "Pick or create an alias to see inbound mail.")}
              </div>
            )}
            {messages
              .filter((m) => {
                const q = query.trim().toLowerCase();
                if (!q) return true;
                return (
                  (m.subject || "").toLowerCase().includes(q) ||
                  (m.from || "").toLowerCase().includes(q) ||
                  (m.preview || "").toLowerCase().includes(q)
                );
              })
              .map((m) => (
                <button
                  key={m.uid}
                  className={`mail-row ${selected?.uid === m.uid ? "selected" : ""}`}
                  onClick={() => openMessage(m.uid)}
                >
                  <span className="subj">{m.subject || L("（无主题）", "(no subject)")}</span>
                  <span className="time">{(m.date || "").replace(/ 北京时间$/, "").slice(5, 16)}</span>
                  <span className="meta">
                    <span className="from">{m.from || L("未知发件人", "unknown")}</span>
                  </span>
                  {m.preview && <span className="preview">{m.preview}</span>}
                </button>
              ))}
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
          {!selected && (
            <div className="detail-empty">
              <div className="empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m2 7 10 6 10-6" />
                </svg>
              </div>
              {L("选择一封邮件查看", "Pick a message")}
              <small>{L("edu.002836.xyz 别名", "edu.002836.xyz alias")}</small>
            </div>
          )}
          {selected && (
            <>
              <div className="detail-head">
                <div className="crumbs">
                  <span>{L("别名", "ALIAS")}</span>
                  <span style={{ color: "var(--text-4)" }}>/</span>
                  <span className="mono">#{selected.uid}</span>
                </div>
                <h2>{selected.subject || L("（无主题）", "(no subject)")}</h2>
                <dl>
                  <dt>{L("发件", "From")}</dt>
                  <dd className="mono">{selected.from || "—"}</dd>
                  <dt>{L("收件", "To")}</dt>
                  <dd className="mono">{selected.to || aliasAddress(selectedAlias)}</dd>
                  <dt>{L("时间", "At")}</dt>
                  <dd className="mono">{selected.date || "—"}</dd>
                </dl>
              </div>
              <div className="detail-body">
                {selected.bodyHtml ? (
                  <div className="frame">
                    <iframe title="cf-mail-html" srcDoc={selected.bodyHtml} />
                  </div>
                ) : (
                  <pre>{selected.bodyText || selected.preview || L("（空）", "(empty)")}</pre>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
