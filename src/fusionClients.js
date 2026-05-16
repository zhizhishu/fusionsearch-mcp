import { mergeSources, splitAnswerAndSources } from './sourceCache.js';

const DEFAULT_GUDA_BASE_URL = 'https://code.guda.studio';
const DEFAULT_GROK_MODEL = 'grok-4.20-beta';
const DEFAULT_TAVILY_API_URL = 'https://api.tavily.com';
const DEFAULT_FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v2';
const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_GROK_SYSTEM_PROMPT = [
  'You are FusionSearch MCP, a careful web research assistant.',
  'Tools and model-side analysis should operate in English when useful; final user-facing answers should be written in Chinese unless the user requests another language.',
  'Search results are evidence, not automatic truth. Cross-check important factual claims across independent sources whenever evidence is available.',
  'Prefer authoritative, recent, primary sources. State uncertainty, conflicts, scope limits, and confidence level when the evidence is incomplete.',
  'Use concise Markdown. Put direct conclusions first, then evidence and citations. Never fabricate citations.'
].join('\n');

export function resolveFusionConfig(config = {}) {
  const gudaBaseUrl = config.gudaBaseUrl || DEFAULT_GUDA_BASE_URL;
  const gudaApiKey = config.gudaApiKey || '';
  const grokApiUrl = config.grokApiUrl || (gudaApiKey ? `${gudaBaseUrl}/grok/v1` : '');
  const grokApiKey = config.grokApiKey || gudaApiKey || '';
  const tavilyApiUrl = resolveProviderUrl({
    configuredUrl: config.tavilyApiUrl,
    defaultUrl: DEFAULT_TAVILY_API_URL,
    gudaUrl: `${gudaBaseUrl}/tavily`,
    gudaApiKey,
    providerApiKey: config.tavilyApiKey
  });
  const tavilyApiKey = config.tavilyApiKey || gudaApiKey || '';
  const firecrawlApiUrl = resolveProviderUrl({
    configuredUrl: config.firecrawlApiUrl,
    defaultUrl: DEFAULT_FIRECRAWL_API_URL,
    gudaUrl: `${gudaBaseUrl}/firecrawl`,
    gudaApiKey,
    providerApiKey: config.firecrawlApiKey
  });
  const firecrawlApiKey = config.firecrawlApiKey || gudaApiKey || '';
  const tavilyEnabled = config.tavilyEnabled !== false;

  return {
    gudaBaseUrl,
    gudaApiKey,
    grokApiUrl,
    grokApiKey,
    grokModel: applyModelSuffix(config.grokModel || DEFAULT_GROK_MODEL, grokApiUrl),
    tavilyEnabled,
    tavilyApiUrl,
    tavilyApiKey,
    firecrawlApiUrl,
    firecrawlApiKey,
    grokSystemPrompt: config.grokSystemPrompt || DEFAULT_GROK_SYSTEM_PROMPT
  };
}

function resolveProviderUrl({ configuredUrl, defaultUrl, gudaUrl, gudaApiKey, providerApiKey }) {
  const value = configuredUrl || '';
  if (gudaApiKey && !providerApiKey && (!value || value === defaultUrl)) {
    return gudaUrl;
  }
  return value || defaultUrl;
}

export function getFusionPublicConfig(config = {}) {
  const resolved = resolveFusionConfig(config);
  return {
    gudaBaseUrl: resolved.gudaBaseUrl,
    grokApiUrl: resolved.grokApiUrl,
    grokModel: resolved.grokModel,
    tavilyEnabled: resolved.tavilyEnabled,
    tavilyApiUrl: resolved.tavilyApiUrl,
    firecrawlApiUrl: resolved.firecrawlApiUrl,
    grokSystemPrompt: resolved.grokSystemPrompt,
    hasGudaApiKey: Boolean(resolved.gudaApiKey),
    hasGrokApiKey: Boolean(resolved.grokApiKey),
    hasTavilyApiKey: Boolean(resolved.tavilyApiKey),
    hasFirecrawlApiKey: Boolean(resolved.firecrawlApiKey)
  };
}

