import { useEffect, useState } from "react";
import {
  createCfAlias,
  deleteCfAlias,
  fetchCfAliases,
  fetchCfStatus,
  fetchSecrets,
  type CfAlias,
  type TempProviderPublic
} from "../api";
import { usePrefs } from "../i18n";

type SaveInput = { name: string; type: "php" | "cf"; endpoint: string; domain: string; password: string };
type Patch = { name?: string; type?: "php" | "cf"; endpoint?: string; domain?: string; password?: string };

type Props = {
  /** undefined => add-a-new-category mode */
  provider?: TempProviderPublic;
  onAdd: (input: SaveInput) => void | Promise<void>;
  onUpdate: (id: string, patch: Patch) => void | Promise<void>;
  onDelete: (id: string) => void;
  /** open the temp-mail read/send view focused on this alias */
  onOpenInbox: (local: string) => void;
  /** open the temp-mail read/send view for the whole source */
  onOpenSource: () => void;
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
  /** notify parent (so the sidebar groups can refresh) */
  onAliasesChanged?: () => void;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ProviderManageCard({
  provider,
  onAdd,
  onUpdate,
  onDelete,
  onOpenInbox,
  onOpenSource,
  onError,
  onStatus,
  onAliasesChanged
}: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const addMode = !provider;

  // ---- source-settings form ----
  const [editing, setEditing] = useState(addMode);
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState<"php" | "cf">(provider?.type ?? "cf");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
  const [domain, setDomain] = useState(provider?.domain ?? "");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | "loading" | null>(null);

  // ---- addresses (aliases) under this source ----
  const [aliases, setAliases] = useState<CfAlias[]>([]);
  const [newLocal, setNewLocal] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);

  // reset everything when the selected source changes
  useEffect(() => {
    setEditing(!provider);
    setName(provider?.name ?? "");
    setType(provider?.type ?? "cf");
    setEndpoint(provider?.endpoint ?? "");
    setDomain(provider?.domain ?? "");
    setPassword("");
    setShowPwd(false);
    setTest(null);
    setNewLocal("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  useEffect(() => {
    if (!provider) {
      setAliases([]);
      return;
    }
    let alive = true;
    fetchCfAliases(provider.id)
      .then((items) => alive && setAliases(items))
      .catch((e) => alive && onError(errMsg(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  async function reloadAliases() {
    if (!provider) return;
    try {
      setAliases(await fetchCfAliases(provider.id));
    } catch (e) {
      onError(errMsg(e));
    }
  }

  async function revealPwd() {
    if (showPwd) {
      setShowPwd(false);
      return;
    }
    if (!provider) return;
    try {
      const s = await fetchSecrets();
      const hit = s.temp.find((x) => x.id === provider.id);
      if (hit?.password) {
        setPassword(hit.password);
        setShowPwd(true);
      } else onError(L("该源未设密码", "no password set"));
    } catch (e) {
      onError(errMsg(e));
    }
  }

  async function saveSource() {
    if (!name.trim() || !endpoint.trim()) return;
    setBusy(true);
    try {
      if (addMode) {
        if (!password.trim()) {
          onError(L("新源必须填管理员密码", "Password required for a new source"));
          return;
        }
        await onAdd({ name: name.trim(), type, endpoint: endpoint.trim(), domain: domain.trim(), password });
      } else if (provider) {
        const patch: Patch = { name: name.trim(), type, endpoint: endpoint.trim(), domain: domain.trim() };
        if (password.trim()) patch.password = password;
        await onUpdate(provider.id, patch);
        setEditing(false);
        setPassword("");
        setShowPwd(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function testConn() {
    if (!provider) return;
    setTest("loading");
    try {
      const s = await fetchCfStatus(provider.id);
      setTest(s.error ? { ok: false, msg: s.error } : { ok: true, msg: s.domain || "ok" });
    } catch (e) {
      setTest({ ok: false, msg: errMsg(e) });
    }
  }

  async function createAddress() {
    if (!provider) return;
    const local = newLocal.trim().toLowerCase();
    if (!local) return;
    setAliasBusy(true);
    try {
      const created = await createCfAlias(local, provider.id);
      onStatus(L(`已建址 ${created.address ?? local}`, `created ${created.address ?? local}`));
      setNewLocal("");
      await reloadAliases();
      onAliasesChanged?.();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setAliasBusy(false);
    }
  }

  async function removeAddress(local: string) {
    if (!provider) return;
    if (!confirm(L(`删除地址 ${local}？该地址将不可用`, `Delete address ${local}?`))) return;
    try {
      await deleteCfAlias(local, provider.id);
      onStatus(L(`已删除 ${local}`, `deleted ${local}`));
      await reloadAliases();
      onAliasesChanged?.();
    } catch (e) {
      onError(errMsg(e));
    }
  }

  const dom = provider?.domain || domain;

  const sourceForm = (
    <div className="settings-form src-form">
      <label>
        <span>{L("名字", "Name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("如 always", "e.g. always")} />
      </label>
      <label>
        <span>{L("类型", "Type")}</span>
        <select value={type} onChange={(e) => setType(e.target.value as "php" | "cf")}>
          <option value="cf">cf — cloudflare_temp_email</option>
          <option value="php">php — {L("自建 PHP", "self-hosted PHP")}</option>
        </select>
      </label>
      <label className="wide">
        <span>{L("接口地址", "Endpoint")}</span>
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          spellCheck={false}
          placeholder={type === "php" ? "https://x.xyz/api.php" : "https://x.xyz"}
        />
      </label>
      <label>
        <span>{L("域名", "Domain")}</span>
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="x.xyz" spellCheck={false} />
      </label>
      <label>
        <span>
          {type === "cf"
            ? L("管理员 auth（x-admin-auth）", "Admin auth (x-admin-auth)")
            : L("管理员密码（X-Admin-Password）", "Admin password (X-Admin-Password)")}
          {!addMode && provider?.hasPassword && (
            <button type="button" className="mini-link" onClick={revealPwd}>
              {showPwd ? L("🙈 遮罩", "🙈 hide") : L("👁 显示当前", "👁 show")}
            </button>
          )}
        </span>
        <input
          type={showPwd ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={
            addMode
              ? L("必填", "required")
              : provider?.hasPassword
                ? L("已设 · 留空不改", "set · blank = keep")
                : L("未设", "not set")
          }
        />
      </label>
      <div className="settings-form-foot">
        {type === "cf" && (
          <span className="settings-note">
            {L(
              "cf 走 cloudflare_temp_email admin API（x-admin-auth）：endpoint=实例根地址、密码=admin 密码。",
              "cf = cloudflare_temp_email admin API (x-admin-auth)."
            )}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!addMode && <button onClick={() => setEditing(false)}>{L("取消", "Cancel")}</button>}
        <button className="primary" onClick={saveSource} disabled={busy || !name.trim() || !endpoint.trim()}>
          {busy ? L("保存中…", "saving…") : addMode ? L("添加源", "Add source") : L("保存修改", "Save")}
        </button>
      </div>
    </div>
  );

  // ---- add-a-category mode ----
  if (addMode) {
    return (
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <h3>{L("添加邮箱大类目（临时邮箱源）", "Add a mailbox category (temp source)")}</h3>
            <p>
              {L(
                "接入一个 php 自建 / cloudflare_temp_email 后端，作为一个新的邮箱大类目，在右上角切换。",
                "Connect a php / cloudflare_temp_email backend as a new mailbox category (switch it top-right)."
              )}
            </p>
          </div>
        </div>
        {sourceForm}
      </div>
    );
  }

  if (!provider) return null;

  return (
    <div className="prov-manage stagger">
      {/* ---- source header ---- */}
      <div className="settings-card">
        <div className="settings-head">
          <div className="prov-id">
            <span className={`src-type ${provider.type}`}>{provider.type === "cf" ? "cloudflare" : "php"}</span>
            <div className="src-main">
              <span className="src-domain">{provider.domain || provider.name}</span>
              <span className="src-meta">
                {provider.name} · {provider.endpoint.replace(/^https?:\/\//, "")}
              </span>
            </div>
            <span className={`tag ${provider.hasPassword ? "ok" : "muted"}`}>
              <span className={`dot ${provider.hasPassword ? "live" : ""}`} />
              {provider.hasPassword ? L("密钥已设", "key set") : L("无密钥", "no key")}
            </span>
            {test && test !== "loading" && (
              <span className={`tag ${test.ok ? "ok" : "danger-tag"}`} title={test.msg}>
                {test.ok ? L("连通", "ok") : L("失败", "fail")}
              </span>
            )}
          </div>
          <div className="prov-ops">
            <button onClick={testConn} disabled={test === "loading"}>
              {test === "loading" ? "…" : L("测试", "Test")}
            </button>
            <button onClick={onOpenSource}>{L("收发", "Mail")}</button>
            <button className={editing ? "active" : ""} onClick={() => setEditing((v) => !v)}>
              {editing ? L("取消", "Cancel") : L("编辑源", "Edit")}
            </button>
            <button className="danger" onClick={() => onDelete(provider.id)}>
              {L("删除源", "Delete")}
            </button>
          </div>
        </div>
        {editing && sourceForm}
      </div>

      {/* ---- create address ---- */}
      <div className="create-bar" style={{ marginTop: 16 }}>
        <span className="label">{L("建址", "New address")}</span>
        <div className="composer">
          <input
            value={newLocal}
            onChange={(e) => setNewLocal(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))}
            placeholder={L("前缀", "prefix")}
            onKeyDown={(e) => {
              if (e.key === "Enter") createAddress();
            }}
          />
          <span>@{dom || "…"}</span>
        </div>
        <span className="hint">{L("catch-all 直收，未预建也能收信", "catch-all receives without pre-creation")}</span>
        <button className="primary" onClick={createAddress} disabled={aliasBusy || !newLocal.trim()}>
          {aliasBusy ? L("建址中…", "…") : L("建址 →", "Create →")}
        </button>
      </div>

      {/* ---- address list ---- */}
      {aliases.length === 0 ? (
        <div className="empty-state">
          <span className="big">{L("还没有地址", "No addresses")}</span>
          {L("上面建一个，或直接用 catch-all 对外收信。", "Create one above, or use catch-all.")}
        </div>
      ) : (
        <div className="mb-table">
          <div className="mb-row head">
            <span>{L("地址", "Address")}</span>
            <span>{L("状态", "Status")}</span>
            <span>{L("转发", "Forward")}</span>
            <span>{L("建于", "Created")}</span>
            <span style={{ textAlign: "right" }}>{L("操作", "Ops")}</span>
          </div>
          {aliases.map((a) => (
            <div className="mb-row" key={a.local}>
              <div className="email-cell">
                <span className="e">{a.address}</span>
                <span className="pref">
                  {provider.name} · {a.local}
                </span>
              </div>
              <div>
                <span className="tag ok">
                  <span className="dot live" />
                  {L("可收", "live")}
                </span>
              </div>
              <div>
                <span className={`tag ${a.forwardEnabled ? "ok" : "muted"}`}>
                  <span className={`dot ${a.forwardEnabled ? "live" : ""}`} />
                  {a.forwardEnabled ? L("开", "on") : L("关", "off")}
                </span>
              </div>
              <div className="time-cell">{a.createdAt ? a.createdAt.slice(0, 10) : "—"}</div>
              <div className="ops">
                <button onClick={() => onOpenInbox(a.local)}>{L("打开", "Open")}</button>
                <button className="danger" onClick={() => removeAddress(a.local)}>
                  {L("删除", "Delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
