// 验证 supabase-js + secret key 能读写（RLS 绕过）+ REST(443) 连通。
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required");
  process.exit(1);
}

const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const stamp = `selftest-${Date.now()}`;

const up = await c.from("app_settings").upsert({ key: "selftest.sync", value: stamp, updated_at: new Date().toISOString() }, { onConflict: "key" });
console.log("upsert error:", up.error?.message ?? "none");

const rd = await c.from("app_settings").select("*").eq("key", "selftest.sync");
console.log("read back:", rd.data?.[0]?.value === stamp ? "OK match" : `MISMATCH (${JSON.stringify(rd.data)})`, rd.error?.message ?? "");

const del = await c.from("app_settings").delete().eq("key", "selftest.sync");
console.log("cleanup error:", del.error?.message ?? "none");

console.log("supabase round-trip done");
