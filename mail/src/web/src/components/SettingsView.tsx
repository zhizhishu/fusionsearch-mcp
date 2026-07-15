import { useEffect, useState } from "react";
import {
  accessAction,
  fetchAccess,
  fetchAiConfig,
  fetchAiModels,
  fetchExtConfig,
  fetchSecrets,
  saveAiConfig,
  saveExtConfig,
  type AccessState,
  type AiConfigStatus,
  type ExtConfig,
  type SecretBundle
} from "../api";
import { usePrefs } from "../i18n";

type Props = {
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
};

export function SettingsView({
  onError,
  onStatus
}: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  // ---- AI 助手 ----
  const [ai, setAi] = useState<AiConfigStatus | null>(null);
  const [aiBase, setAiBase] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);

  useEffect(() => {
    fetchAiConfig().then((c) => { setAi(c); setAiBase(c.baseUrl); setAiModel(c.model); }).catch(() => {});
  }, []);

  async function loadModels() {
    if (!aiBase.trim()) { onError(L("先填 Base URL", "Fill Base URL first")); return; }
    setModelsBusy(true);
    try {
      const list = await fetchAiModels(aiBase.trim(), aiKey || undefined);
      setAiModels(list);
      onStatus(L(`拉到 ${list.length} 个模型`, `${list.length} models`));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsBusy(false);
    }
  }

  // ---- 对外出口（cf 格式 API）----
  const [ext, setExt] = useState<ExtConfig | null>(null);
  const [extBusy, setExtBusy] = useState(false);
  const [extSitePw, setExtSitePw] = useState("");
  const [extSaved, setExtSaved] = useState(false);
  const [extWebhook, setExtWebhook] = useState("");
  const [extLimit, setExtLimit] = useState("");
  const [showExtDocs, setShowExtDocs] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  function extDocsText(): string {
    const base = origin + (ext?.pathPrefix || "/ext");
    const dom0 = ext?.domains?.[0] || "claw.163.com";
    const site = ext?.sitePassword ? ' -H "x-custom-auth: <站点口令>"' : "";
    return [
      `# 服务地址 (API base) —— 一个出口统管所有邮箱(claw + 临时)，按域名对齐标准 cloudflare_temp_email`,
      base,
      ``,
      `# 鉴权头（两套并行：管理员指定任意邮箱 / 每址令牌只管自己）`,
      `x-admin-auth: <后台口令>      # 管理员：指定任意邮箱操作`,
      `x-custom-auth: <站点口令>     # 若设了站点口令，每个请求都带`,
      `Authorization: Bearer <jwt>   # 每址令牌：建址时返回，只管该地址`,
      ``,
      `# ===== 管理员·指定任意邮箱 (x-admin-auth) =====`,
      `# 建邮箱（domain 选 ${ext?.domains?.join(" / ") || "claw.163.com / edu.002836.xyz"}）`,
      `curl -X POST ${base}/admin/new_address \\`,
      `  -H "x-admin-auth: <后台口令>"${site} -H "content-type: application/json" \\`,
      `  -d '{"name":"abc","domain":"${dom0}"}'   # → {address, jwt, address_id}`,
      `# 指定某地址读信（不用先拿 jwt；?parsed=true 取解析版）`,
      `curl "${base}/admin/mails?address=abc@${dom0}&limit=10" -H "x-admin-auth: <后台口令>"${site}`,
      `# 指定 from 发信`,
      `curl -X POST ${base}/admin/send_mail -H "x-admin-auth: <后台口令>"${site} \\`,
      `  -H "content-type: application/json" \\`,
      `  -d '{"from":"abc@${dom0}","to_mail":"x@y.com","subject":"hi","content":"正文","is_html":false}'`,
      `# 列出所有地址`,
      `curl ${base}/admin/address -H "x-admin-auth: <后台口令>"${site}`,
      `# 取某个已存在地址的每址令牌(jwt)`,
      `curl "${base}/admin/show_password?address=abc@${dom0}" -H "x-admin-auth: <后台口令>"${site}`,
      ``,
      `# ===== 每址·单独控制 (Authorization: Bearer <jwt>) =====`,
      `# 建自己的地址`,
      `curl -X POST ${base}/api/new_address${site ? ' -H "x-custom-auth: <站点口令>"' : ""} \\`,
      `  -H "content-type: application/json" -d '{"name":"abc","domain":"${dom0}"}'`,
      `# 读自己的信：列表(解析/原文) + 单封`,
      `curl "${base}/api/parsed_mails?limit=10" -H "Authorization: Bearer <jwt>"${site}   # 解析版`,
      `curl "${base}/api/mails?limit=10" -H "Authorization: Bearer <jwt>"${site}          # 原文版`,
      `curl "${base}/api/parsed_mail/<mail_id>" -H "Authorization: Bearer <jwt>"${site}   # 单封解析`,
      `curl "${base}/api/mail/<mail_id>" -H "Authorization: Bearer <jwt>"${site}          # 单封原文`,
      `# 从自己发信`,
      `curl -X POST ${base}/api/send_mail -H "Authorization: Bearer <jwt>"${site} \\`,
      `  -H "content-type: application/json" -d '{"to_mail":"x@y.com","subject":"hi","content":"正文"}'`,
      `# 自己的设置`,
      `curl ${base}/api/settings -H "Authorization: Bearer <jwt>"${site}`,
      ``,
      `# ===== 公开 =====`,
      `curl ${base}/open_api/settings   # 可用域名`
    ].join("\n");
  }

  useEffect(() => {
    // 不预填站点口令：extSitePw 只作“写入新值”的框，查看走遮罩+👁（与凭据卡一致）
    fetchExtConfig().then((c) => {
      setExt(c);
      setExtWebhook(c.webhookUrl || "");
      setExtLimit(String(c.sendLimit ?? ""));
    }).catch(() => {});
  }, []);

  async function saveExtAdvanced() {
    setExtBusy(true);
    try {
      const c = await saveExtConfig({ webhookUrl: extWebhook.trim(), sendLimit: Number(extLimit) || 0 });
      setExt(c); setExtWebhook(c.webhookUrl || ""); setExtLimit(String(c.sendLimit ?? ""));
      onStatus(L("出口设置已保存", "Egress settings saved"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtBusy(false);
    }
  }

  // ---- 访问控制（IP 封禁 / 黑白名单）----
  const [access, setAccess] = useState<AccessState | null>(null);
  const [accBusy, setAccBusy] = useState(false);
  const [wlInput, setWlInput] = useState("");
  const [blInput, setBlInput] = useState("");

  useEffect(() => { fetchAccess().then(setAccess).catch(() => {}); }, []);

  async function doAccess(action: string, ip?: string) {
    setAccBusy(true);
    try { setAccess(await accessAction(action, ip)); onStatus(L("已更新访问控制", "Access updated")); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setAccBusy(false); }
  }

  async function regenExtToken() {
    if (!confirm(L("重置后台口令？旧口令立即失效，已填进客户端的要换新。", "Regenerate admin token? The old one stops working immediately."))) return;
    setExtBusy(true);
    try { const c = await saveExtConfig({ regen: true }); setExt(c); onStatus(L("出口后台口令已重置", "Egress token regenerated")); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setExtBusy(false); }
  }
  async function saveExtSitePw() {
    if (!extSitePw.trim()) return; // 保存只用于“设新值”；留空不动（清除走单独按钮）
    setExtBusy(true);
    try {
      const c = await saveExtConfig({ sitePassword: extSitePw.trim() });
      setExt(c); setExtSitePw("");
      setExtSaved(true); setTimeout(() => setExtSaved(false), 2200);
      onStatus(L("站点口令已设置", "Site password set"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtBusy(false);
    }
  }
  async function clearExtSitePw() {
    if (!confirm(L("清除站点口令？出口将不再要求访问密码。", "Clear site password? The egress will no longer require an access password."))) return;
    setExtBusy(true);
    try {
      const c = await saveExtConfig({ sitePassword: "" });
      setExt(c); setExtSitePw("");
      onStatus(L("站点口令已清除", "Site password cleared"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtBusy(false);
    }
  }

  // ---- 凭据·可复制（B 方案：揭示真实密钥/口令）----
  const [secrets, setSecrets] = useState<SecretBundle | null>(null);
  const [secretsBusy, setSecretsBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  async function loadSecrets() {
    setSecretsBusy(true);
    try {
      setSecrets(await fetchSecrets());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSecretsBusy(false);
    }
  }

  function copyText(text: string) {
    const done = () => onStatus(L("已复制到剪贴板", "Copied"));
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => onError(L("复制失败，手动选中吧", "Copy failed")));
    } else {
      onError(L("此浏览器不支持自动复制", "Clipboard unavailable"));
    }
  }

  function maskSecret(v: string) {
    if (v.length <= 8) return "••••••";
    return `${v.slice(0, 4)}••••••${v.slice(-3)}`;
  }

  function secretRow(key: string, label: string, value: string | null) {
    const shown = revealed[key];
    return (
      <div className="secret-row" key={key}>
        <span className="secret-label">{label}</span>
        <code className="secret-val">{value ? (shown ? value : maskSecret(value)) : L("未设", "not set")}</code>
        {value && (
          <div className="secret-ops">
            <button className="mini-link" onClick={() => setRevealed((r) => ({ ...r, [key]: !r[key] }))}>
              {shown ? L("🙈 隐藏", "🙈 hide") : L("👁 查看", "👁 show")}
            </button>
            <button className="mini-link" onClick={() => copyText(value)}>{L("复制", "copy")}</button>
          </div>
        )}
      </div>
    );
  }

  // 明文 + 复制行（给非密的服务地址/域名用，不打码）
  function copyRow(key: string, label: string, value: string | null) {
    return (
      <div className="secret-row" key={key}>
        <span className="secret-label">{label}</span>
        <code className="secret-val">{value || "—"}</code>
        {value && (
          <div className="secret-ops">
            <button className="mini-link" onClick={() => copyText(value)}>{L("复制", "copy")}</button>
          </div>
        )}
      </div>
    );
  }

  async function saveAi() {
    setAiBusy(true);
    try {
      const c = await saveAiConfig({ baseUrl: aiBase.trim(), model: aiModel.trim(), apiKey: aiKey || undefined });
      setAi(c); setAiKey("");
      onStatus(L("已保存 AI 配置", "AI config saved"));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="stagger settings-view">
      {/* ===== AI 助手 ===== */}
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <h3>{L("AI 助手", "AI assistant")}</h3>
            <p>{L("右下角气泡的模型端点（任意 OpenAI 兼容端点）。密钥只存服务端、不回显。", "Model endpoint for the bottom-right bubble (any OpenAI-compatible). Key stored server-side only.")}</p>
          </div>
          <span className={`tag ${ai?.configured ? "ok" : "muted"}`}>
            <span className={`dot ${ai?.configured ? "live" : ""}`} />{ai?.configured ? L("已配置", "configured") : L("未配置", "not set")}
          </span>
        </div>
        <div className="settings-form">
          <label className="wide"><span>Base URL</span>
            <input value={aiBase} onChange={(e) => setAiBase(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
          </label>
          <label><span>
            {L("模型", "Model")}
            <button type="button" className="mini-link" onClick={loadModels} disabled={modelsBusy || !aiBase.trim()}>
              {modelsBusy ? L("获取中…", "fetching…") : L("↻ 获取模型", "↻ fetch models")}
            </button>
          </span>
            <input list="ai-model-list" value={aiModel} onChange={(e) => setAiModel(e.target.value)}
              placeholder={aiModels.length ? L("选择或输入", "pick or type") : L("先点「获取模型」", "click fetch first")} spellCheck={false} />
            <datalist id="ai-model-list">
              {aiModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label><span>API Key {ai?.hasKey ? L("（已存，留空不改）", "(saved)") : ""}</span>
            <input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder="sk-…" autoComplete="new-password" />
          </label>
          <div className="settings-form-foot">
            <span style={{ flex: 1 }} />
            <button className="primary" onClick={saveAi} disabled={aiBusy || !aiBase.trim()}>
              {aiBusy ? L("保存中…", "saving…") : L("保存", "Save")}
            </button>
          </div>
        </div>
      </div>

      {/* ===== 对外出口（cf 格式 API） ===== */}
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <h3>{L("对外出口 · cf 格式 API", "Egress · cf-format API")}</h3>
            <p>{L("把下面几样填进任意 cloudflare_temp_email 客户端/脚本，就能用本站全部邮箱（claw 子邮箱 + 临时邮箱）建址、收信。口令我生成、只本后台可见。", "Fill these into any cloudflare_temp_email client/script to create addresses & read mail across all mailboxes here (claw + temp).")}</p>
          </div>
        </div>
        {ext && (
          <div className="secret-list">
            {copyRow("ext-url", L("服务地址（客户端的 API 地址）", "Service URL (client API base)"), origin + ext.pathPrefix)}
            {copyRow("ext-domains", L("可用域名（建址用，可多个）", "Domains (for creating addresses)"), ext.domains.join("  ·  ") || null)}
            {secretRow("ext-admin", L("后台口令 · x-admin-auth", "Admin token · x-admin-auth"), ext.adminToken)}
            {/* 站点口令：已设→遮罩查看(👁/复制)；未设→状态行。设置/修改走下面写入框，清除走按钮。 */}
            {ext.sitePassword
              ? secretRow("ext-site", L("站点口令 · x-custom-auth", "Site password · x-custom-auth"), ext.sitePassword)
              : copyRow("ext-site", L("站点口令 · x-custom-auth", "Site password · x-custom-auth"), L("未设 · 出口不要求访问密码", "not set · no access password required"))}
            <div className="secret-row">
              <span className="secret-label">{ext.sitePassword ? L("改站点口令", "Change site password") : L("设站点口令", "Set site password")}</span>
              <input className="ext-pw" type="password" value={extSitePw} onChange={(e) => setExtSitePw(e.target.value)}
                placeholder={L("输入新口令（留空不动）", "new password (blank = keep)")} autoComplete="new-password" />
              <div className="secret-ops">
                {extSaved && <span className="saved-flash">✓ {L("已保存", "saved")}</span>}
                {ext.sitePassword && <button className="mini-link" onClick={clearExtSitePw} disabled={extBusy}>{L("清除", "clear")}</button>}
                <button className="btn-sm" onClick={saveExtSitePw} disabled={extBusy || !extSitePw.trim()}>{extBusy ? L("保存中…", "…") : L("保存", "Save")}</button>
              </div>
            </div>
            <div className="secret-row">
              <span className="secret-label">{L("到信 webhook", "Mail webhook")}</span>
              <input className="ext-pw" type="text" value={extWebhook} onChange={(e) => setExtWebhook(e.target.value)}
                placeholder={L("https://你的服务/hook（留空=关闭，收信即 POST 推送）", "https://you/hook (blank = off)")} spellCheck={false} />
            </div>
            <div className="secret-row">
              <span className="secret-label">{L("发信日限额", "Daily send limit")}</span>
              <input className="ext-pw" type="number" min={0} value={extLimit} onChange={(e) => setExtLimit(e.target.value)}
                placeholder={L("200（0=不限，防滥用/防封号）", "200 (0 = unlimited)")} />
              <div className="secret-ops">
                <button className="btn-sm" onClick={saveExtAdvanced} disabled={extBusy}>{extBusy ? L("保存中…", "…") : L("保存", "Save")}</button>
              </div>
            </div>
            <div className="settings-form-foot">
              <span className="settings-note">{L("一个出口统管所有邮箱(claw + 临时)，按域名分流；每址 jwt 建址时自动发。", "One egress manages all mailboxes, routed by domain.")}</span>
              <span style={{ flex: 1 }} />
              <button className="mini-link" onClick={() => setShowExtDocs((s) => !s)}>{showExtDocs ? L("收起文档", "hide docs") : L("📖 调用文档", "📖 API docs")}</button>
              <button onClick={regenExtToken} disabled={extBusy}>{L("重置后台口令", "Regenerate token")}</button>
            </div>
            {showExtDocs && (
              <div className="ext-docs">
                <div className="ext-docs-head">
                  <span>{L("调用文档 · 复制即用（口令见上方，站点口令设了才带 x-custom-auth）", "API usage — copy & go")}</span>
                  <button className="mini-link" onClick={() => copyText(extDocsText())}>{L("复制全部", "copy all")}</button>
                </div>
                <pre>{extDocsText()}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== 凭据·可复制 ===== */}
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <h3>{L("凭据 · 可复制", "Credentials · copy")}</h3>
            <p>{L("你存的真实密钥/口令：临时源密码、claw 出口 API key、AI key。点「查看」看明文、点「复制」进剪贴板。仅本后台（已过管理员门）可见。", "Real stored secrets: temp-source passwords, claw API key, AI key. Click show / copy. Visible only inside this admin panel.")}</p>
          </div>
          {!secrets && (
            <button className="primary" onClick={loadSecrets} disabled={secretsBusy}>
              {secretsBusy ? L("加载中…", "loading…") : L("🔓 加载凭据", "🔓 Load")}
            </button>
          )}
        </div>
        {secrets && (
          <div className="secret-list">
            {secrets.temp.map((t) =>
              secretRow(
                `t:${t.id}`,
                `${t.name} · ${t.type === "cf" ? L("x-admin-auth 口令", "x-admin-auth") : L("管理员密码", "admin password")}`,
                t.password
              )
            )}
            {secretRow("claw", L("claw 出口 · CLAW_API_KEY", "claw · CLAW_API_KEY"), secrets.claw.apiKey)}
            {secretRow("ai", L("AI 助手 · API Key", "AI · API Key"), secrets.ai.apiKey)}
            <div className="settings-form-foot">
              <span className="settings-note">{L("提醒：这些是真实密钥，复制后别贴到公开地方。", "These are real secrets — don't paste them anywhere public.")}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => { setSecrets(null); setRevealed({}); }}>{L("收起", "Hide all")}</button>
            </div>
          </div>
        )}
      </div>

      {/* ===== 访问控制 · IP ===== */}
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <h3>{L("访问控制 · IP", "Access control · IP")}</h3>
            <p>{L(`登录失败 ${access?.failLimit ?? 3} 次自动封禁该 IP（连页面都打不开）。白名单永不封、黑名单永久挡。`, `${access?.failLimit ?? 3} failed logins auto-ban the IP. Whitelist never bans; blacklist always blocks.`)}</p>
          </div>
        </div>
        {access && (
          <div className="acl-wrap">
            <div className="acl-cur">
              <span className="secret-label">{L("你当前 IP", "Your IP")}</span>
              <code className="secret-val">{access.currentIp}</code>
              <div className="secret-ops">
                <button className="mini-link" onClick={() => copyText(access.currentIp)}>{L("复制", "copy")}</button>
                {!access.whitelist.includes(access.currentIp) && (
                  <button className="mini-link" onClick={() => doAccess("whitelist-add", access.currentIp)} disabled={accBusy}>{L("加白名单(防自封)", "whitelist me")}</button>
                )}
              </div>
            </div>

            <div className="acl-group">
              <div className="acl-title">{L("被封 IP", "Banned")} <span className="acl-count">{access.banned.length}</span></div>
              {access.banned.length === 0 ? <div className="acl-empty">{L("暂无", "none")}</div> : access.banned.map((b) => (
                <div className="acl-row" key={b.ip}>
                  <code>{b.ip}</code>
                  <span className="acl-meta">{b.reason}</span>
                  <button className="mini-link" onClick={() => doAccess("unban", b.ip)} disabled={accBusy}>{L("解封", "unban")}</button>
                </div>
              ))}
            </div>

            <div className="acl-group">
              <div className="acl-title">{L("黑名单（永久挡）", "Blacklist")} <span className="acl-count">{access.blacklist.length}</span></div>
              <div className="acl-add">
                <input value={blInput} onChange={(e) => setBlInput(e.target.value)} placeholder={L("IP 地址", "IP address")} spellCheck={false} />
                <button className="btn-sm" onClick={() => { doAccess("blacklist-add", blInput.trim()); setBlInput(""); }} disabled={accBusy || !blInput.trim()}>{L("加入", "add")}</button>
              </div>
              {access.blacklist.map((ip) => (
                <div className="acl-row" key={ip}><code>{ip}</code><span className="acl-meta" /><button className="mini-link" onClick={() => doAccess("blacklist-del", ip)} disabled={accBusy}>{L("移除", "remove")}</button></div>
              ))}
            </div>

            <div className="acl-group">
              <div className="acl-title">{L("白名单（永不封）", "Whitelist")} <span className="acl-count">{access.whitelist.length}</span></div>
              <div className="acl-add">
                <input value={wlInput} onChange={(e) => setWlInput(e.target.value)} placeholder={L("IP 地址", "IP address")} spellCheck={false} />
                <button className="btn-sm" onClick={() => { doAccess("whitelist-add", wlInput.trim()); setWlInput(""); }} disabled={accBusy || !wlInput.trim()}>{L("加入", "add")}</button>
              </div>
              {access.whitelist.map((ip) => (
                <div className="acl-row" key={ip}><code>{ip}</code><span className="acl-meta" /><button className="mini-link" onClick={() => doAccess("whitelist-del", ip)} disabled={accBusy}>{L("移除", "remove")}</button></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
