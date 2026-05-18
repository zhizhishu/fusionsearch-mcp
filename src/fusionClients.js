import { mergeSources, splitAnswerAndSources } from './sourceCache.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_GROK_MODEL = 'grok-4.20-beta';
const DEFAULT_TAVILY_API_URL = 'https://api.tavily.com';
const DEFAULT_TAVILY_MCP_URL = 'https://tavily.ivanli.cc/mcp';
const DEFAULT_FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v2';
const DEFAULT_TIMEOUT_MS = 60_000;
const TAVILY_PROVIDER_REST = 'rest';
const TAVILY_PROVIDER_MCP = 'mcp';

export const DEFAULT_GROK_SYSTEM_PROMPT = [
  'You are FusionSearch MCP, a careful web research assistant.',
  'Tools and model-side analysis should operate in English when useful; final user-facing answers should be written in Chinese unless the user requests another language.',
  'Search results are evidence, not automatic truth. Cross-check important factual claims across independent sources whenever evidence is available.',
  'Prefer authoritative, recent, primary sources. State uncertainty, conflicts, scope limits, and confidence level when the evidence is incomplete.',
  'Use concise Markdown. Put direct conclusions first, then evidence and citations. Never fabricate citations.'
].join('\n');

export function resolveFusionConfig(config = {}) {
  const grokApiUrl = config.grokApiUrl || '';
  const grokApiKey = config.grokApiKey || '';
  const tavilyMcpToken = config.tavilyMcpToken || config.tavilyHikariToken || '';
  const tavilyMcpUrl = config.tavilyMcpUrl || config.tavilyHikariUrl || (tavilyMcpToken ? DEFAULT_TAVILY_MCP_URL : '');
  const tavilyApiUrl = config.tavilyApiUrl || DEFAULT_TAVILY_API_URL;
  const tavilyApiKey = config.tavilyApiKey || '';
  const tavilyProvider = resolveTavilyProvider(config.tavilyProvider, {
    tavilyMcpUrl,
    tavilyMcpToken
  });
  const firecrawlApiUrl = config.firecrawlApiUrl || DEFAULT_FIRECRAWL_API_URL;
  const firecrawlApiKey = config.firecrawlApiKey || '';
  const tavilyEnabled = config.tavilyEnabled !== false;

  return {
    grokApiUrl,
    grokApiKey,
    grokModel: applyModelSuffix(config.grokModel || DEFAULT_GROK_MODEL, grokApiUrl),
    tavilyEnabled,
    tavilyProvider,
    tavilyApiUrl,
    tavilyApiKey,
    tavilyMcpUrl,
    tavilyMcpToken,
    tavilyMcpSearchTool: config.tavilyMcpSearchTool || '',
    tavilyMcpExtractTool: config.tavilyMcpExtractTool || '',
    tavilyMcpMapTool: config.tavilyMcpMapTool || '',
    firecrawlApiUrl,
    firecrawlApiKey,
    grokSystemPrompt: config.grokSystemPrompt || DEFAULT_GROK_SYSTEM_PROMPT
  };
}

function resolveTavilyProvider(value, { tavilyMcpUrl, tavilyMcpToken }) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ([TAVILY_PROVIDER_REST, TAVILY_PROVIDER_MCP].includes(normalized)) {
    return normalized;
  }
  return tavilyMcpUrl || tavilyMcpToken ? TAVILY_PROVIDER_MCP : TAVILY_PROVIDER_REST;
}

export function getFusionPublicConfig(config = {}) {
  const resolved = resolveFusionConfig(config);
  return {
    grokApiUrl: resolved.grokApiUrl,
    grokModel: resolved.grokModel,
    tavilyEnabled: resolved.tavilyEnabled,
    tavilyProvider: resolved.tavilyProvider,
    tavilyApiUrl: resolved.tavilyApiUrl,
    tavilyMcpUrl: resolved.tavilyMcpUrl,
    tavilyMcpSearchTool: resolved.tavilyMcpSearchTool,
    tavilyMcpExtractTool: resolved.tavilyMcpExtractTool,
    tavilyMcpMapTool: resolved.tavilyMcpMapTool,
    firecrawlApiUrl: resolved.firecrawlApiUrl,
    grokSystemPrompt: resolved.grokSystemPrompt,
    hasGrokApiKey: Boolean(resolved.grokApiKey),
    hasTavilyApiKey: Boolean(resolved.tavilyApiKey),
    hasTavilyMcpToken: Boolean(resolved.tavilyMcpToken),
    hasTavilyCredentials: hasTavilyAccess(resolved),
    hasFirecrawlApiKey: Boolean(resolved.firecrawlApiKey)
  };
}

