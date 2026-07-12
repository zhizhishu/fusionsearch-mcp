// Optional persistence for ephemeral hosts (e.g. Hugging Face Spaces).
//
// HF Space containers have an ephemeral filesystem: config/runtime.json (the
// Admin-editable runtime config) is wiped on every rebuild/restart. When
// SUPABASE_URL + SUPABASE_SERVICE_KEY are set, the server hydrates
// runtime.json from a private Supabase Storage object on boot and mirrors
// every save (plus a periodic snapshot) back to it. When unset, every export
// here is a graceful no-op, so local and standalone deploys are unaffected.
//
// Uses the Supabase Storage REST API over native fetch (Node >=18) — no extra
// npm dependency. The SUPABASE_SERVICE_KEY is a server-side "secret"/service_role
// key (bypasses RLS); it must never reach the browser and is only read from env.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RAW_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = (process.env.SUPABASE_BUCKET || 'fusionsearch').trim();
const OBJECT = (process.env.SUPABASE_OBJECT || 'runtime.json').trim();
const MONITOR_OBJECT = (process.env.SUPABASE_MONITOR_OBJECT || 'monitor-history.json').trim();

export function supabaseEnabled() {
  return Boolean(RAW_URL && SERVICE_KEY);
}

function authHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra
  };
}

function objectUrl() {
  return `${RAW_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeURIComponent(OBJECT)}`;
}

function monitorObjectUrl() {
  return `${RAW_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeURIComponent(MONITOR_OBJECT)}`;
}

async function bodyText(res) {
  try {
    return (await res.text()).slice(0, 240);
  } catch {
    return '';
  }
}

// Create the private bucket if it does not exist yet. Safe to call repeatedly.
export async function ensureBucket() {
  if (!supabaseEnabled()) return false;
  const res = await fetch(`${RAW_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
  });
  if (res.ok) return true;
  const text = await bodyText(res);
  // Already-exists is the expected steady state, not an error.
  if (res.status === 409 || /exist|duplicate/i.test(text)) return true;
  throw new Error(`ensureBucket ${res.status}: ${text}`);
}

// Download the stored runtime.json into `targetPath`. Returns true if a
// snapshot existed and was written, false if there was nothing to restore.
export async function restoreRuntimeConfig(targetPath) {
  if (!supabaseEnabled()) return false;
  const res = await fetch(objectUrl(), { headers: authHeaders({ 'cache-control': 'no-cache' }) });
  if (res.status === 404 || res.status === 400) return false; // nothing stored yet
  if (!res.ok) throw new Error(`restore ${res.status}: ${await bodyText(res)}`);
  const body = await res.text();
  if (!body || !body.trim()) return false;
  JSON.parse(body); // validate it parses before clobbering the local file
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(`${targetPath}.tmp`, body, 'utf8');
  await rename(`${targetPath}.tmp`, targetPath);
  return true;
}

// Upload the current runtime.json to the bucket (create-or-update).
export async function backupRuntimeConfig(sourcePath) {
  if (!supabaseEnabled()) return false;
  let body;
  try {
    body = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false; // nothing to back up yet
    throw error;
  }
  const res = await fetch(objectUrl(), {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'cache-control': 'no-cache',
      'x-upsert': 'true'
    }),
    body
  });
  if (!res.ok) throw new Error(`backup ${res.status}: ${await bodyText(res)}`);
  return true;
}

export const supabaseStoreInfo = { bucket: BUCKET, object: OBJECT, hasUrl: Boolean(RAW_URL) };

// Download the persisted monitor history object. Returns the parsed object, or null if not stored yet.
export async function restoreMonitorHistory() {
  if (!supabaseEnabled()) return null;
  const res = await fetch(monitorObjectUrl(), { headers: authHeaders({ 'cache-control': 'no-cache' }) });
  if (res.status === 404 || res.status === 400) return null; // nothing stored yet
  if (!res.ok) throw new Error(`restoreMonitorHistory ${res.status}: ${await bodyText(res)}`);
  const body = await res.text();
  if (!body || !body.trim()) return null;
  return JSON.parse(body);
}

// Upload the current monitor history to the bucket (create-or-update). Non-blocking: call .catch() at call site.
export async function backupMonitorHistory(historyObj) {
  if (!supabaseEnabled()) return false;
  const res = await fetch(monitorObjectUrl(), {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'cache-control': 'no-cache',
      'x-upsert': 'true'
    }),
    body: JSON.stringify(historyObj)
  });
  if (!res.ok) throw new Error(`backupMonitorHistory ${res.status}: ${await bodyText(res)}`);
  return true;
}
