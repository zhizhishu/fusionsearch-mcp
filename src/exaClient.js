// Exa 第 8 源：纯协议神经(语义)搜索 API —— 无浏览器、无代理池、不撞反爬。
// 官方契约（已实测 2026-10）: POST https://api.exa.ai/search
//   header  x-api-key: <key> / Content-Type: application/json
//   body    { query, numResults, type, contents: { text: { maxCharacters } } }
//   resp    { requestId, results: [{ id, title, url, publishedDate, author, text }],
//             searchTime, costDollars: { total } }
// 与 Serper 的分工：Serper = 关键词 Google SERP（拿"大家排第一的"），
// Exa = 语义检索（拿"意思最接近的"），两者结果集差异大，交叉取证价值高。

const DEFAULT_API_URL = 'https://api.exa.ai';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TEXT_CHARS = 800;

export function resolveExaConfig(config = {}) {
  const apiUrl = trimSlash(config.exaApiUrl || DEFAULT_API_URL);
  const apiKey = (config.exaApiKey || '').trim();
  return {
    exaEnabled: config.exaEnabled !== false,
    exaApiUrl: apiUrl,
    exaApiKey: apiKey,
    hasExaAccess: config.exaEnabled !== false && Boolean(apiKey)
  };
}

export function getExaPublicConfig(config = {}) {
  const resolved = resolveExaConfig(config);
  return {
    exaEnabled: resolved.exaEnabled,
    exaApiUrl: resolved.exaApiUrl,
    hasExaApiKey: Boolean(resolved.exaApiKey),
    hasExaAccess: resolved.hasExaAccess
  };
}

export async function executeExaSearch({
  config,
  query,
  maxResults = DEFAULT_MAX_RESULTS,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const resolved = resolveExaConfig(config);
  assertConfigured(resolved.hasExaAccess, '未配置 EXA_API_KEY，跳过 Exa');

  const payload = await postJson(`${resolved.exaApiUrl}/search`, {
    headers: { 'x-api-key': resolved.exaApiKey },
    body: {
      query,
      numResults: clampCount(maxResults),
      type: 'auto',
      contents: { text: { maxCharacters: DEFAULT_TEXT_CHARS } }
    },
    timeoutMs
  });

  const sources = normalizeResults(payload);
  if (!sources.length) {
    throw new Error('Exa 返回空 results');
  }

  return {
    provider: 'exa',
    sources,
    costDollars: Number.isFinite(payload?.costDollars?.total) ? payload.costDollars.total : null,
    content: formatContent({ query, sources })
  };
}

function normalizeResults(payload) {
  const items = Array.isArray(payload?.results) ? payload.results : [];
  return items
    .map((item) => {
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      if (!url) return null;
      return {
        title: (typeof item?.title === 'string' && item.title.trim()) || url,
        url,
        description: clip(cleanText(item?.text, item?.title), 300),
        publishedDate: typeof item?.publishedDate === 'string' ? item.publishedDate : '',
        provider: 'exa'
      };
    })
    .filter(Boolean);
}

// Exa 返回的 text 是正文首段（开头常复述标题、带 `#`/`>` 之类 markdown 残留），
// 压成单行摘要并把重复标题剪掉，免得证据流被同一段标题噪声灌满。
function cleanText(value, title) {
  if (typeof value !== 'string') return '';
  let body = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/gu, ' ');
  if (!body) return '';
  body = body.replace(/^[#>*\-–—\s]+/u, '');
  const head = typeof title === 'string' ? title.trim() : '';
  if (head && body.toLowerCase().startsWith(head.toLowerCase())) {
    body = body.slice(head.length).replace(/^[#>*\-–—|:：\s]+/u, '');
  }
  return body;
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatContent({ query, sources }) {
  const lines = ['## Exa (语义检索)', `Query: ${query}`];
  lines.push('');
  sources.forEach((source, index) => {
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`   ${source.url}`);
    if (source.description) lines.push(`   ${source.description}`);
  });
  return lines.join('\n');
}

async function postJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Exa 拒绝鉴权：EXA_API_KEY 无效或已撤销');
    }
    if (response.status === 402) {
      throw new Error('Exa 额度不足（402）：账户余额/免费额度用尽');
    }
    if (response.status === 429) {
      throw new Error('Exa 速率受限（429）：请求过快');
    }
    if (!response.ok) {
      throw new Error(`Exa HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Exa 返回非 JSON 响应');
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Exa 请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clampCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(parsed, 1), 100);
}

function assertConfigured(value, message) {
  if (!value) throw new Error(message);
}

function trimSlash(value) {
  return (value || '').replace(/\/+$/u, '');
}