export async function executeGrokSearch({
  config,
  query,
  platform = '',
  model = '',
  extraSources = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const resolved = resolveFusionConfig(config);
  assertConfigured(resolved.grokApiUrl, 'Grok API URL 未配置');
  assertConfigured(resolved.grokApiKey, 'Grok API Key 未配置');

  const effectiveModel = model ? applyModelSuffix(model, resolved.grokApiUrl) : resolved.grokModel;
  const prompt = [
    getLocalTimeContext(),
    query,
    platform ? `\nFocus platforms: ${platform}` : ''
  ].join('\n');

  const payload = {
    model: effectiveModel,
    messages: [
      { role: 'system', content: resolved.grokSystemPrompt },
      { role: 'user', content: prompt }
    ],
    stream: false
  };

  const data = await postJson(`${trimSlash(resolved.grokApiUrl)}/chat/completions`, {
    headers: authHeaders(resolved.grokApiKey),
    body: payload,
    timeoutMs
  });

  const rawAnswer = extractChatContent(data);
  const split = splitAnswerAndSources(rawAnswer);
  const extra = extraSources > 0 ? await collectExtraSources(resolved, query, extraSources) : [];
  const sources = mergeSources(split.sources, extra);

  return {
    content: split.answer || rawAnswer,
    model: effectiveModel,
    sources,
    sourcesCount: sources.length
  };
}

export async function fetchAvailableModels({ config, timeoutMs = 10_000 }) {
  const resolved = resolveFusionConfig(config);
  assertConfigured(resolved.grokApiUrl, 'Grok API URL 未配置');
  assertConfigured(resolved.grokApiKey, 'Grok API Key 未配置');

  const data = await getJson(`${trimSlash(resolved.grokApiUrl)}/models`, {
    headers: authHeaders(resolved.grokApiKey),
    timeoutMs
  });
  return Array.isArray(data?.data)
    ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id)
    : [];
}

