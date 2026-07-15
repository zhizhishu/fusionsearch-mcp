import { useState } from "react";
import { fetchCfStatus, fetchSecrets, type TempProviderPublic } from "../api";
import { usePrefs } from "../i18n";

type ProviderPatch = { name?: string; type?: "php" | "cf"; endpoint?: string; domain?: string; password?: string };

type Props = {
  tempProviders: TempProviderPublic[];
  onAddTempProvider: (input: { name: string; type: "php" | "cf"; endpoint: string; domain: string; password: string }) => void | Promise<void>;
  onUpdateTempProvider: (id: string, patch: ProviderPatch) => void | Promise<void>;
  onDeleteTempProvider: (id: string) => void;
  onOpenTempProvider: (id: string) => void;
  onError: (msg: string) => void;
};

const NEW = "__new__";

export function TempSourcesCard({
  tempProviders,
  onAddTempProvider,
  onUpdateTempProvider,
  onDeleteTempProvider,
  onOpenTempProvider,
  onError
}: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"php" | "cf">("php");
  const [endpoint, setEndpoint] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<Record<string, { ok: boolean; msg: string } | "loading">>({});

  const editingExisting = editingId !== null && editingId !== NEW;
  const editingProvider = editingExisting ? tempProviders.find((p) => p.id === editingId) : undefined;

  function openAdd() {
    setEditingId(NEW); setName(""); setType("php"); setEndpoint(""); setDomain(""); setPassword(""); setShowPwd(false);
  }
  function openEdit(p: TempProviderPublic) {
    setEditingId(p.id); setName(p.name); setType(p.type); setEndpoint(p.endpoint); setDomain(p.domain); setPassword(""); setShowPwd(false);
  }
  function cancel() { setEditingId(null); setShowPwd(false); }

  async function revealCurrentPwd() {
    if (showPwd) { setShowPwd(false); return; }
    if (!editingId || editingId === NEW) return;
    try {
      const s = await fetchSecrets();
      const t = s.temp.find((x) => x.id === editingId);
      if (t?.password) { setPassword(t.password); setShowPwd(true); }
      else onError(L("该源未设密码", "no password set"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!name.trim() || !endpoint.trim()) return;
    setBusy(true);
    try {
      if (editingId === NEW) {
        if (!password.trim()) { onError(L("新源必须填管理员密码", "Password required for a new source")); setBusy(false); return; }
        await onAddTempProvider({ name: name.trim(), type, endpoint: endpoint.trim(), domain: domain.trim(), password });
      } else if (editingId) {
        const patch: ProviderPatch = { name: name.trim(), type, endpoint: endpoint.trim(), domain: domain.trim() };
        if (password.trim()) patch.password = password;
        await onUpdateTempProvider(editingId, patch);
      }
      setEditingId(null); setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function testConn(p: TempProviderPublic) {
    setTest((t) => ({ ...t, [p.id]: "loading" }));
    try {
      const s = await fetchCfStatus(p.id);
      setTest((t) => ({ ...t, [p.id]: s.error ? { ok: false, msg: s.error } : { ok: true, msg: s.domain || "ok" } }));
    } catch (e) {
      setTest((t) => ({ ...t, [p.id]: { ok: false, msg: e instanceof Error ? e.message : String(e) } }));
    }
  }

  function renderForm() {
    return (
      <div className="settings-form src-form">
        <label><span>{L("名字", "Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("如 edu2", "e.g. edu2")} />
        </label>
        <label><span>{L("类型", "Type")}</span>
          <select value={type} onChange={(e) => setType(e.target.value as "php" | "cf")}>
            <option value="php">php — {L("自建 PHP 临时邮箱", "self-hosted PHP")}</option>
            <option value="cf">cf — cloudflare_temp_email</option>
          </select>
        </label>
        <label className="wide"><span>{L("接口地址", "Endpoint")}</span>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} spellCheck={false}
            placeholder={type === "php" ? "https://x.xyz/api.php" : "https://x.workers.dev"} />
        </label>
        <label><span>{L("域名", "Domain")}</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="x.xyz" spellCheck={false} />
        </label>
        <label><span>
          {type === "cf"
            ? L("管理员 auth（x-admin-auth 口令）", "Admin auth (x-admin-auth)")
            : L("管理员密码（X-Admin-Password）", "Admin password (X-Admin-Password)")}
          {editingExisting && editingProvider?.hasPassword && (
            <button type="button" className="mini-link" onClick={revealCurrentPwd}>
              {showPwd ? L("🙈 遮罩", "🙈 hide") : L("👁 显示当前", "👁 show current")}
            </button>
          )}
        </span>
          <input type={showPwd ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
            placeholder={editingExisting ? (editingProvider?.hasPassword ? L("已设 · 留空不改，或点「显示当前」回显", "set · blank = keep, or click show current") : L("未设", "not set")) : L("必填", "required")} />
        </label>
        <div className="settings-form-foot">
          {type === "cf" && (
            <span className="settings-note">{L("cf 走 cloudflare_temp_email admin API（x-admin-auth）：endpoint=实例根地址、密码=admin 密码。", "cf = cloudflare_temp_email admin API (x-admin-auth).")}</span>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={cancel}>{L("取消", "Cancel")}</button>
          <button className="primary" onClick={save} disabled={busy || !name.trim() || !endpoint.trim()}>
            {busy ? L("保存中…", "saving…") : editingExisting ? L("保存修改", "Save changes") : L("添加源", "Add source")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-card">
      <div className="settings-head">
        <div>
          <h3>{L("临时邮箱源", "Temp-mail sources")}</h3>
          <p>{L("接入一个或多个临时邮箱后端（php 自建 / cloudflare_temp_email），在「临时邮箱」视图收发管理。点某个源可查看并修改它当前的设置。", "Connect one or more temp-mail backends; click a source to view & edit its current settings.")}</p>
        </div>
        <button className="primary" onClick={editingId === NEW ? cancel : openAdd}>
          {editingId === NEW ? L("收起", "Close") : L("+ 添加源", "+ Add source")}
        </button>
      </div>

      {tempProviders.length === 0 && editingId !== NEW ? (
        <div className="empty-state" style={{ marginTop: 12 }}>
          <span className="big">{L("还没有临时邮箱源", "No sources yet")}</span>
          {L("点「+ 添加源」接入第一个。", "Click “+ Add source” to connect one.")}
        </div>
      ) : (
        <div className="src-list">
          {tempProviders.map((p) => {
            const tr = test[p.id];
            const isEditing = editingId === p.id;
            return (
              <div key={p.id} className={`src-item ${isEditing ? "editing" : ""}`}>
                <div className="src-row" onClick={() => (isEditing ? cancel() : openEdit(p))}>
                  <span className={`src-type ${p.type}`}>{p.type === "cf" ? "cloudflare" : "php"}</span>
                  <div className="src-main">
                    <span className="src-domain">{p.domain || p.name}</span>
                    <span className="src-meta">{p.name} · {p.endpoint.replace(/^https?:\/\//, "")}</span>
                  </div>
                  <span className={`tag ${p.hasPassword ? "ok" : "muted"}`}>
                    <span className={`dot ${p.hasPassword ? "live" : ""}`} />{p.hasPassword ? L("密钥已设", "key set") : L("无密钥", "no key")}
                  </span>
                  {tr && tr !== "loading" && (
                    <span className={`tag ${tr.ok ? "ok" : "danger-tag"}`} title={tr.msg}>{tr.ok ? L("连通", "ok") : L("失败", "fail")}</span>
                  )}
                  <div className="src-ops" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => testConn(p)} disabled={tr === "loading"}>{tr === "loading" ? "…" : L("测试", "Test")}</button>
                    <button onClick={() => onOpenTempProvider(p.id)}>{L("打开", "Open")}</button>
                    <button onClick={() => (isEditing ? cancel() : openEdit(p))}>{isEditing ? L("取消", "Cancel") : L("编辑", "Edit")}</button>
                    <button className="danger" onClick={() => onDeleteTempProvider(p.id)}>{L("删除", "Delete")}</button>
                  </div>
                </div>
                {isEditing && renderForm()}
              </div>
            );
          })}
          {editingId === NEW && <div className="src-item editing">{renderForm()}</div>}
        </div>
      )}
    </div>
  );
}
