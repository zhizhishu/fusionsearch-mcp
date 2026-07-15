// 一次性建表脚本：本地用 direct connection 连 Supabase，跑 supabase-schema.sql。
// 运行：node scripts/supabase-init.mjs   （读取 .env 的 SUPABASE_DB_URL）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import "dotenv/config";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "supabase-schema.sql"), "utf8");

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_DB_URL is required in .env");
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log("connected to Supabase, applying schema...");
await client.query(sql);

const tables = await client.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
);
console.log("public tables:", tables.rows.map((r) => r.table_name).join(", "));

const rls = await client.query(
  "select relname, relrowsecurity from pg_class where relname in ('app_settings','mailboxes','mails','attachments') order by relname"
);
console.log("RLS:", rls.rows.map((r) => `${r.relname}=${r.relrowsecurity}`).join(", "));

await client.end();
console.log("done");