export async function executeTavilyFetch({ config, url, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const resolved = resolveFusionConfig(config);
  if (resolved.tavilyEnabled && resolved.tavilyApiKey) {
    const content = await tavilyExtract(resolved, url, timeoutMs).catch(() => '');
    if (content) {
      return { provider: 'tavily', content };
    }
  }

  if (resolved.firecrawlApiKey) {
    const content = await firecrawlScrape(resolved, url, timeoutMs).catch(() => '');
    if (content) {
      return { provider: 'firecrawl', content };
    }
  }

  if (!resolved.tavilyApiKey && !resolved.firecrawlApiKey) {
    throw new Error('Tavily 和 Firecrawl 均未配置，无法抓取网页正文');
  }
  throw new Error('Tavily/Firecrawl 均未能抓取该页面');
}

export async function executeTavilyMap({
  config,
  url,
  instructions = '',
  maxDepth = 1,
  maxBreadth = 20,
  limit = 50,
  timeout = 150
}) {
  const resolved = resolveFusionConfig(config);
  if (!resolved.tavilyEnabled) {
    throw new Error('Tavily 当前已关闭');
  }
  assertConfigured(resolved.tavilyApiKey, 'Tavily API Key 未配置');

  const data = await postJson(`${trimSlash(resolved.tavilyApiUrl)}/map`, {
    headers: authHeaders(resolved.tavilyApiKey),
    body: {
      url,
      max_depth: maxDepth,
      max_breadth: maxBreadth,
      limit,
      timeout,
      ...(instructions ? { instructions } : {})
    },
    timeoutMs: (timeout + 10) * 1000
  });

  return {
    baseUrl: data?.base_url || url,
    results: Array.isArray(data?.results) ? data.results : [],
    responseTime: data?.response_time ?? null,
    payload: data
  };
}

export async function buildFusionConfigInfo({ config, testConnection = false }) {
  const publicConfig = getFusionPublicConfig(config);
  const info = {
    ...publicConfig,
    configStatus: publicConfig.hasGrokApiKey && publicConfig.grokApiUrl ? '配置完整' : 'Grok 未配置',
    connectionTest: null
  };

  if (!testConnection) return info;

  const startedAt = Date.now();
  try {
    const models = await fetchAvailableModels({ config, timeoutMs: 10_000 });
    info.connectionTest = {
      ok: true,
      responseTimeMs: Date.now() - startedAt,
      modelCount: models.length,
      availableModels: models
    };
  } catch (error) {
    info.connectionTest = {
      ok: false,
      responseTimeMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return info;
}

async function collectExtraSources(resolved, query, count) {
  const tasks = [];
  if (resolved.tavilyEnabled && resolved.tavilyApiKey) {
    tasks.push(tavilySearch(resolved, query, count));
  }
  if (resolved.firecrawlApiKey) {
    tasks.push(firecrawlSearch(resolved, query, count));
  }

  if (tasks.length === 0) return [];
  const settled = await Promise.allSettled(tasks);
  return mergeSources(
    ...settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
  ).slice(0, count);
}

async function tavilySearch(resolved, query, maxResults) {
  const data = await postJson(`${trimSlash(resolved.tavilyApiUrl)}/search`, {
    headers: authHeaders(resolved.tavilyApiKey),
    body: {
      query,
      max_results: maxResults,
      search_depth: 'advanced',
      include_raw_content: false,
      include_answer: false
    },
    timeoutMs: 90_000
  });
  return Array.isArray(data?.results)
    ? data.results.map((item) => ({
        title: item?.title || '',
        url: item?.url || '',
        description: item?.content || '',
        provider: 'tavily',
        score: item?.score
      }))
    : [];
}

async function firecrawlSearch(resolved, query, limit) {
  const data = await postJson(`${trimSlash(resolved.firecrawlApiUrl)}/search`, {
    headers: authHeaders(resolved.firecrawlApiKey),
    body: { query, limit },
    timeoutMs: 90_000
  });
  const web = Array.isArray(data?.data?.web) ? data.data.web : Array.isArray(data?.data) ? data.data : [];
  return web.map((item) => ({
    title: item?.title || '',
    url: item?.url || '',
    description: item?.description || item?.content || '',
    provider: 'firecrawl'
  }));
}

async function tavilyExtract(resolved, url, timeoutMs) {
  const data = await postJson(`${trimSlash(resolved.tavilyApiUrl)}/extract`, {
    headers: authHeaders(resolved.tavilyApiKey),
    body: { urls: [url], format: 'markdown' },
    timeoutMs
  });
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  const content = first?.raw_content || first?.content || '';
  return typeof content === 'string' ? content.trim() : '';
}

async function firecrawlScrape(resolved, url, timeoutMs) {
  const data = await postJson(`${trimSlash(resolved.firecrawlApiUrl)}/scrape`, {
    headers: authHeaders(resolved.firecrawlApiKey),
    body: {
      url,
      formats: ['markdown'],
      timeout: Math.min(timeoutMs, 60_000)
    },
    timeoutMs
  });
  const content = data?.data?.markdown || data?.markdown || '';
  return typeof content === 'string' ? content.trim() : '';
}

async function postJson(url, { headers, body, timeoutMs }) {
  return requestJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeoutMs
  });
}

async function getJson(url, { headers, timeoutMs }) {
  return requestJson(url, {
    method: 'GET',
    headers,
    timeoutMs
  });
}

async function requestJson(url, { method, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { text };
    }
    if (!response.ok) {
      const error = new Error(`${method} ${url} 响应 ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text.slice(0, 1200);
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试或调大 timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractChatContent(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return choice?.message?.content || choice?.delta?.content || payload?.content || payload?.text || '';
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function assertConfigured(value, message) {
  if (!value) throw new Error(message);
}

function trimSlash(value) {
  return (value || '').replace(/\/+$/u, '');
}

function applyModelSuffix(model, apiUrl) {
  if (apiUrl?.includes('openrouter') && model && !model.includes(':online')) {
    return `${model}:online`;
  }
  return model;
}

function getLocalTimeContext() {
  const now = new Date();
  return [
    '[Current Time Context]',
    `- Date: ${now.toLocaleDateString('en-CA')}`,
    `- Time: ${now.toLocaleTimeString('en-GB', { hour12: false })}`,
    `- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'}`
  ].join('\n');
}
