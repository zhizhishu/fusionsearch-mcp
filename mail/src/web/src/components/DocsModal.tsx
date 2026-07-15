import { useEffect, useState } from "react";
import { fetchExtConfig, type ExtConfig } from "../api";
import { usePrefs } from "../i18n";

type Props = {
  open: boolean;
  onClose: () => void;
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
};

const origin = typeof window !== "undefined" ? window.location.origin : "";

function buildDocs(ext: ExtConfig | null): string {
  const base = origin + (ext?.pathPrefix || "/ext");
  const dom0 = ext?.domains?.[0] || "claw.163.com";
  const site = ext?.sitePassword ? ' -H "x-custom-auth: <站点口令>"' : "";
  return [
    `# 服务地址 (API base) —— 一个出口统管所有邮箱，按域名分流（对齐标准 cloudflare_temp_email）`,
    base,
    ``,
    `# 鉴权头`,
    `x-admin-auth: <后台口令>      # 管理员：指定任意邮箱`,
    `x-custom-auth: <站点口令>     # 设了站点口令就每请求都带`,
    `Authorization: Bearer <jwt>   # 每址令牌：建址返回，只管该地址`,
    ``,
    `# ===== 管理员·指定任意邮箱 (x-admin-auth) =====`,
    `curl -X POST ${base}/admin/new_address -H "x-admin-auth: <后台口令>"${site} \\`,
    `  -H "content-type: application/json" -d '{"name":"abc","domain":"${dom0}"}'   # → {address,jwt,address_id}`,
    `curl ${base}/admin/address -H "x-admin-auth: <后台口令>"${site}                 # 列所有地址`,
    `curl "${base}/admin/show_password?address=abc@${dom0}" -H "x-admin-auth: <后台口令>"${site}  # 取某址 jwt`,
    `curl "${base}/admin/mails?address=abc@${dom0}&parsed=true&limit=10" -H "x-admin-auth: <后台口令>"${site}  # 指定址读信`,
    `curl -X POST ${base}/admin/send_mail -H "x-admin-auth: <后台口令>"${site} \\`,
    `  -H "content-type: application/json" -d '{"from":"abc@${dom0}","to_mail":"x@y.com","subject":"hi","content":"正文","is_html":false}'`,
    ``,
    `# ===== 每址·单独控制 (Authorization: Bearer <jwt>) =====`,
    `curl "${base}/api/parsed_mails?limit=10" -H "Authorization: Bearer <jwt>"${site}   # 列表(解析)`,
    `curl "${base}/api/mails?limit=10" -H "Authorization: Bearer <jwt>"${site}          # 列表(原文)`,
    `curl "${base}/api/parsed_mail/<id>" -H "Authorization: Bearer <jwt>"${site}        # 单封(解析,含 attachments[]元数据)`,
    `curl "${base}/api/mail/<id>" -H "Authorization: Bearer <jwt>"${site}              # 单封(原文)`,
    `curl "${base}/api/mail/<id>/attachment/<part_id>" -H "Authorization: Bearer <jwt>"${site} -o file  # 下载附件(part_id 取自上面 attachments[].id)`,
    `curl -X POST ${base}/api/send_mail -H "Authorization: Bearer <jwt>"${site} \\`,
    `  -H "content-type: application/json" -d '{"to_mail":"x@y.com","subject":"hi","content":"正文"}'`,
    `curl ${base}/api/settings -H "Authorization: Bearer <jwt>"${site}                  # 自己的设置`,
    ``,
    `# ===== 公开 =====`,
    `curl ${base}/open_api/settings   # 可用域名`,
    ``,
    `# ===== 到信推送 webhook（免轮询）=====`,
    `# 在 设置→对外出口 填 webhook URL，任一邮箱收到新信即 POST:`,
    `#   {"type":"mail.received","address":"<邮箱>","mailbox":"<邮箱>","id":<本地id>,"from":"...","subject":"..."}`,
    `# 收到后用每址 jwt 调 /api/mail/<id> 取正文(id 即推送里的 id 对应 provider 邮件,实际读用 parsed_mails 取最新)`,
    ``,
    `# 字段兼容：to_mail|to、content|text|body、is_html|html`,
    `# 真实口令在 设置→对外出口 卡里复制；claw 与 edu 收发都不需要外部 SMTP；发信有日限额(设置可调)`
  ].join("\n");
}

export function DocsModal({ open, onClose, onError, onStatus }: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const [ext, setExt] = useState<ExtConfig | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchExtConfig().then(setExt).catch((e) => onError(e instanceof Error ? e.message : String(e)));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onError]);

  if (!open) return null;
  const text = buildDocs(ext);

  function copyAll() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => onStatus(L("文档已复制", "Docs copied"))).catch(() => onError(L("复制失败", "copy failed")));
    }
  }

  return (
    <div className="compose-overlay" onClick={onClose}>
      <div className="compose-card docs-card" role="dialog" aria-label="API docs" onClick={(e) => e.stopPropagation()}>
        <header className="compose-head">
          <h2>{L("API 调用文档", "API docs")}<span className="dot-accent">.</span></h2>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="mini-link" onClick={copyAll}>{L("复制全部", "copy all")}</button>
            <button className="icon-btn" onClick={onClose} aria-label="close">×</button>
          </div>
        </header>
        <div className="docs-body">
          <pre>{text}</pre>
        </div>
      </div>
    </div>
  );
}
