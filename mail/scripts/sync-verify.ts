// 端到端：setSetting -> push 到云端 -> hydrate 拉回本地。用 npx tsx 跑。
import "dotenv/config";
import { setSetting, getSetting, deleteSettings } from "../src/server/db";
import { hydrateFromSupabase } from "../src/server/hydrate";
import { createClient } from "@supabase/supabase-js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = `v-${Date.now()}`;

setSetting("selftest.sync", stamp); // 本地写 + fire-and-forget push
console.log("local set:", getSetting("selftest.sync"));

await sleep(3000); // 等 push 落地

const c = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_KEY as string, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const remote = await c.from("app_settings").select("value").eq("key", "selftest.sync");
console.log("push ->", remote.data?.[0]?.value === stamp ? "PUSH OK" : `PUSH FAIL (${JSON.stringify(remote.data)})`);

await hydrateFromSupabase(); // 拉回本地（验证 hydrate 不崩 + named params 正确）
console.log("after hydrate local:", getSetting("selftest.sync"));

deleteSettings(["selftest.sync"]); // 清理：本地删 + push 删云端
await sleep(1500);
const after = await c.from("app_settings").select("value").eq("key", "selftest.sync");
console.log("cleanup ->", (after.data?.length ?? 0) === 0 ? "CLEAN OK" : "still present");

process.exit(0);