export async function executeGrokWebSearch({
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
  if (resolved.tavilyEnabled && hasTavilyAccess(resolved)) {
    const content = await tavilyExtract(resolved, url, timeoutMs).catch(() => '');
    if (content) {
      return { provider: resolved.tavilyProvider === TAVILY_PROVIDER_MCP ? 'tavily-mcp' : 'tavily', content };
    }
  }

  if (resolved.firecrawlApiKey) {
    const content = await firecrawlScrape(resolved, url, timeoutMs).catch(() => '');
    if (content) {
      return { provider: 'firecrawl', content };
    }
  }

  if (!hasTavilyAccess(resolved) && !resolved.firecrawlApiKey) {
    throw new Error('Tavily 和 Firecrawl 均未配置，无法抓取网页正文');
  }
  throw new Error('Tavily/Firecrawl 均未能抓取该页面');
}

export async function executeTavilySearchOnly({
  config,
  query,
  maxResults = 5
}) {
  const resolved = resolveFusionConfig(config);
  if (!resolved.tavilyEnabled) {
    throw new Error('Tavily 当前已关闭');
  }
  assertConfigured(hasTavilyAccess(resolved), 'Tavily REST Key 或 MCP Token 未配置');
  const results = await tavilySearch(resolved, query, maxResults);
  return {
    provider: resolved.tavilyProvider === TAVILY_PROVIDER_MCP ? 'tavily-mcp' : 'tavily',
    results
  };
}

export async function executeTavilyExtractOnly({ config, url, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const resolved = resolveFusionConfig(config);
  if (!resolved.tavilyEnabled) {
    throw new Error('Tavily 当前已关闭');
  }
  assertConfigured(hasTavilyAccess(resolved), 'Tavily REST Key 或 MCP Token 未配置');
  const content = await tavilyExtract(resolved, url, timeoutMs);
  return {
    provider: resolved.tavilyProvider === TAVILY_PROVIDER_MCP ? 'tavily-mcp' : 'tavily',
    content
  };
}

export async function executeFirecrawlFetch({ config, url, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const resolved = resolveFusionConfig(config);
  assertConfigured(resolved.firecrawlApiKey, 'Firecrawl API Key 未配置');
  const content = await firecrawlScrape(resolved, url, timeoutMs);
  return {
    provider: 'firecrawl',
    content
  };
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
  if (resolved.tavilyProvider === TAVILY_PROVIDER_MCP) {
    return tavilyMcpMap(resolved, {
      url,
      instructions,
      maxDepth,
      maxBreadth,
      limit,
      timeout
    });
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
  if (resolved.tavilyEnabled && hasTavilyAccess(resolved)) {
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
  if (resolved.tavilyProvider === TAVILY_PROVIDER_MCP) {
    return tavilyMcpSearch(resolved, query, maxResults);
  }
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
  if (resolved.tavilyProvider === TAVILY_PROVIDER_MCP) {
    return tavilyMcpExtract(resolved, url, timeoutMs);
  }
  const data = await postJson(`${trimSlash(resolved.tavilyApiUrl)}/extract`, {
    headers: authHeaders(resolved.tavilyApiKey),
    body: { urls: [url], format: 'markdown' },
    timeoutMs
  });
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  const content = first?.raw_content || first?.content || '';
  return typeof content === 'string' ? content.trim() : '';
}

async function tavilyMcpSearch(resolved, query, maxResults) {
  const { toolName, payload } = await callTavilyMcpTool(
    resolved,
    'search',
    { query, maxResults },
    90_000
  );
  return normalizeTavilySources(payload, 'tavily-mcp', toolName).slice(0, maxResults);
}

async function tavilyMcpExtract(resolved, url, timeoutMs) {
  const { payload } = await callTavilyMcpTool(
    resolved,
    'extract',
    { url },
    timeoutMs
  );
  return extractTavilyContent(payload);
}

async function tavilyMcpMap(resolved, values) {
  const { toolName, payload } = await callTavilyMcpTool(
    resolved,
    'map',
    values,
    (values.timeout + 10) * 1000
  );
  return {
    baseUrl: payload?.base_url || payload?.baseUrl || values.url,
    results: normalizeTavilyMapResults(payload),
    responseTime: payload?.response_time ?? payload?.responseTime ?? null,
    payload: {
      provider: 'tavily-mcp',
      toolName,
      data: payload
    }
  };
}

async function callTavilyMcpTool(resolved, intent, values, timeoutMs) {
  assertConfigured(resolved.tavilyMcpUrl, 'Tavily MCP URL is not configured');
  assertConfigured(resolved.tavilyMcpToken, 'Tavily MCP bearer token is not configured');

  const client = new Client({
    name: 'fusionsearch-mcp',
    version: '1.0.0'
  });
  const transport = new StreamableHTTPClientTransport(new URL(resolved.tavilyMcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${resolved.tavilyMcpToken}`
      }
    }
  });

  try {
    await client.connect(transport, { timeout: Math.min(timeoutMs, 15_000) });
    const listed = await client.listTools(undefined, { timeout: Math.min(timeoutMs, 20_000) });
    const tool = selectTavilyMcpTool(listed?.tools || [], intent, resolved);
    const result = await client.callTool(
      {
        name: tool.name,
        arguments: buildTavilyMcpArguments(tool, intent, values)
      },
      undefined,
      { timeout: timeoutMs }
    );
    if (result?.isError) {
      throw new Error(extractMcpErrorText(result) || `Tavily MCP tool ${tool.name} returned an error`);
    }
    return {
      toolName: tool.name,
      payload: extractMcpPayload(result)
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function selectTavilyMcpTool(tools, intent, resolved) {
  const overrideKey = {
    search: 'tavilyMcpSearchTool',
    extract: 'tavilyMcpExtractTool',
    map: 'tavilyMcpMapTool'
  }[intent];
  const override = (resolved[overrideKey] || '').trim();
  if (override) {
    const matched = tools.find((tool) => tool.name === override);
    if (matched) return matched;
    throw new Error(`Tavily MCP tool "${override}" was not found. Available tools: ${tools.map((tool) => tool.name).join(', ') || 'none'}`);
  }

  const exactNames = {
    search: ['tavily_search', 'search', 'web_search'],
    extract: ['tavily_extract', 'extract', 'web_fetch', 'fetch', 'scrape'],
    map: ['tavily_map', 'map', 'web_map', 'site_map']
  }[intent];
  const exact = tools.find((tool) => exactNames.includes(tool.name));
  if (exact) return exact;

  const hints = {
    search: ['search'],
    extract: ['extract', 'fetch', 'scrape'],
    map: ['map', 'crawl']
  }[intent];
  const scored = tools
    .map((tool) => ({
      tool,
      score: hints.reduce((sum, hint) => sum + (tool.name.toLowerCase().includes(hint) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0) return scored[0].tool;

  throw new Error(`No Tavily MCP ${intent} tool found. Available tools: ${tools.map((tool) => tool.name).join(', ') || 'none'}`);
}

function buildTavilyMcpArguments(tool, intent, values) {
  const props = tool?.inputSchema?.properties || {};
  const hasSchema = Object.keys(props).length > 0;
  const args = {};
  const set = (aliases, value) => {
    if (value === undefined || value === null || value === '') return;
    const key = hasSchema ? aliases.find((alias) => Object.hasOwn(props, alias)) : aliases[0];
    if (key) args[key] = value;
  };

  if (intent === 'search') {
    set(['query', 'q', 'searchQuery'], values.query);
    set(['max_results', 'maxResults', 'limit', 'count', 'num_results'], values.maxResults);
    set(['search_depth', 'searchDepth'], 'advanced');
    set(['include_raw_content', 'includeRawContent'], false);
    set(['include_answer', 'includeAnswer'], false);
  } else if (intent === 'extract') {
    if (hasSchema && Object.hasOwn(props, 'urls')) {
      args.urls = [values.url];
    } else {
      set(['url', 'uri'], values.url);
      set(['urls'], [values.url]);
    }
    set(['format'], 'markdown');
  } else if (intent === 'map') {
    set(['url', 'uri'], values.url);
    set(['instructions'], values.instructions);
    set(['max_depth', 'maxDepth'], values.maxDepth);
    set(['max_breadth', 'maxBreadth'], values.maxBreadth);
    set(['limit', 'maxResults'], values.limit);
    set(['timeout'], values.timeout);
  }

  return args;
}

function extractMcpPayload(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = Array.isArray(result?.content)
    ? result.content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text.trim())
        .filter(Boolean)
    : [];
  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // Keep looking for structured JSON text before falling back to plain text.
    }
  }
  return texts.length === 1 ? { text: texts[0] } : { content: texts, text: texts.join('\n') };
}

function extractMcpErrorText(result) {
  return Array.isArray(result?.content)
    ? result.content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
        .trim()
    : '';
}

function normalizeTavilySources(payload, provider, toolName = '') {
  return findResultArray(payload)
    .map((item) => {
      if (typeof item === 'string') {
        return {
          title: item,
          url: item,
          description: '',
          provider,
          toolName
        };
      }
      return {
        title: item?.title || item?.name || item?.url || '',
        url: item?.url || item?.link || item?.href || '',
        description: item?.content || item?.description || item?.snippet || item?.summary || '',
        provider,
        toolName,
        score: item?.score
      };
    })
    .filter((item) => item.url || item.title || item.description);
}

function normalizeTavilyMapResults(payload) {
  return findResultArray(payload)
    .map((item) => (typeof item === 'string' ? item : item?.url || item?.link || item?.href || item))
    .filter(Boolean);
}

function findResultArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.results,
    payload.urls,
    payload.links,
    payload.items,
    payload.sources,
    payload.data?.web,
    payload.data?.results,
    payload.data
  ];
  return candidates.find((value) => Array.isArray(value)) || [];
}

function extractTavilyContent(payload) {
  if (typeof payload === 'string') return payload.trim();
  const first = Array.isArray(payload?.results) ? payload.results[0] : null;
  const content =
    first?.raw_content ||
    first?.rawContent ||
    first?.content ||
    first?.markdown ||
    payload?.raw_content ||
    payload?.rawContent ||
    payload?.content ||
    payload?.markdown ||
    payload?.text ||
    '';
  return typeof content === 'string' ? content.trim() : '';
}

function hasTavilyAccess(resolved) {
  if (resolved.tavilyProvider === TAVILY_PROVIDER_MCP) {
    return Boolean(resolved.tavilyMcpUrl && resolved.tavilyMcpToken);
  }
  return Boolean(resolved.tavilyApiKey);
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
