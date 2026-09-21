// Serper 第 7 源：纯协议 Google SERP API —— 无浏览器、无代理池。
// 官方契约（已核实）: POST https://google.serper.dev/search
//                    header X-API-KEY / Content-Type: application/json
//                    body   { q, num, gl?, hl?, tbs? }
//                    resp   { organic: [{ title, link, snippet, position }], answerBox?, knowledgeGraph?, credits }

const DEFAULT_API_URL = 'https://google.serper.dev';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 10;

export function resolveSerperConfig(config = {}) {
  const apiUrl = trimSlash(config.serperApiUrl || DEFAULT_API_URL);
  const apiKey = (config.serperApiKey || '').trim();
  return {
    serperEnabled: config.serperEnabled !== false,
    serperApiUrl: apiUrl,
    serperApiKey: apiKey,
    hasSerperAccess: config.serperEnabled !== false && Boolean(apiKey)
  };
}

export function getSerperPublicConfig(config = {}) {
  const resolved = resolveSerperConfig(config);
  return {
    serperEnabled: resolved.serperEnabled,
    serperApiUrl: resolved.serperApiUrl,
    hasSerperApiKey: Boolean(resolved.serperApiKey),
    hasSerperAccess: resolved.hasSerperAccess
  };
}

export async function executeSerperSearch({
  config,
  query,
  maxResults = DEFAULT_MAX_RESULTS,
  gl = '',
  hl = '',
  timeRange = '',
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const resolved = resolveSerperConfig(config);
  assertConfigured(resolved.hasSerperAccess, '未配置 SERPER_API_KEY，跳过 Serper');

  const body = { q: query, num: clampCount(maxResults) };
  if (gl) body.gl = gl;
  if (hl) body.hl = hl;
  if (timeRange) body.tbs = timeRange;

  const payload = await postJson(`${resolved.serperApiUrl}/search`, {
    headers: { 'X-API-KEY': resolved.serperApiKey },
    body,
    timeoutMs
  });

  const sources = normalizeOrganic(payload);
  if (!sources.length) {
    throw new Error('Serper 返回空 organic 结果');
  }

  const answer = pickAnswer(payload);
  return {
    provider: 'serper',
    answer,
    sources,
    credits: Number.isFinite(payload?.credits) ? payload.credits : null,
    content: formatContent({ query, answer, sources })
  };
}

function normalizeOrganic(payload) {
  const items = Array.isArray(payload?.organic) ? payload.organic : [];
  return items
    .map((item) => {
      const url = typeof item?.link === 'string' ? item.link.trim() : '';
      if (!url) return null;
      return {
        title: (typeof item?.title === 'string' && item.title.trim()) || url,
        url,
        description: typeof item?.snippet === 'string' ? item.snippet.trim() : '',
        provider: 'serper'
      };
    })
    .filter(Boolean);
}

// Serper 除 organic 外常带 answerBox/knowledgeGraph —— 这是 Google 自己的直接答案，
// 比 snippet 更值钱，有就并进证据流（不给就用空串，不占位）。
function pickAnswer(payload) {
  const box = payload?.answerBox;
  if (box) {
    const text = [box.answer, box.snippet, box.title].find(
      (value) => typeof value === 'string' && value.trim()
    );
    if (text) return text.trim();
  }
  const graph = payload?.knowledgeGraph;
  if (graph && typeof graph.description === 'string' && graph.description.trim()) {
    return graph.description.trim();
  }
  return '';
}

function formatContent({ query, answer, sources }) {
  const lines = ['## Serper (Google SERP)', `Query: ${query}`];
  if (answer) lines.push('', `直接答案: ${answer}`);
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
      throw new Error('Serper 拒绝鉴权：SERPER_API_KEY 无效或已撤销');
    }
    if (response.status === 429) {
      throw new Error('Serper 额度/速率受限（429）：免费额度用尽或请求过快');
    }
    if (!response.ok) {
      throw new Error(`Serper HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Serper 返回非 JSON 响应');
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Serper 请求超时');
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
