import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMIT = 120;
const MAX_MEMORY_ENTRIES = 500;
const SECRET_PATTERN = /(token|secret|cookie|authorization|api.?key|password)/iu;

let entries = [];
let logFilePath = path.join(process.cwd(), 'logs', 'fusionsearch.log');
let configured = false;

export function configureLogger({ logDir = process.env.LOG_DIR } = {}) {
  if (configured) return;
  const targetDir = logDir || path.join(process.cwd(), 'logs');
  logFilePath = path.join(targetDir, 'fusionsearch.log');
  configured = true;
  void mkdir(targetDir, { recursive: true }).catch(() => {});
}

export function logEvent(level, scope, message, details = {}) {
  configureLogger();
  const entry = {
    ts: new Date().toISOString(),
    level: normalizeLevel(level),
    scope: String(scope || 'app'),
    message: String(message || ''),
    details: redact(details)
  };

  entries.push(entry);
  if (entries.length > MAX_MEMORY_ENTRIES) {
    entries = entries.slice(-MAX_MEMORY_ENTRIES);
  }

  void appendFile(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {});
  return entry;
}

export async function readLogEntries({ limit = DEFAULT_LIMIT, level = '', scope = '' } = {}) {
  configureLogger();
  const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_LIMIT, 1), 500);
  const rows = await readPersistedEntries().catch(() => entries);
  return rows
    .filter((entry) => !level || entry.level === level)
    .filter((entry) => !scope || entry.scope === scope)
    .slice(-boundedLimit)
    .reverse();
}

export function getLogFilePath() {
  configureLogger();
  return logFilePath;
}

async function readPersistedEntries() {
  const raw = await readFile(logFilePath, 'utf8');
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeLevel(level) {
  return ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
}

function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_PATTERN.test(key) ? '[redacted]' : redact(item)
    ])
  );
}
