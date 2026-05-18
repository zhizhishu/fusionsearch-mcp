import express from 'express';
import cors from 'cors';
import { randomBytes, randomUUID } from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { executeSearch, resolveQuery, buildSummaryLines } from './searchClient.js';
import {
  DEFAULT_GROK_SYSTEM_PROMPT,
  buildFusionConfigInfo,
  executeFirecrawlFetch,
  executeGrokWebSearch,
  executeTavilyExtractOnly,
  executeTavilyFetch,
  executeTavilyMap,
  executeTavilySearchOnly,
  fetchAvailableModels,
  getFusionPublicConfig
} from './fusionClients.js';
import {
  buildKeyStatus,
  buildMonitoringSnapshot,
  createMonitoringState,
  runMonitoringProbe
} from './monitoring.js';
import {
  executeSmartFetch,
  executeSmartResearch,
  formatSmartFetchResult,
  formatSmartResearchResult
} from './smartRouter.js';
import { SourceCache, mergeSources, newSessionId } from './sourceCache.js';
import { createAuth } from './auth.js';
import { configureLogger, getLogFilePath, logEvent, readLogEntries } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(__dirname, '../public/admin');
const ADMIN_TEST_TIMEOUT_MS = 15_000;

export const DEFAULT_CONFIG = {
  serverName: 'fusionsearch-mcp',
  serverVersion: '1.0.0',
  searchEndpoint: 'https://echocq-libresearch.hf.space/search',
  searchShChatEndpoint: '',
  searchShApiKey: '',
  searchShProjectUrl: 'https://github.com/lza6/Search-2api',
  grokApiUrl: '',
  grokApiKey: '',
  grokModel: 'grok-4.20-beta',
  grokSystemPrompt: DEFAULT_GROK_SYSTEM_PROMPT,
  tavilyEnabled: true,
  tavilyProvider: 'rest',
  tavilyApiUrl: 'https://api.tavily.com',
  tavilyApiKey: '',
  tavilyMcpUrl: '',
  tavilyMcpToken: '',
  tavilyMcpSearchTool: '',
  tavilyMcpExtractTool: '',
  tavilyMcpMapTool: '',
  firecrawlApiUrl: 'https://api.firecrawl.dev/v2',
  firecrawlApiKey: '',
  hfEndpoint: 'https://huggingface.co',
  hfSpaceId: '',
  defaultParams: {
    categories: 'general',
    pageno: '1',
    language: 'auto',
    time_range: '',
    safesearch: '0',
    format: 'json'
  }
};

const SEARCH_2API_REPO_API = 'https://api.github.com/repos/lza6/Search-2api/commits/main';
const SEARCH_2API_STALE_DAYS = 180;
const HF_SECRET_OPTIONS = [
  { key: 'ADMIN_TOKEN', label: 'Admin login token', multiline: false },
  { key: 'SESSION_SECRET', label: 'Session signing secret', multiline: false },
  { key: 'MCP_AUTH_TOKEN', label: 'MCP bearer token', multiline: false },
  { key: 'SEARCH_ENDPOINT', label: 'LibreSearch/SearXNG endpoint', multiline: false },
  { key: 'SEARCH_SH_COOKIE', label: 'search.sh cookie', multiline: true },
  { key: 'SEARCH_SH_USER_AGENT', label: 'search.sh User-Agent', multiline: true },
  { key: 'API_MASTER_KEY', label: 'Search-2api bearer token', multiline: false },
  { key: 'SEARCH_SH_API_KEY', label: 'External Search-2api bearer token', multiline: false },
  { key: 'SEARCH_SH_CHAT_ENDPOINT', label: 'Search-2api chat endpoint', multiline: false },
  { key: 'GROK_API_URL', label: 'Grok/OpenAI-compatible URL', multiline: false },
  { key: 'GROK_API_KEY', label: 'Grok API key', multiline: false },
  { key: 'GROK_MODEL', label: 'Grok model', multiline: false },
  { key: 'GROK_SYSTEM_PROMPT', label: 'Grok system prompt', multiline: true },
  { key: 'TAVILY_ENABLED', label: 'Tavily enabled', multiline: false },
  { key: 'TAVILY_PROVIDER', label: 'Tavily provider: rest or mcp', multiline: false },
  { key: 'TAVILY_API_URL', label: 'Tavily REST API URL', multiline: false },
  { key: 'TAVILY_API_KEY', label: 'Tavily REST API key', multiline: false },
  { key: 'TAVILY_MCP_URL', label: 'Custom Tavily MCP URL', multiline: false },
  { key: 'TAVILY_MCP_TOKEN', label: 'Tavily MCP bearer token', multiline: false },
  { key: 'TAVILY_HIKARI_TOKEN', label: 'Tavily Hikari bearer token alias', multiline: false },
  { key: 'TAVILY_MCP_SEARCH_TOOL', label: 'Tavily MCP search tool override', multiline: false },
  { key: 'TAVILY_MCP_EXTRACT_TOOL', label: 'Tavily MCP extract tool override', multiline: false },
  { key: 'TAVILY_MCP_MAP_TOOL', label: 'Tavily MCP map tool override', multiline: false },
  { key: 'FIRECRAWL_API_URL', label: 'Firecrawl API URL', multiline: false },
  { key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', multiline: false },
  { key: 'RUNTIME_CONFIG_PATH', label: 'Runtime config path', multiline: false },
  { key: 'HF_WRITE_TOKEN', label: 'HF write token for future secret edits', multiline: false }
];
const HF_SECRET_KEYS = HF_SECRET_OPTIONS.map((item) => item.key);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const searchOptionShape = {
  page: z
    .number()
    .int()
    .min(1)
    .describe('页码，对应原始 API 的 pageno 参数')
    .optional(),
  language: z.string().describe('语言代码，例如 auto/en/zh-CN').optional(),
  time_range: z.string().describe('时间范围过滤，例如 day/week/month').optional(),
  safesearch: z
    .enum(['0', '1', '2'])
    .describe('安全搜索级别，对应 API 的 safesearch 参数')
    .optional(),
  categories: z
    .string()
    .describe('SearXNG 搜索分类，例如 general/images/news/videos/it')
    .optional(),
  category_general: z.string().describe('兼容旧接口的 category_general 参数').optional(),
  extraParams: z
    .record(z.string())
    .describe('自定义传递给搜索 API 的其它查询参数，键值都为字符串')
    .optional()
};
const searchOptionSchema = z.object(searchOptionShape);

const adminDefaultParamsSchema = z.object({
  categories: z.string().trim().optional(),
  pageno: z.string().trim().optional(),
  language: z.string().trim().optional(),
  time_range: z.string().trim().optional(),
  safesearch: z.enum(['0', '1', '2']).optional(),
  format: z.enum(['json', 'html', 'csv', 'rss']).optional(),
  category_general: z.string().trim().optional()
});

const adminConfigUpdateSchema = z.object({
  searchEndpoint: z.string().trim().url().optional(),
  searchShChatEndpoint: z.union([z.string().trim().url(), z.literal('')]).optional(),
  searchShApiKey: z.string().optional(),
  clearSearchShApiKey: z.boolean().optional(),
  grokApiUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
  grokApiKey: z.string().optional(),
  clearGrokApiKey: z.boolean().optional(),
  grokModel: z.string().trim().optional(),
  grokSystemPrompt: z.string().trim().optional(),
  tavilyEnabled: z.boolean().optional(),
  tavilyProvider: z.enum(['rest', 'mcp']).optional(),
  tavilyApiUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
  tavilyApiKey: z.string().optional(),
  clearTavilyApiKey: z.boolean().optional(),
  tavilyMcpUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
  tavilyMcpToken: z.string().optional(),
  clearTavilyMcpToken: z.boolean().optional(),
  tavilyMcpSearchTool: z.string().trim().optional(),
  tavilyMcpExtractTool: z.string().trim().optional(),
  tavilyMcpMapTool: z.string().trim().optional(),
  firecrawlApiUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
  firecrawlApiKey: z.string().optional(),
  clearFirecrawlApiKey: z.boolean().optional(),
  defaultParams: adminDefaultParamsSchema.optional()
});

const optionalTokenSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional()
);

const adminSecurityUpdateSchema = z.object({
  currentAdminToken: z.string().optional(),
  newAdminToken: optionalTokenSchema,
  newMcpAuthToken: optionalTokenSchema,
  clearMcpAuthToken: z.boolean().optional(),
  rotateSessionSecret: z.boolean().optional(),
  syncHfSecrets: z.boolean().optional(),
  hfToken: z.string().trim().optional()
}).refine((input) => (
  Boolean(input.newAdminToken || input.newMcpAuthToken || input.clearMcpAuthToken || input.rotateSessionSecret)
), {
  message: '至少需要提交一个安全变更'
});

const adminLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(120),
  level: z.enum(['', 'debug', 'info', 'warn', 'error']).default(''),
  scope: z.string().trim().max(80).default('')
});

const hfSecretUpdateSchema = z.object({
  hfToken: z.string().trim().optional(),
  secrets: z
    .array(
      z.object({
        key: z.enum(HF_SECRET_KEYS),
        value: z.string().min(1).max(50_000),
        description: z.string().trim().max(300).optional()
      })
    )
    .min(1)
    .max(HF_SECRET_KEYS.length)
});

const adminSearchTestSchema = z.object({
  query: z.string().trim().min(1).default('test'),
  categories: z.string().trim().optional(),
  page: z.number().int().min(1).optional(),
  language: z.string().trim().optional(),
  time_range: z.string().trim().optional(),
  safesearch: z.enum(['0', '1', '2']).optional()
});

const adminSearchShTestSchema = z.object({
  prompt: z.string().trim().min(1).default('test'),
  model: z.string().trim().optional()
});

const adminGrokTestSchema = z.object({
  query: z.string().trim().min(1).default('test'),
  platform: z.string().trim().optional(),
  model: z.string().trim().optional(),
  extraSources: z.number().int().min(0).max(10).optional()
});

const adminTavilySearchTestSchema = z.object({
  query: z.string().trim().min(1).default('test'),
  maxResults: z.number().int().min(1).max(20).optional()
});

const adminFetchTestSchema = z.object({
  url: z.string().trim().url()
});

const adminMapTestSchema = z.object({
  url: z.string().trim().url(),
  instructions: z.string().trim().optional(),
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxBreadth: z.number().int().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  timeout: z.number().int().min(10).max(150).optional()
});

const adminLoginSchema = z.object({
  token: z.string().min(1)
});

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function envEnabled(name, fallback = false) {
  if (process.env[name] === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(process.env[name].toLowerCase());
}

function normalizeBaseUrl(value, fallback) {
  const base = (value || fallback).trim();
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function buildMountedPath(req, keepBase = false) {
  const url = req.url || '/';
  if (!keepBase) return url;
  if (url === '/') return req.baseUrl || '/';
  if (url.startsWith('/?')) return `${req.baseUrl}${url.slice(1)}`;
  return `${req.baseUrl}${url}`;
}

function buildExactSearchPath(req) {
  const suffix = req.originalUrl.slice('/search'.length);
  return `/search${suffix}`;
}

function buildProxyUrl(baseUrl, pathAndQuery) {
  const relative = (pathAndQuery || '/').replace(/^\/+/, '');
  return new URL(relative, `${baseUrl}/`).toString();
}

function copyProxyRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey) || lowerKey === 'host' || lowerKey === 'content-length') {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.protocol || 'http';
  return headers;
}

function copyProxyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerKey) ||
      lowerKey === 'content-length' ||
      lowerKey === 'content-encoding'
    ) {
      return;
    }
    res.setHeader(key, value);
  });
}

async function proxyRequest(req, res, { baseUrl, pathAndQuery }) {
  const targetUrl = buildProxyUrl(baseUrl, pathAndQuery);
  const init = {
    method: req.method,
    headers: copyProxyRequestHeaders(req),
    redirect: 'manual'
  };

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    const contentType = String(req.headers['content-type'] ?? '');
    if (req.body !== undefined && contentType.includes('application/json')) {
      init.body = JSON.stringify(req.body);
      init.headers['content-type'] = contentType;
    } else {
      init.body = req;
      init.duplex = 'half';
    }
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (error) {
    res.status(502).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: `上游服务暂时不可用: ${baseUrl}`,
        detail: error instanceof Error ? error.message : String(error)
      }
    });
    return;
  }

  res.status(upstream.status);
  copyProxyResponseHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

function registerGatewayProxy(app) {
  if (!envEnabled('ENABLE_GATEWAY_PROXY')) return;

  const libresearchBaseUrl = normalizeBaseUrl(process.env.LIBRESEARCH_BASE_URL, 'http://127.0.0.1:8080');
  const search2apiBaseUrl = normalizeBaseUrl(process.env.SEARCH2API_BASE_URL, 'http://127.0.0.1:8000');

  app.use('/search2api', asyncHandler(async (req, res) => {
    await proxyRequest(req, res, {
      baseUrl: search2apiBaseUrl,
      pathAndQuery: buildMountedPath(req)
    });
  }));

  app.all('/search', asyncHandler(async (req, res) => {
    await proxyRequest(req, res, {
      baseUrl: libresearchBaseUrl,
      pathAndQuery: buildExactSearchPath(req)
    });
  }));

  app.use('/search/', asyncHandler(async (req, res) => {
    await proxyRequest(req, res, {
      baseUrl: libresearchBaseUrl,
      pathAndQuery: buildMountedPath(req)
    });
  }));

  app.use('/static', asyncHandler(async (req, res) => {
    await proxyRequest(req, res, {
      baseUrl: libresearchBaseUrl,
      pathAndQuery: buildMountedPath(req, true)
    });
  }));

  app.use(asyncHandler(async (req, res) => {
    await proxyRequest(req, res, {
      baseUrl: libresearchBaseUrl,
      pathAndQuery: req.originalUrl || '/'
    });
  }));
}

function sendAdminError(error, res) {
  if (error?.type === 'entity.parse.failed') {
    logEvent('warn', 'admin', 'Invalid admin JSON payload');
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: '请求 JSON 格式无效'
      }
    });
    return;
  }

  if (error instanceof z.ZodError) {
    logEvent('warn', 'admin', 'Invalid admin input', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    res.status(400).json({
      error: {
        code: 'INVALID_ADMIN_INPUT',
        message: '配置参数无效',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    });
    return;
  }

  logEvent('error', 'admin', 'Admin internal error', {
    message: error instanceof Error ? error.message : String(error)
  });
  res.status(500).json({
    error: {
      code: 'ADMIN_INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

function createTimeoutSignal(timeoutMs = ADMIN_TEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function formatAdminTestError(error, fallbackMessage) {
  const aborted = error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
  return {
    message: aborted ? '测试请求超时，请稍后重试或检查目标接口' : fallbackMessage,
    status: error?.status,
    body: error?.body
  };
}

function createSecret() {
  return randomBytes(32).toString('base64url');
}

function getSearch2ApiBaseUrl(endpoint) {
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    if (url.pathname.endsWith('/v1/chat/completions')) {
      url.pathname = url.pathname.slice(0, -'/v1/chat/completions'.length) || '/';
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

async function fetchTextWithTimeout(url, { timeoutMs = 8000, headers } = {}) {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: timeout.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: text.slice(0, 1600)
    };
  } finally {
    timeout.clear();
  }
}

function resolveHfSpaceId(config) {
  return config.hfSpaceId || process.env.HF_SPACE_ID || process.env.SPACE_ID || '';
}

function resolveHfEndpoint(config) {
  return (config.hfEndpoint || process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/u, '');
}

function resolveHfWriteToken(inputToken = '') {
  return inputToken || process.env.HF_WRITE_TOKEN || '';
}

function createHfHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

function createHfSecretsUrl(config) {
  const repoId = resolveHfSpaceId(config);
  if (!repoId) return '';
  return `${resolveHfEndpoint(config)}/api/spaces/${repoId}/secrets`;
}

function normalizeHfSecretRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const source = Array.isArray(payload)
    ? payload
    : Object.entries(payload).map(([key, value]) => ({
        key,
        ...(value && typeof value === 'object' ? value : {})
      }));
  return source
    .map((item) => ({
      key: item?.key || item?.name,
      description: item?.description || '',
      updatedAt: item?.updatedAt || item?.updated_at || item?.updatedAtTimestamp || null
    }))
    .filter((item) => HF_SECRET_KEYS.includes(item.key));
}

async function requestHfJson(config, { method = 'GET', token, body } = {}) {
  const url = createHfSecretsUrl(config);
  if (!url) {
    const error = new Error('HF_SPACE_ID is not configured');
    error.status = 400;
    throw error;
  }
  if (!token) {
    const error = new Error('HF_WRITE_TOKEN is not configured');
    error.status = 400;
    throw error;
  }

  const response = await fetch(url, {
    method,
    headers: createHfHeaders(token),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { text };
  }
  if (!response.ok) {
    const error = new Error(`Hugging Face API responded ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = text.slice(0, 600);
    throw error;
  }
  return payload;
}

async function writeHfSecrets(config, { token, secrets }) {
  const results = [];
  for (const item of secrets) {
    try {
      await requestHfJson(config, {
        method: 'POST',
        token,
        body: {
          key: item.key,
          value: item.value,
          description: item.description || HF_SECRET_OPTIONS.find((option) => option.key === item.key)?.label || ''
        }
      });
      results.push({ key: item.key, ok: true });
    } catch (error) {
      results.push({ key: item.key, ok: false, error: formatHfApiError(error) });
    }
  }
  return results;
}

function formatHfApiError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    status: error?.status,
    body: error?.body
  };
}

function extractSearch2ApiSseText(raw) {
  let content = '';
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (!match) continue;
    const payloadStr = match[1];
    if (!payloadStr || payloadStr === '[DONE]') continue;
    try {
      const obj = JSON.parse(payloadStr);
      const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content;
      if (typeof delta === 'string') {
        content += delta;
      } else if (Array.isArray(delta)) {
        content += delta.join('');
      }
    } catch {
      content += payloadStr + '\n';
    }
  }
  return content.trim();
}

function extractSearch2ApiJsonText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  return choices[0]?.message?.content ?? payload?.content ?? '';
}

function buildErrorResponse({ query, error, params }) {
  const details = [
    `❌ 搜索失败: ${error instanceof Error ? error.message : String(error)}`,
    query ? `查询关键词: ${query}` : '查询关键词: （未提供，已使用随机词）'
  ];

  if (params) {
    details.push(`使用参数: ${JSON.stringify(params)}`);
  }

  if (error?.cause) {
    details.push(`错误原因: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }

  details.push('请稍后再试，或指定更明确的关键词。');

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: details.join('\n')
      }
    ]
  };
}

function isNotConfiguredErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /未配置|not configured|已关闭|disabled|missing key|missing token/iu.test(message);
}

function createSearchTool(server, config) {
  const searchToolShape = {
    ...searchOptionShape,
    query: z
      .string()
      .trim()
      .min(1, '搜索关键词不能为空')
      .describe('搜索关键词，缺省时自动生成随机 UUID')
      .optional()
  };
  const searchToolSchema = z.object(searchToolShape);

  server.registerTool(
    'libresearch_search',
    {
      title: 'LibreSearch 引擎',
      description: '调用 Hugging Face LibreSearch/SearXNG JSON 搜索 API 返回结构化结果',
      inputSchema: searchToolShape
    },
    async (input) => {
      const {
        query: rawQuery,
        page,
        language,
        time_range,
        safesearch,
        categories,
        category_general,
        extraParams
      } = (await searchToolSchema.parseAsync(input));
      const query = resolveQuery(rawQuery);

      const overrides = {
        ...(extraParams ?? {}),
        pageno: page?.toString(),
        language,
        time_range,
        safesearch,
        categories,
        category_general
      };
      await server.sendLoggingMessage({ level: 'info', data: `sousuo_search 开始: ${query}` });

      let payload;
      let params;
      try {
        ({ payload, params } = await executeSearch({
          endpoint: config.searchEndpoint,
          defaultParams: config.defaultParams,
          query,
          overrides
        }));
      } catch (error) {
        await server.sendLoggingMessage({ level: 'error', data: `sousuo_search 失败: ${error instanceof Error ? error.message : String(error)}` });
        return buildErrorResponse({ query, error, params: { ...config.defaultParams, ...overrides } });
      }

      const lines = buildSummaryLines({ query, params, payload });

      await server.sendLoggingMessage({
        level: 'info',
        data: `sousuo_search 成功: ${query}, 返回 ${Array.isArray(payload?.results) ? payload.results.length : 0} 条结果`
      });

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n')
          },
          {
            type: 'text',
            text: `\n\n原始 JSON:\n${JSON.stringify(payload, null, 2)}`
          }
        ]
      };
    }
  );
}

function createBatchSearchTool(server, config) {
  const batchSearchShape = {
    ...searchOptionShape,
    queries: z
      .array(
        z
          .string()
          .trim()
          .min(1, '搜索关键词不能为空')
      )
      .min(1, '至少需要一个搜索词'),
    maxQueries: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe('限制本次批量搜索的查询数量，默认全部执行')
      .optional()
  };
  const batchSearchSchema = z.object(batchSearchShape);

  server.registerTool(
    'libresearch_batch_search',
    {
      title: 'LibreSearch 批量查询',
      description: '对多个搜索词逐一调用聚合搜索 API，返回整理后的多路结果',
      inputSchema: batchSearchShape
    },
    async (input) => {
      const {
        queries,
        maxQueries,
        page,
        language,
        time_range,
        safesearch,
        categories,
        category_general,
        extraParams
      } = await batchSearchSchema.parseAsync(input);

      const limitedQueries = queries.slice(0, maxQueries ?? queries.length);
      const overrides = {
        ...(extraParams ?? {}),
        pageno: page?.toString(),
        language,
        time_range,
        safesearch,
        categories,
        category_general
      };

      const blocks = [];
      const rawOutputs = {};

      for (const [index, rawQuery] of limitedQueries.entries()) {
        const query = resolveQuery(rawQuery);
        await server.sendLoggingMessage({ level: 'info', data: `sousuo_batch_search(${index + 1}) 开始: ${query}` });

        try {
          const { payload, params } = await executeSearch({
            endpoint: config.searchEndpoint,
            defaultParams: config.defaultParams,
            query,
            overrides
          });

          const summaryLines = buildSummaryLines({ query, params, payload });
          const blockLines = [`## 查询 ${index + 1}: ${query}`];
          blockLines.push(...summaryLines.slice(1));
          blocks.push(blockLines.join('\n'));

          rawOutputs[query] = { params, payload };

          await server.sendLoggingMessage({
            level: 'info',
            data: `sousuo_batch_search(${index + 1}) 成功: ${query}`
          });
        } catch (error) {
          const rowParams = { ...config.defaultParams, ...overrides };
          const failureText = buildErrorResponse({ query, error, params: rowParams }).content[0].text;
          blocks.push(`## 查询 ${index + 1}: ${query}\n${failureText}`);
          rawOutputs[query] = { error: error instanceof Error ? error.message : String(error), params: rowParams };

          await server.sendLoggingMessage({
            level: 'error',
            data: `sousuo_batch_search(${index + 1}) 失败: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }

      const aggregatedText = blocks.join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: aggregatedText
          },
          {
            type: 'text',
            text: `\n\n批量原始 JSON:\n${JSON.stringify(rawOutputs, null, 2)}`
          }
        ]
      };
    }
  );
}

function createTopLinksTool(server, config) {
  const topLinksShape = {
    ...searchOptionShape,
    query: z
      .string()
      .trim()
      .min(1, '搜索关键词不能为空')
      .describe('搜索关键词，缺省时自动生成随机 UUID')
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe('返回的结果数量，默认 5，最多 10 条')
      .optional()
  };
  const topLinksSchema = z.object(topLinksShape);

  server.registerTool(
    'libresearch_search_toplinks',
    {
      title: 'LibreSearch 前 N 条链接',
      description: '调用搜索 API，仅返回前 N 条站点标题+链接，可选摘要',
      inputSchema: topLinksShape
    },
    async (input) => {
      const {
        query: rawQuery,
        page,
        language,
        time_range,
        safesearch,
        categories,
        category_general,
        extraParams,
        limit
      } = await topLinksSchema.parseAsync(input);

      const query = resolveQuery(rawQuery);
      const overrides = {
        ...(extraParams ?? {}),
        pageno: page?.toString(),
        language,
        time_range,
        safesearch,
        categories,
        category_general
      };

      await server.sendLoggingMessage({ level: 'info', data: `sousuo_search_toplinks 开始: ${query}` });

      let payload;
      let params;
      try {
        ({ payload, params } = await executeSearch({
          endpoint: config.searchEndpoint,
          defaultParams: config.defaultParams,
          query,
          overrides
        }));
      } catch (error) {
        await server.sendLoggingMessage({
          level: 'error',
          data: `sousuo_search_toplinks 失败: ${error instanceof Error ? error.message : String(error)}`
        });
        return buildErrorResponse({ query, error, params: { ...config.defaultParams, ...overrides } });
      }

      const results = Array.isArray(payload?.results) ? payload.results : [];
      const maxItems = limit ?? 5;
      const selected = results.slice(0, maxItems);

      const lines = [`# 搜索词: ${query}`, `API 参数: ${JSON.stringify(params)}`];

      if (selected.length === 0) {
        lines.push('\n未找到站点结果。');
      } else {
        lines.push(`\n## 前 ${selected.length} 条站点结果`);
        selected.forEach((item, index) => {
          const title = item?.title || `结果 ${index + 1}`;
          const snippetSource = item?.content ?? item?.snippet ?? '';
          const snippet = typeof snippetSource === 'string' ? snippetSource.replace(/\s+/g, ' ').trim() : '';
          const url = item?.url || item?.href || item?.link || '(无链接)';

          lines.push(`- ${title}`);
          lines.push(`  链接: ${url}`);
          if (snippet) {
            lines.push(`  摘要: ${snippet}`);
          }
        });
      }

      await server.sendLoggingMessage({
        level: 'info',
        data: `sousuo_search_toplinks 成功: ${query}, 返回 ${selected.length} 条`
      });

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n')
          }
        ]
      };
    }
  );
}

function createAnswersTool(server, config) {
  const answersShape = {
    ...searchOptionShape,
    query: z
      .string()
      .trim()
      .min(1, '搜索关键词不能为空')
      .describe('搜索关键词，缺省时自动生成随机 UUID')
      .optional()
  };
  const answersSchema = z.object(answersShape);

  server.registerTool(
    'libresearch_search_answers',
    {
      title: 'LibreSearch 直接答案',
      description: '调用搜索 API，仅返回 answers 段（若存在），可选附首条站点链接作为兜底',
      inputSchema: answersShape
    },
    async (input) => {
      const {
        query: rawQuery,
        page,
        language,
        time_range,
        safesearch,
        categories,
        category_general,
        extraParams
      } = await answersSchema.parseAsync(input);

      const query = resolveQuery(rawQuery);
      const overrides = {
        ...(extraParams ?? {}),
        pageno: page?.toString(),
        language,
        time_range,
        safesearch,
        categories,
        category_general
      };

      await server.sendLoggingMessage({ level: 'info', data: `libresearch_search_answers 开始: ${query}` });

      let payload;
      let params;
      try {
        ({ payload, params } = await executeSearch({
          endpoint: config.searchEndpoint,
          defaultParams: config.defaultParams,
          query,
          overrides
        }));
      } catch (error) {
        await server.sendLoggingMessage({
          level: 'error',
          data: `libresearch_search_answers 失败: ${error instanceof Error ? error.message : String(error)}`
        });
        return buildErrorResponse({ query, error, params: { ...config.defaultParams, ...overrides } });
      }

      const answers = Array.isArray(payload?.answers) ? payload.answers : [];
      const results = Array.isArray(payload?.results) ? payload.results : [];

      const lines = [`# 搜索词: ${query}`, `API 参数: ${JSON.stringify(params)}`];

      if (answers.length > 0) {
        lines.push('\n## 直接答案');
        answers.forEach((item, index) => {
          const answerText = typeof item?.answer === 'string' ? item.answer : '';
          const url = item?.url;
          lines.push(`- (${index + 1}) ${answerText}`.trim());
          if (url) {
            lines.push(`  链接: ${url}`);
          }
        });
      } else {
        lines.push('\n无直接答案。');
        if (results.length > 0) {
          const first = results[0];
          const fallbackTitle = first?.title ?? '结果 1';
          const fallbackUrl = first?.url || first?.href || first?.link;
          const snippetSource = first?.content ?? first?.snippet ?? '';
          const snippet = typeof snippetSource === 'string' ? snippetSource.replace(/\s+/g, ' ').trim() : '';

          lines.push('\n## 兜底：首条站点');
          lines.push(`- ${fallbackTitle}`);
          if (fallbackUrl) {
            lines.push(`  链接: ${fallbackUrl}`);
          }
          if (snippet) {
            lines.push(`  摘要: ${snippet}`);
          }
        }
      }

      await server.sendLoggingMessage({
        level: 'info',
        data: `libresearch_search_answers 成功: ${query}, answers ${answers.length}`
      });

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n')
          }
        ]
      };
    }
  );
}

function createFetchHtmlTool(server) {
  const fetchShape = {
    url: z.string().url('请输入合法的 URL'),
    timeoutMs: z
      .number()
      .int()
      .min(500)
      .max(20000)
      .describe('可选超时时间，毫秒，默认 10000')
      .optional(),
    maxBytes: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .describe('可选内容截断长度，字节数，默认 10000')
      .optional(),
    userAgent: z
      .string()
      .describe('可选自定义 User-Agent，默认模拟 Chrome on macOS')
      .optional(),
    referer: z.string().url('可选 Referer，需为合法 URL').optional(),
    cookie: z.string().describe('可选 Cookie 头，按目标站需求传入').optional()
  };
  const fetchSchema = z.object(fetchShape);

  server.registerTool(
    'libresearch_fetch_html',
    {
      title: 'Fetch HTML',
      description: '直接抓取指定 URL 的 HTML/文本内容，带超时与内容截断保护',
      inputSchema: fetchShape
    },
    async (input) => {
      const { url, timeoutMs, maxBytes, userAgent, referer, cookie } = await fetchSchema.parseAsync(input);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 10000);
      const byteLimit = maxBytes ?? 10000;

      let response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'User-Agent':
              userAgent ??
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            ...(referer ? { Referer: referer } : {}),
            ...(cookie ? { Cookie: cookie } : {})
          }
        });
      } catch (error) {
        clearTimeout(timer);
        const causeMsg = error instanceof Error ? error.message : String(error);
        const err = new Error(`抓取失败: ${causeMsg}`);
        return buildErrorResponse({ query: url, error: err });
      }

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = new Error(`Fetch responded with ${response.status} ${response.statusText}`);
        err.body = text;
        return buildErrorResponse({ query: url, error: err });
      }

      let body = await response.text();
      const originalLength = body.length;
      if (body.length > byteLimit) {
        body = body.slice(0, byteLimit) + `\n\n[内容已截断，原始长度 ${originalLength} 字符]`;
      }

      const lines = [
        `# Fetch: ${url}`,
        `状态: ${response.status}`,
        `Content-Type: ${response.headers.get('content-type') ?? '(无)'}`,
        `长度: ${originalLength} 字符，返回上限 ${byteLimit} 字符`
      ];

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n') + '\n\n' + body
          }
        ]
      };
    }
  );
}

function createSearchShTool(server, config) {
  const searchShShape = {
    prompt: z
      .string()
      .trim()
      .min(1, '查询内容不能为空')
      .describe('要提交给 search.sh 代理的用户问题'),
    model: z.string().describe('可选模型，默认为 search-sh-ai').optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(60000)
      .describe('超时时间，毫秒，默认 30000')
      .optional()
  };
  const searchShSchema = z.object(searchShShape);

  server.registerTool(
    'libresearch_search_sh',
    {
      title: 'Search.sh 代理 (via Search-2api)',
      description: '将提示发送到 Search-2api /v1/chat/completions，返回 OpenAI 风格答案',
      inputSchema: searchShShape
    },
    async (input) => {
      const { prompt, model, timeoutMs } = await searchShSchema.parseAsync(input);

      const endpoint = config.searchShChatEndpoint;
      if (!endpoint) {
        return buildErrorResponse({
          query: prompt,
          error: new Error('未配置 SEARCH_SH_CHAT_ENDPOINT，无法调用 search.sh 代理')
        });
      }

      const body = {
        model: model ?? 'search-sh-ai',
        messages: [{ role: 'user', content: prompt }],
        stream: true
      };

      const fetchOnce = async (useStream) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? 30000);

        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: config.searchShApiKey ? `Bearer ${config.searchShApiKey}` : undefined
            },
            body: JSON.stringify({ ...body, stream: useStream })
          });
          clearTimeout(timer);

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            return {
              ok: false,
              error: new Error(`search.sh 代理响应 ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`)
            };
          }

          // 流式解析：提取 data: 行的增量内容
          if (useStream) {
            const reader = response.body?.getReader();
            if (!reader) {
              return { ok: false, error: new Error('流式响应缺少可读流') };
            }
            let raw = '';
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              raw += decoder.decode(value, { stream: true });
            }
            raw += decoder.decode();

            const text = extractSearch2ApiSseText(raw);
            if (!text) {
              return { ok: false, error: new Error('流式响应未返回有效内容') };
            }
            return { ok: true, text };
          }

          // 非流式：JSON choices
          const payload = await response.json().catch(() => null);
          const first = extractSearch2ApiJsonText(payload) || JSON.stringify(payload);
          return { ok: true, text: first || '收到空响应' };
        } catch (error) {
          clearTimeout(timer);
          return {
            ok: false,
            error: new Error(`请求 search.sh 代理失败: ${error instanceof Error ? error.message : String(error)}`)
          };
        }
      };

      // 优先流式，失败或空内容时自动回退非流式
      let result = await fetchOnce(true);
      if (!result.ok) {
        await server.sendLoggingMessage({
          level: 'warn',
          data: `libresearch_search_sh 流式失败，回退非流: ${result.error?.message ?? result.error}`
        });
        result = await fetchOnce(false);
      }

      if (!result.ok) {
        return buildErrorResponse({ query: prompt, error: result.error });
      }

      return {
        content: [
          {
            type: 'text',
            text: `# search.sh 代理结果\n模型: ${body.model}\n\n${result.text}`
          }
        ]
      };
    }
  );
}

function createDualSearchTool(server, config) {
  const dualShape = {
    ...searchOptionShape,
    query: z
      .string()
      .trim()
      .min(1, '搜索关键词不能为空')
      .describe('搜索关键词，缺省时自动生成随机 UUID')
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe('每个源的结果数量，默认 3，最多 10 条')
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(2000)
      .max(20000)
      .describe('每路请求超时毫秒数，默认 8000')
      .optional()
  };
  const dualSchema = z.object(dualShape);

  server.registerTool(
    'libresearch_search_dual',
    {
      title: '双源搜索 (LibreSearch + search.sh)',
      description: '并行调用 Hugging Face LibreSearch 和 search.sh(通过 Search-2api)，标注来源并返回前 N 条结果',
      inputSchema: dualShape
    },
    async (input) => {
      const { query: rawQuery, limit, timeoutMs, ...rest } = await dualSchema.parseAsync(input);
      const query = resolveQuery(rawQuery);
      const maxItems = limit ?? 3;
      const perTimeout = timeoutMs ?? 8000;

      const overrides = {
        ...(rest.extraParams ?? {}),
        pageno: rest.page?.toString(),
        language: rest.language,
        time_range: rest.time_range,
        safesearch: rest.safesearch,
        categories: rest.categories,
        category_general: rest.category_general
      };

      const fetchWithTimeout = async (fn) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perTimeout);
        try {
          return await fn(controller);
        } finally {
          clearTimeout(timer);
        }
      };

      const tasks = {
        LibreSearch: fetchWithTimeout(async (controller) => {
          const { payload, params } = await executeSearch({
            endpoint: config.searchEndpoint,
            defaultParams: config.defaultParams,
            query,
            overrides,
            signal: controller.signal
          });
          return { payload, params };
        }),
        'search.sh': fetchWithTimeout(async (controller) => {
          if (!config.searchShChatEndpoint) {
            throw new Error('未配置 search.sh 代理 endpoint');
          }
          const body = {
            model: 'search-sh-ai',
            messages: [{ role: 'user', content: query }],
            stream: false
          };
          const res = await fetch(config.searchShChatEndpoint, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: config.searchShApiKey ? `Bearer ${config.searchShApiKey}` : undefined
            },
            body: JSON.stringify(body)
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`search.sh 响应 ${res.status} ${res.statusText}${txt ? `: ${txt}` : ''}`);
          }
          const payload = await res.json().catch(() => ({}));
          return { payload, params: { model: body.model } };
        })
      };

      const results = {};
      for (const [source, promise] of Object.entries(tasks)) {
        try {
          results[source] = { ok: true, ...(await promise) };
        } catch (error) {
          results[source] = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      const lines = [`# 双源搜索: ${query}`];

      const renderLibreSearch = () => {
        const row = results.LibreSearch;
        if (!row?.ok) {
          lines.push('\n## LibreSearch');
          lines.push(`- 失败: ${row?.error ?? '未知错误'}`);
          return;
        }
        const payload = row.payload;
        const params = row.params;
        const items = Array.isArray(payload?.results) ? payload.results.slice(0, maxItems) : [];
        lines.push('\n## LibreSearch');
        lines.push(`API 参数: ${JSON.stringify(params)}`);
        if (items.length === 0) {
          lines.push('- 未找到结果');
        } else {
          items.forEach((item, index) => {
            const title = item?.title || `结果 ${index + 1}`;
            const url = item?.url || item?.href || item?.link || '(无链接)';
            const snippetSource = item?.content ?? item?.snippet ?? '';
            const snippet = typeof snippetSource === 'string' ? snippetSource.replace(/\s+/g, ' ').trim() : '';
            lines.push(`- ${title}`);
            lines.push(`  链接: ${url}`);
            if (snippet) {
              lines.push(`  摘要: ${snippet}`);
            }
          });
        }
        const answers = Array.isArray(payload?.answers) ? payload.answers : [];
        if (answers.length > 0) {
          lines.push('  直答:');
          answers.forEach((a, i) => {
            const text = typeof a?.answer === 'string' ? a.answer : '';
            lines.push(`  - (${i + 1}) ${text}`);
            if (a?.url) lines.push(`    链接: ${a.url}`);
          });
        }
      };

      const renderSearchSh = () => {
        const row = results['search.sh'];
        lines.push('\n## search.sh (via Search-2api)');
        if (!row?.ok) {
          lines.push(`- 失败: ${row?.error ?? '未知错误'}`);
          return;
        }
        const payload = row.payload;
        const choices = Array.isArray(payload?.choices) ? payload.choices : [];
        const content = choices[0]?.message?.content ?? payload?.content;
        if (typeof content === 'string' && content.trim()) {
          lines.push(`- 回答: ${content.trim()}`);
        } else {
          lines.push('- 无内容或解析失败');
          lines.push(`  原始: ${JSON.stringify(payload)}`);
        }
      };

      renderLibreSearch();
      renderSearchSh();

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n')
          }
        ]
      };
    }
  );
}

function getLibreResultItems(payload, limit = 5) {
  return Array.isArray(payload?.results)
    ? payload.results.slice(0, limit).map((item, index) => ({
        title: item?.title || `结果 ${index + 1}`,
        url: item?.url || item?.href || item?.link || '',
        description: typeof (item?.content ?? item?.snippet) === 'string'
          ? (item.content ?? item.snippet).replace(/\s+/g, ' ').trim()
          : ''
      }))
    : [];
}

function formatLibreEvidence({ query, payload, params, limit = 5 }) {
  const lines = [`## LibreSearch`, `查询: ${query}`, `参数: ${JSON.stringify(params)}`];
  const answers = Array.isArray(payload?.answers) ? payload.answers : [];
  if (answers.length > 0) {
    lines.push('直接答案:');
    answers.slice(0, limit).forEach((item, index) => {
      const text = typeof item?.answer === 'string' ? item.answer : '';
      lines.push(`- (${index + 1}) ${text}`);
      if (item?.url) lines.push(`  链接: ${item.url}`);
    });
  }
  const items = getLibreResultItems(payload, limit);
  if (items.length > 0) {
    lines.push('站点结果:');
    items.forEach((item, index) => {
      lines.push(`- (${index + 1}) ${item.title}`);
      if (item.url) lines.push(`  链接: ${item.url}`);
      if (item.description) lines.push(`  摘要: ${item.description}`);
    });
  }
  if (answers.length === 0 && items.length === 0) {
    lines.push('未找到可用结果。');
  }
  return lines.join('\n');
}

async function callSearch2Api(config, { prompt, model = 'search-sh-ai', timeoutMs = 45_000, stream = true }) {
  if (!config.searchShChatEndpoint) {
    throw new Error('未配置 SEARCH_SH_CHAT_ENDPOINT，无法调用 Search-2api');
  }

  const fetchOnce = async (useStream) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.searchShChatEndpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.searchShApiKey ? { Authorization: `Bearer ${config.searchShApiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: useStream
        })
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Search-2api 响应 ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 1200)}` : ''}`);
      }

      if (useStream) {
        const content = extractSearch2ApiSseText(text);
        if (!content) throw new Error('Search-2api 流式响应未返回有效内容');
        return { model, mode: 'stream', content, raw: text.slice(0, 4000) };
      }

      const payload = text ? JSON.parse(text) : {};
      const content = extractSearch2ApiJsonText(payload);
      if (!content) throw new Error('Search-2api 非流式响应未返回有效内容');
      return { model, mode: 'non-stream', content, payload };
    } finally {
      clearTimeout(timer);
    }
  };

  if (!stream) return fetchOnce(false);
  try {
    return await fetchOnce(true);
  } catch (streamError) {
    const fallback = await fetchOnce(false);
    return { ...fallback, fallback: streamError instanceof Error ? streamError.message : String(streamError) };
  }
}

function createPrecisionTools(server, config, sourceCache, { includeSearch = true, includeFusion = true, monitoring = null } = {}) {
  if (includeSearch) {
    const libreSearchShape = {
      ...searchOptionShape,
      query: z.string().trim().min(1, '搜索关键词不能为空').describe('搜索关键词，缺省时自动生成随机 UUID').optional(),
      limit: z.number().int().min(1).max(10).describe('返回结果数量，默认 5').optional()
    };
    const libreSearchSchema = z.object(libreSearchShape);
    server.registerTool(
      'libre_search',
      {
        title: 'LibreSearch 精简搜索',
        description: '推荐工具：调用 LibreSearch/SearXNG JSON API，返回结构化搜索摘要和前 N 条结果',
        inputSchema: libreSearchShape
      },
      async (input) => {
        const { query: rawQuery, limit, page, language, time_range, safesearch, categories, category_general, extraParams } =
          await libreSearchSchema.parseAsync(input);
        const query = resolveQuery(rawQuery);
        const overrides = {
          ...(extraParams ?? {}),
          pageno: page?.toString(),
          language,
          time_range,
          safesearch,
          categories,
          category_general
        };
        try {
          const { payload, params } = await executeSearch({
            endpoint: config.searchEndpoint,
            defaultParams: config.defaultParams,
            query,
            overrides
          });
          return {
            content: [{ type: 'text', text: formatLibreEvidence({ query, payload, params, limit: limit ?? 5 }) }]
          };
        } catch (error) {
          return buildErrorResponse({ query, error, params: { ...config.defaultParams, ...overrides } });
        }
      }
    );

    const search2ApiShape = {
      prompt: z.string().trim().min(1, '查询内容不能为空').describe('提交给 Search-2api/search.sh 的问题'),
      model: z.string().trim().describe('模型，默认 search-sh-ai').optional(),
      timeoutMs: z.number().int().min(5000).max(120000).describe('超时时间，毫秒，默认 45000').optional()
    };
    const search2ApiSchema = z.object(search2ApiShape);
    server.registerTool(
      'search2api_chat',
      {
        title: 'Search-2api 答案搜索',
        description: '推荐工具：调用内置或外置 Search-2api，将 search.sh 答案转为 OpenAI-compatible 内容',
        inputSchema: search2ApiShape
      },
      async (input) => {
        const parsed = await search2ApiSchema.parseAsync(input);
        try {
          const result = await callSearch2Api(config, {
            prompt: parsed.prompt,
            model: parsed.model || 'search-sh-ai',
            timeoutMs: parsed.timeoutMs ?? 45_000
          });
          return {
            content: [
              {
                type: 'text',
                text: `# Search-2api\n模型: ${result.model}\n模式: ${result.mode}${result.fallback ? `\n回退原因: ${result.fallback}` : ''}\n\n${result.content}`
              }
            ]
          };
        } catch (error) {
          return buildErrorResponse({ query: parsed.prompt, error });
        }
      }
    );
  }

  if (includeFusion) {
    const webSearchShape = {
      query: z.string().trim().min(1, '搜索关键词不能为空').describe('自然语言搜索问题'),
      platform: z.string().describe('聚焦平台，例如 GitHub / Reddit / 官方文档').optional(),
      model: z.string().describe('可选 Grok 模型 ID，不填使用默认模型').optional(),
      extraSources: z.number().int().min(0).max(10).describe('额外从 Tavily/Firecrawl 补充的信源数量').optional(),
      timeoutMs: z.number().int().min(5000).max(120000).describe('请求超时毫秒数').optional()
    };
    const webSearchSchema = z.object(webSearchShape);
    server.registerTool(
      'web_search',
      {
        title: 'Web Search (Grok)',
        description: '推荐工具：使用 Grok/OpenAI-compatible 执行 AI 搜索/回答，按 Grok System Prompt 输出',
        inputSchema: webSearchShape
      },
      async (input) => {
        const parsed = await webSearchSchema.parseAsync(input);
        const sessionId = newSessionId();
        try {
          const result = await executeGrokWebSearch({
            config,
            query: parsed.query,
            platform: parsed.platform,
            model: parsed.model,
            extraSources: parsed.extraSources ?? 0,
            timeoutMs: parsed.timeoutMs
          });
          monitoring?.record('grok', {
            ok: true,
            message: 'web_search 调用成功',
            source: 'mcp-tool'
          });
          sourceCache.set(sessionId, result.sources);
          return {
            content: [
              {
                type: 'text',
                text: [
                  `# Web Search: ${parsed.query}`,
                  `模型: ${result.model}`,
                  `session_id: ${sessionId}`,
                  `信源数量: ${result.sourcesCount}`,
                  '',
                  result.content || '未返回内容'
                ].join('\n')
              }
            ]
          };
        } catch (error) {
          monitoring?.record('grok', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
          sourceCache.set(sessionId, []);
          return buildErrorResponse({ query: parsed.query, error });
        }
      }
    );

    const fetchShape = {
      url: z.string().trim().url().describe('要抓取正文的 HTTP/HTTPS URL'),
      timeoutMs: z.number().int().min(5000).max(120000).describe('请求超时毫秒数').optional()
    };
    const fetchSchema = z.object(fetchShape);
    server.registerTool(
      'web_fetch',
      {
        title: 'Web Fetch (Tavily -> Firecrawl)',
        description: '推荐工具：通过 Tavily Extract 抓取正文，失败或空内容时自动降级到 Firecrawl Scrape',
        inputSchema: fetchShape
      },
      async (input) => {
        const { url, timeoutMs } = await fetchSchema.parseAsync(input);
        try {
          const result = await executeTavilyFetch({ config, url, timeoutMs });
          monitoring?.record(result.provider === 'firecrawl' ? 'firecrawl' : 'tavily', {
            ok: true,
            message: `web_fetch 调用成功：${result.provider}`,
            source: 'mcp-tool'
          });
          return { content: [{ type: 'text', text: `# Web Fetch\nProvider: ${result.provider}\nURL: ${url}\n\n${result.content}` }] };
        } catch (error) {
          monitoring?.record('tavily', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
          return buildErrorResponse({ query: url, error });
        }
      }
    );

    const mapShape = {
      url: z.string().trim().url().describe('起始 URL'),
      instructions: z.string().trim().describe('自然语言过滤指令').optional(),
      maxDepth: z.number().int().min(1).max(5).describe('最大深度').optional(),
      maxBreadth: z.number().int().min(1).max(500).describe('每页最大跟踪链接数').optional(),
      limit: z.number().int().min(1).max(500).describe('总链接上限').optional(),
      timeout: z.number().int().min(10).max(150).describe('超时秒数').optional()
    };
    const mapSchema = z.object(mapShape);
    server.registerTool(
      'web_map',
      {
        title: 'Web Map (Tavily)',
        description: '推荐工具：通过 Tavily Map 探测站点结构和链接',
        inputSchema: mapShape
      },
      async (input) => {
        const parsed = await mapSchema.parseAsync(input);
        try {
          const result = await executeTavilyMap({ config, ...parsed });
          monitoring?.record('tavily', {
            ok: true,
            message: 'web_map 调用成功',
            source: 'mcp-tool'
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          monitoring?.record('tavily', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
          return buildErrorResponse({ query: parsed.url, error });
        }
      }
    );

    const researchShape = {
      query: z.string().trim().min(1, '研究问题不能为空').describe('需要多源检索并总结的问题'),
      model: z.string().trim().describe('可选 Grok 模型 ID').optional(),
      limit: z.number().int().min(1).max(10).describe('每个源最多采用的结果数量，默认 5').optional(),
      extraSources: z.number().int().min(0).max(10).describe('额外 Tavily/Firecrawl 信源数量').optional(),
      timeoutMs: z.number().int().min(5000).max(120000).describe('Grok 请求超时毫秒数').optional()
    };
    const researchSchema = z.object(researchShape);
    server.registerTool(
      'fusion_research',
      {
        title: 'Fusion Research',
        description: '推荐工具：LibreSearch + Search-2api/search.sh 取证，再交给 Grok 按 System Prompt 总结',
        inputSchema: researchShape
      },
      async (input) => {
        const parsed = await researchSchema.parseAsync(input);
        const limit = parsed.limit ?? 5;
        const evidence = [];
        const sourceList = [];

        try {
          const { payload, params } = await executeSearch({
            endpoint: config.searchEndpoint,
            defaultParams: config.defaultParams,
            query: parsed.query,
            overrides: {}
          });
          evidence.push(formatLibreEvidence({ query: parsed.query, payload, params, limit }));
          sourceList.push(...getLibreResultItems(payload, limit).map((item) => ({ ...item, provider: 'libresearch' })));
        } catch (error) {
          evidence.push(`## LibreSearch\n失败: ${error instanceof Error ? error.message : String(error)}`);
          monitoring?.record('libresearch', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
        }

        try {
          const search2api = await callSearch2Api(config, {
            prompt: parsed.query,
            timeoutMs: Math.min(parsed.timeoutMs ?? 60_000, 90_000)
          });
          evidence.push(`## Search-2api/search.sh\n${search2api.content}`);
        } catch (error) {
          evidence.push(`## Search-2api/search.sh\n失败: ${error instanceof Error ? error.message : String(error)}`);
          monitoring?.record('search2api', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
        }

        const prompt = [
          `User question: ${parsed.query}`,
          '',
          'Use the following FusionSearch evidence. If evidence is weak, say so explicitly.',
          evidence.join('\n\n---\n\n')
        ].join('\n');

        const sessionId = newSessionId();
        try {
          const result = await executeGrokWebSearch({
            config,
            query: prompt,
            model: parsed.model,
            extraSources: parsed.extraSources ?? 0,
            timeoutMs: parsed.timeoutMs
          });
          monitoring?.record('grok', {
            ok: true,
            message: 'fusion_research Grok 汇总成功',
            source: 'mcp-tool'
          });
          const sources = mergeSources(sourceList, result.sources);
          sourceCache.set(sessionId, sources);
          return {
            content: [
              {
                type: 'text',
                text: [
                  `# Fusion Research: ${parsed.query}`,
                  `模型: ${result.model}`,
                  `session_id: ${sessionId}`,
                  `信源数量: ${sources.length}`,
                  '',
                  result.content || '未返回内容',
                  '',
                  '## 证据摘要',
                  evidence.join('\n\n---\n\n')
                ].join('\n')
              }
            ]
          };
        } catch (error) {
          monitoring?.record('grok', {
            status: isNotConfiguredErrorMessage(error) ? 'paused' : 'down',
            message: error instanceof Error ? error.message : String(error),
            source: 'mcp-tool'
          });
          sourceCache.set(sessionId, sourceList);
          return {
            content: [
              {
                type: 'text',
                text: [
                  `# Fusion Research: ${parsed.query}`,
                  `Grok 总结失败: ${error instanceof Error ? error.message : String(error)}`,
                  `session_id: ${sessionId}`,
                  '',
                  '## 已取得的证据',
                  evidence.join('\n\n---\n\n')
                ].join('\n')
              }
            ]
          };
        }
      }
    );

    const smartFetchShape = {
      url: z.string().trim().min(1).describe('网页 URL，可省略 https:// 但需要像 example.com/path 这样的域名'),
      question: z.string().trim().describe('可选：针对网页内容要回答的问题').optional(),
      summarize: z.boolean().describe('是否让 Grok 基于抓取内容总结，默认 false').optional(),
      timeoutMs: z.number().int().min(5000).max(120000).describe('每个 provider 请求超时毫秒数').optional()
    };
    const smartFetchSchema = z.object(smartFetchShape);
    server.registerTool(
      'smart_fetch',
      {
        title: 'Smart Fetch',
        description: '智能网页抓取：Tavily Extract -> Firecrawl Scrape -> HTML fetch，必要时再让 Grok 总结',
        inputSchema: smartFetchShape
      },
      async (input) => {
        const parsed = await smartFetchSchema.parseAsync(input);
        const result = await executeSmartFetch({
          config,
          url: parsed.url,
          question: parsed.question || '',
          summarize: Boolean(parsed.summarize),
          timeoutMs: parsed.timeoutMs,
          monitor: monitoring
        });
        return {
          content: [
            {
              type: 'text',
              text: formatSmartFetchResult(result)
            },
            {
              type: 'text',
              text: `\n\n原始状态 JSON:\n${JSON.stringify({
                ok: result.ok,
                mode: result.mode,
                provider: result.provider,
                providers: result.providers,
                attempts: result.attempts
              }, null, 2)}`
            }
          ]
        };
      }
    );

    const smartResearchShape = {
      input: z.string().trim().min(1).describe('关键词、自然语言问题或 URL'),
      question: z.string().trim().describe('当 input 是 URL 时，可填写针对该网页的问题').optional(),
      limit: z.number().int().min(1).max(10).describe('每个搜索源最多采用的结果数量，默认 5').optional(),
      deep: z.boolean().describe('是否抓取前 2 个候选网页正文，默认 false 以节省额度').optional(),
      summarize: z.boolean().describe('是否交给 Grok 汇总，默认 true；Grok 失败时仍返回证据').optional(),
      timeoutMs: z.number().int().min(5000).max(120000).describe('请求超时毫秒数').optional()
    };
    const smartResearchSchema = z.object(smartResearchShape);
    server.registerTool(
      'smart_research',
      {
        title: 'Smart Research',
        description: '智能研究入口：URL 自动抓取，关键词自动并用 LibreSearch、Search-2api、Tavily，再由 Grok 汇总',
        inputSchema: smartResearchShape
      },
      async (input) => {
        const parsed = await smartResearchSchema.parseAsync(input);
        const result = await executeSmartResearch({
          config,
          input: parsed.input,
          question: parsed.question || '',
          limit: parsed.limit ?? 5,
          deep: Boolean(parsed.deep),
          summarize: parsed.summarize !== false,
          timeoutMs: parsed.timeoutMs,
          monitor: monitoring
        });
        const sessionId = newSessionId();
        sourceCache.set(sessionId, Array.isArray(result.sources) ? result.sources : []);
        return {
          content: [
            {
              type: 'text',
              text: [
                `session_id: ${sessionId}`,
                formatSmartResearchResult(result)
              ].join('\n')
            },
            {
              type: 'text',
              text: `\n\n原始状态 JSON:\n${JSON.stringify({
                ok: result.ok,
                mode: result.mode,
                providers: result.providers,
                attempts: result.attempts,
                fetched: result.fetched || []
              }, null, 2)}`
            }
          ]
        };
      }
    );

    const statusShape = {
      includeKeys: z.boolean().describe('是否包含脱敏 Key 状态，默认 true').optional()
    };
    const statusSchema = z.object(statusShape);
    server.registerTool(
      'fusion_status',
      {
        title: 'FusionSearch Status',
        description: '返回 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 的最近健康状态和脱敏 Key 状态',
        inputSchema: statusShape
      },
      async (input) => {
        const parsed = await statusSchema.parseAsync(input ?? {});
        const snapshot = buildMonitoringSnapshot(config, monitoring);
        if (parsed.includeKeys === false) {
          delete snapshot.keyStatus;
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot, null, 2)
            }
          ]
        };
      }
    );
  }
}

function createFusionSearchTools(server, config, sourceCache, persistConfig) {
  const grokSearchShape = {
    query: z.string().trim().min(1, '搜索关键词不能为空').describe('自然语言搜索问题'),
    platform: z.string().describe('聚焦平台，例如 GitHub / Reddit / 官方文档').optional(),
    model: z.string().describe('可选 Grok 模型 ID，不填使用默认模型').optional(),
    extraSources: z.number().int().min(0).max(10).describe('额外从 Tavily/Firecrawl 补充的信源数量').optional(),
    timeoutMs: z.number().int().min(5000).max(120000).describe('请求超时毫秒数').optional()
  };
  const grokSearchSchema = z.object(grokSearchShape);

  server.registerTool(
    'fusionsearch_grok_search',
    {
      title: 'FusionSearch Grok 搜索',
      description: '通过 Grok/OpenAI-compatible 接口执行 AI 搜索，并缓存信源供 fusionsearch_sources 读取',
      inputSchema: grokSearchShape
    },
    async (input) => {
      const parsed = await grokSearchSchema.parseAsync(input);
      const sessionId = newSessionId();
      try {
        const result = await executeGrokWebSearch({
          config,
          query: parsed.query,
          platform: parsed.platform,
          model: parsed.model,
          extraSources: parsed.extraSources ?? 0,
          timeoutMs: parsed.timeoutMs
        });
        sourceCache.set(sessionId, result.sources);

        const lines = [
          `# FusionSearch: ${parsed.query}`,
          `模型: ${result.model}`,
          `session_id: ${sessionId}`,
          `信源数量: ${result.sourcesCount}`,
          '',
          result.content || '未返回内容'
        ];
        if (result.sources.length > 0) {
          lines.push('', '## 信源预览');
          result.sources.slice(0, 8).forEach((source, index) => {
            lines.push(`- (${index + 1}) ${source.title || source.url}`);
            lines.push(`  链接: ${source.url}`);
            if (source.description) lines.push(`  摘要: ${source.description}`);
            if (source.provider) lines.push(`  来源: ${source.provider}`);
          });
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        sourceCache.set(sessionId, []);
        return buildErrorResponse({ query: parsed.query, error });
      }
    }
  );

  const sourcesShape = {
    sessionId: z.string().trim().min(1).describe('fusionsearch_grok_search 返回的 session_id')
  };
  const sourcesSchema = z.object(sourcesShape);
  server.registerTool(
    'fusionsearch_sources',
    {
      title: 'FusionSearch 信源读取',
      description: '根据 session_id 获取 Grok/Tavily/Firecrawl 缓存信源',
      inputSchema: sourcesShape
    },
    async (input) => {
      const { sessionId } = await sourcesSchema.parseAsync(input);
      const sources = sourceCache.get(sessionId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                session_id: sessionId,
                sources_count: sources?.length ?? 0,
                sources: sources ?? [],
                error: sources ? undefined : 'session_id_not_found_or_expired'
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  const fetchShape = {
    url: z.string().trim().url().describe('要抓取正文的 HTTP/HTTPS URL'),
    timeoutMs: z.number().int().min(5000).max(120000).describe('请求超时毫秒数').optional()
  };
  const fetchSchema = z.object(fetchShape);
  server.registerTool(
    'fusionsearch_fetch',
    {
      title: 'FusionSearch 网页抓取',
      description: '通过 Tavily Extract 抓取 Markdown 正文，失败时自动降级到 Firecrawl Scrape',
      inputSchema: fetchShape
    },
    async (input) => {
      const { url, timeoutMs } = await fetchSchema.parseAsync(input);
      try {
        const result = await executeTavilyFetch({ config, url, timeoutMs });
        return {
          content: [
            {
              type: 'text',
              text: `# 网页抓取\nProvider: ${result.provider}\nURL: ${url}\n\n${result.content}`
            }
          ]
        };
      } catch (error) {
        return buildErrorResponse({ query: url, error });
      }
    }
  );

  const mapShape = {
    url: z.string().trim().url().describe('起始 URL'),
    instructions: z.string().trim().describe('自然语言过滤指令').optional(),
    maxDepth: z.number().int().min(1).max(5).describe('最大深度').optional(),
    maxBreadth: z.number().int().min(1).max(500).describe('每页最大跟踪链接数').optional(),
    limit: z.number().int().min(1).max(500).describe('总链接上限').optional(),
    timeout: z.number().int().min(10).max(150).describe('超时秒数').optional()
  };
  const mapSchema = z.object(mapShape);
  server.registerTool(
    'fusionsearch_map',
    {
      title: 'FusionSearch 站点地图',
      description: '通过 Tavily Map 探测站点结构和链接',
      inputSchema: mapShape
    },
    async (input) => {
      const parsed = await mapSchema.parseAsync(input);
      try {
        const result = await executeTavilyMap({ config, ...parsed });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return buildErrorResponse({ query: parsed.url, error });
      }
    }
  );

  const configShape = {
    testConnection: z.boolean().describe('是否测试 Grok /models 连接').optional()
  };
  const configSchema = z.object(configShape);
  server.registerTool(
    'fusionsearch_config',
    {
      title: 'FusionSearch 配置诊断',
      description: '返回 Grok/Tavily/Firecrawl 配置状态，API Key 自动脱敏',
      inputSchema: configShape
    },
    async (input) => {
      const { testConnection } = await configSchema.parseAsync(input ?? {});
      const info = await buildFusionConfigInfo({ config, testConnection: Boolean(testConnection) });
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
  );

  const switchModelShape = {
    model: z.string().trim().min(1).describe('新的默认 Grok 模型 ID')
  };
  const switchModelSchema = z.object(switchModelShape);
  server.registerTool(
    'fusionsearch_switch_model',
    {
      title: 'FusionSearch 模型切换',
      description: '切换默认 Grok 模型并持久化到 runtime 配置',
      inputSchema: switchModelShape
    },
    async (input) => {
      const { model } = await switchModelSchema.parseAsync(input);
      const previous = config.grokModel;
      config.grokModel = model;
      await persistConfig();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                previous_model: previous,
                current_model: config.grokModel,
                message: `模型已从 ${previous} 切换到 ${config.grokModel}`
              },
              null,
              2
            )
          }
        ]
      };
    }
  );
}

function registerResources(server, config) {
  server.registerResource(
    'search-endpoint',
    'search://config/endpoint',
    {
      title: 'Search Endpoint 配置',
      description: '当前使用的搜索 API 终端',
      mimeType: 'application/json'
    },
    async () => ({
      contents: [
        {
          uri: 'search://config/endpoint',
          text: JSON.stringify(
            {
              endpoint: config.searchEndpoint,
              defaultParams: config.defaultParams
            },
            null,
            2
          )
        }
      ]
    })
  );
}

export function createApp(userConfig = {}) {
  configureLogger({ logDir: userConfig.logDir });
  const {
    defaultParams: userDefaultParams,
    runtimeConfigPath,
    saveRuntimeConfig,
    ...restUserConfig
  } = userConfig;

  const sanitizedConfig = Object.fromEntries(
    Object.entries(restUserConfig).filter(([, value]) => value !== undefined)
  );

  const config = {
    ...DEFAULT_CONFIG,
    ...sanitizedConfig,
    defaultParams: {
      ...DEFAULT_CONFIG.defaultParams,
      ...(userDefaultParams ?? {})
    }
  };
  const sourceCache = new SourceCache();
  const monitoring = createMonitoringState();

  const publicConfig = () => ({
    serverName: config.serverName,
    serverVersion: config.serverVersion,
    searchEndpoint: config.searchEndpoint,
    searchShChatEndpoint: config.searchShChatEndpoint,
    searchShProjectUrl: config.searchShProjectUrl,
    searchShBaseUrl: getSearch2ApiBaseUrl(config.searchShChatEndpoint),
    hasSearchShApiKey: Boolean(config.searchShApiKey),
    fusion: getFusionPublicConfig(config),
    keyStatus: buildKeyStatus(config),
    defaultParams: config.defaultParams,
    runtimeConfigPath: runtimeConfigPath ?? null,
    envOverrides: {
      searchEndpoint: Boolean(process.env.SEARCH_ENDPOINT),
      searchShChatEndpoint: Boolean(process.env.SEARCH_SH_CHAT_ENDPOINT),
      searchShApiKey: Boolean(process.env.SEARCH_SH_API_KEY),
      adminToken: Boolean(process.env.ADMIN_TOKEN),
      sessionSecret: Boolean(process.env.SESSION_SECRET),
      mcpAuthToken: Boolean(process.env.MCP_AUTH_TOKEN),
      grokApiUrl: Boolean(process.env.GROK_API_URL),
      grokApiKey: Boolean(process.env.GROK_API_KEY),
      grokModel: Boolean(process.env.GROK_MODEL),
      grokSystemPrompt: Boolean(process.env.GROK_SYSTEM_PROMPT),
      tavilyProvider: Boolean(process.env.TAVILY_PROVIDER || process.env.TAVILY_MODE),
      tavilyApiKey: Boolean(process.env.TAVILY_API_KEY),
      tavilyMcpUrl: Boolean(process.env.TAVILY_MCP_URL),
      tavilyMcpToken: Boolean(process.env.TAVILY_MCP_TOKEN || process.env.TAVILY_HIKARI_TOKEN),
      firecrawlApiKey: Boolean(process.env.FIRECRAWL_API_KEY),
      hfWriteToken: Boolean(process.env.HF_WRITE_TOKEN),
      hfSpaceId: Boolean(resolveHfSpaceId(config))
    },
    auth: {
      adminAuthEnabled: auth.adminAuthEnabled,
      mcpAuthEnabled: auth.mcpAuthEnabled
    },
    mcpEndpoints: {
      full: '/mcp',
      libresearch: '/libresearch/mcp',
      fusion: '/fusion/mcp'
    },
    hfSecrets: {
      endpoint: resolveHfEndpoint(config),
      spaceId: resolveHfSpaceId(config),
      canWrite: Boolean(process.env.HF_WRITE_TOKEN && resolveHfSpaceId(config)),
      options: HF_SECRET_OPTIONS
    }
  });

  const persistConfig = async () => {
    if (typeof saveRuntimeConfig !== 'function') return;
    await saveRuntimeConfig({
      searchEndpoint: config.searchEndpoint,
      searchShChatEndpoint: config.searchShChatEndpoint,
      searchShApiKey: config.searchShApiKey,
      adminAuthEnabled: config.adminAuthEnabled,
      adminToken: config.adminToken,
      sessionSecret: config.sessionSecret,
      mcpAuthToken: config.mcpAuthToken,
      grokApiUrl: config.grokApiUrl,
      grokApiKey: config.grokApiKey,
      grokModel: config.grokModel,
      grokSystemPrompt: config.grokSystemPrompt,
      tavilyEnabled: config.tavilyEnabled,
      tavilyProvider: config.tavilyProvider,
      tavilyApiUrl: config.tavilyApiUrl,
      tavilyApiKey: config.tavilyApiKey,
      tavilyMcpUrl: config.tavilyMcpUrl,
      tavilyMcpToken: config.tavilyMcpToken,
      tavilyMcpSearchTool: config.tavilyMcpSearchTool,
      tavilyMcpExtractTool: config.tavilyMcpExtractTool,
      tavilyMcpMapTool: config.tavilyMcpMapTool,
      firecrawlApiUrl: config.firecrawlApiUrl,
      firecrawlApiKey: config.firecrawlApiKey,
      defaultParams: config.defaultParams
    });
  };

  const app = express();
  app.use(express.json());
  app.use(
    cors({
      origin: '*',
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization', 'X-MCP-Token']
    })
  );
  const auth = createAuth({
    adminAuthEnabled: config.adminAuthEnabled,
    adminToken: config.adminToken,
    sessionSecret: config.sessionSecret,
    mcpAuthToken: config.mcpAuthToken
  });

  app.use('/admin/assets', express.static(ADMIN_DIR));

  app.get(['/admin', '/admin/'], (_req, res) => {
    res.sendFile(path.join(ADMIN_DIR, 'index.html'));
  });

  app.get('/api/admin/session', (req, res) => {
    res.json(auth.sessionInfo(req));
  });

  app.post('/api/admin/login', asyncHandler(async (req, res) => {
    await adminLoginSchema.parseAsync(req.body ?? {});
    auth.login(req, res);
  }));

  app.post('/api/admin/logout', (req, res) => {
    auth.logout(req, res);
  });

  app.put('/api/admin/security', auth.requireAdmin, asyncHandler(async (req, res) => {
    const next = await adminSecurityUpdateSchema.parseAsync(req.body ?? {});
    const currentTokenProvided = Boolean(next.currentAdminToken);
    const currentTokenMatches = currentTokenProvided ? auth.verifyAdminToken(next.currentAdminToken) : null;
    if (currentTokenProvided && !currentTokenMatches) {
      logEvent('warn', 'security', 'Admin security update continued with mismatched confirmation token', {
        reason: 'already_authenticated_session',
        requestedChanges: {
          adminToken: Boolean(next.newAdminToken),
          mcpAuthToken: Boolean(next.newMcpAuthToken || next.clearMcpAuthToken),
          rotateSessionSecret: Boolean(next.rotateSessionSecret)
        }
      });
    }

    const adminTokenChanged = Boolean(next.newAdminToken);
    if (adminTokenChanged) {
      config.adminToken = next.newAdminToken;
      config.adminAuthEnabled = true;
    }
    if (next.rotateSessionSecret || adminTokenChanged) {
      config.sessionSecret = createSecret();
    }
    if (next.clearMcpAuthToken) {
      config.mcpAuthToken = '';
    } else if (next.newMcpAuthToken) {
      config.mcpAuthToken = next.newMcpAuthToken;
    }
    const adminRequiresLogin = Boolean(adminTokenChanged || next.rotateSessionSecret);

    auth.update({
      adminAuthEnabled: config.adminAuthEnabled,
      adminToken: config.adminToken,
      sessionSecret: config.sessionSecret,
      mcpAuthToken: config.mcpAuthToken
    });
    await persistConfig();

    const hfSyncRequested = Boolean(next.syncHfSecrets || next.hfToken || process.env.HF_WRITE_TOKEN);
    const hfSync = {
      requested: hfSyncRequested,
      ok: false,
      updatedKeys: [],
      skippedKeys: [],
      results: [],
      error: null
    };
    if (hfSyncRequested) {
      const token = resolveHfWriteToken(next.hfToken);
      const spaceId = resolveHfSpaceId(config);
      const secrets = [];
      if (adminTokenChanged) {
        secrets.push({
          key: 'ADMIN_TOKEN',
          value: config.adminToken,
          description: 'Admin login token'
        });
      }
      if (next.rotateSessionSecret || adminTokenChanged) {
        secrets.push({
          key: 'SESSION_SECRET',
          value: config.sessionSecret,
          description: 'Session signing secret'
        });
      }
      if (next.newMcpAuthToken) {
        secrets.push({
          key: 'MCP_AUTH_TOKEN',
          value: config.mcpAuthToken,
          description: 'MCP bearer token'
        });
      }
      if (next.clearMcpAuthToken) {
        hfSync.skippedKeys.push('MCP_AUTH_TOKEN');
      }

      if (!spaceId) {
        hfSync.error = { code: 'HF_SPACE_ID_MISSING', message: 'HF_SPACE_ID/SPACE_ID is not configured' };
      } else if (!token) {
        hfSync.error = { code: 'HF_WRITE_TOKEN_MISSING', message: 'HF_WRITE_TOKEN is not configured' };
      } else if (secrets.length) {
        hfSync.results = await writeHfSecrets(config, { token, secrets });
        hfSync.updatedKeys = hfSync.results.filter((item) => item.ok).map((item) => item.key);
        hfSync.ok = hfSync.results.every((item) => item.ok);
      } else {
        hfSync.ok = true;
      }
    }

    if (adminRequiresLogin) {
      auth.clearSession(req, res);
    }

    logEvent('info', 'security', 'Admin security updated', {
      changed: {
        adminToken: adminTokenChanged,
        sessionSecret: Boolean(next.rotateSessionSecret || adminTokenChanged),
        mcpAuthToken: Boolean(next.newMcpAuthToken || next.clearMcpAuthToken)
      },
      adminRequiresLogin,
      envOverrides: {
        adminToken: Boolean(process.env.ADMIN_TOKEN),
        sessionSecret: Boolean(process.env.SESSION_SECRET),
        mcpAuthToken: Boolean(process.env.MCP_AUTH_TOKEN)
      },
      confirmation: {
        required: false,
        provided: currentTokenProvided,
        matched: currentTokenMatches
      },
      hfSync: {
        requested: hfSync.requested,
        ok: hfSync.ok,
        updatedKeys: hfSync.updatedKeys,
        skippedKeys: hfSync.skippedKeys,
        error: hfSync.error,
        failedKeys: hfSync.results.filter((item) => !item.ok).map((item) => item.key)
      }
    });

    res.json({
      ok: true,
      adminRequiresLogin,
      auth: {
        adminAuthEnabled: auth.adminAuthEnabled,
        mcpAuthEnabled: auth.mcpAuthEnabled
      },
      envOverrides: {
        adminToken: Boolean(process.env.ADMIN_TOKEN),
        sessionSecret: Boolean(process.env.SESSION_SECRET),
        mcpAuthToken: Boolean(process.env.MCP_AUTH_TOKEN)
      },
      confirmation: {
        required: false,
        provided: currentTokenProvided,
        matched: currentTokenMatches
      },
      hfSync
    });
  }));

  app.get('/api/admin/config', auth.requireAdmin, (_req, res) => {
    res.json(publicConfig());
  });

  app.get('/api/admin/logs', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminLogsQuerySchema.parseAsync(req.query ?? {});
    const entries = await readLogEntries(input);
    res.json({
      ok: true,
      logFilePath: getLogFilePath(),
      count: entries.length,
      entries
    });
  }));

  app.get('/api/admin/keys/status', auth.requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      keyStatus: buildKeyStatus(config)
    });
  });

  app.get('/api/admin/monitoring', auth.requireAdmin, (_req, res) => {
    res.json(buildMonitoringSnapshot(config, monitoring));
  });

  app.post('/api/admin/monitoring/probe', auth.requireAdmin, asyncHandler(async (req, res) => {
    const force = Boolean(req.body?.force);
    const snapshot = await runMonitoringProbe({ config, monitor: monitoring, force });
    res.json(snapshot);
  }));

  app.put('/api/admin/config', auth.requireAdmin, asyncHandler(async (req, res) => {
    const next = await adminConfigUpdateSchema.parseAsync(req.body ?? {});
    const updateSecret = (clear, value, key) => {
      if (clear) {
        config[key] = '';
      } else if (value !== undefined && value.trim()) {
        config[key] = value.trim();
      }
    };

    if (next.searchEndpoint) {
      config.searchEndpoint = next.searchEndpoint;
    }
    if (next.searchShChatEndpoint !== undefined) {
      config.searchShChatEndpoint = next.searchShChatEndpoint || '';
    }
    if (next.clearSearchShApiKey) {
      config.searchShApiKey = '';
    } else if (next.searchShApiKey !== undefined && next.searchShApiKey.trim()) {
      config.searchShApiKey = next.searchShApiKey.trim();
    }
    if (next.grokApiUrl !== undefined) {
      config.grokApiUrl = next.grokApiUrl || '';
    }
    updateSecret(next.clearGrokApiKey, next.grokApiKey, 'grokApiKey');
    if (next.grokModel !== undefined && next.grokModel) {
      config.grokModel = next.grokModel;
    }
    if (next.grokSystemPrompt !== undefined) {
      config.grokSystemPrompt = next.grokSystemPrompt || DEFAULT_GROK_SYSTEM_PROMPT;
    }
    if (next.tavilyEnabled !== undefined) {
      config.tavilyEnabled = next.tavilyEnabled;
    }
    if (next.tavilyProvider !== undefined) {
      config.tavilyProvider = next.tavilyProvider;
    }
    if (next.tavilyApiUrl !== undefined) {
      config.tavilyApiUrl = next.tavilyApiUrl || DEFAULT_CONFIG.tavilyApiUrl;
    }
    updateSecret(next.clearTavilyApiKey, next.tavilyApiKey, 'tavilyApiKey');
    if (next.tavilyMcpUrl !== undefined) {
      config.tavilyMcpUrl = next.tavilyMcpUrl || '';
    }
    updateSecret(next.clearTavilyMcpToken, next.tavilyMcpToken, 'tavilyMcpToken');
    if (next.tavilyMcpSearchTool !== undefined) {
      config.tavilyMcpSearchTool = next.tavilyMcpSearchTool || '';
    }
    if (next.tavilyMcpExtractTool !== undefined) {
      config.tavilyMcpExtractTool = next.tavilyMcpExtractTool || '';
    }
    if (next.tavilyMcpMapTool !== undefined) {
      config.tavilyMcpMapTool = next.tavilyMcpMapTool || '';
    }
    if (next.firecrawlApiUrl !== undefined) {
      config.firecrawlApiUrl = next.firecrawlApiUrl || DEFAULT_CONFIG.firecrawlApiUrl;
    }
    updateSecret(next.clearFirecrawlApiKey, next.firecrawlApiKey, 'firecrawlApiKey');
    if (next.defaultParams) {
      config.defaultParams = {
        ...config.defaultParams,
        ...Object.fromEntries(
          Object.entries(next.defaultParams).filter(([, value]) => value !== undefined)
        )
      };
    }

    await persistConfig();
    logEvent('info', 'config', 'Runtime config saved', {
      searchEndpoint: Boolean(config.searchEndpoint),
      search2api: Boolean(config.searchShChatEndpoint),
      fusion: {
        grok: Boolean(config.grokApiUrl || config.grokApiKey),
        tavily: Boolean(config.tavilyApiUrl || config.tavilyApiKey || config.tavilyMcpUrl || config.tavilyMcpToken),
        firecrawl: Boolean(config.firecrawlApiUrl || config.firecrawlApiKey)
      }
    });
    res.json(publicConfig());
  }));

  app.get('/api/admin/hf-secrets', auth.requireAdmin, asyncHandler(async (_req, res) => {
    const token = resolveHfWriteToken();
    const spaceId = resolveHfSpaceId(config);
    const base = {
      ok: Boolean(token && spaceId),
      canWrite: Boolean(token && spaceId),
      endpoint: resolveHfEndpoint(config),
      spaceId,
      hasEnvToken: Boolean(process.env.HF_WRITE_TOKEN),
      options: HF_SECRET_OPTIONS,
      secrets: []
    };

    if (!token || !spaceId) {
      res.json({
        ...base,
        message: !spaceId
          ? 'HF_SPACE_ID/SPACE_ID is not configured'
          : 'HF_WRITE_TOKEN is not configured; paste a one-time token when saving'
      });
      return;
    }

    try {
      const payload = await requestHfJson(config, { token });
      res.json({
        ...base,
        secrets: normalizeHfSecretRows(payload),
        message: 'ok'
      });
    } catch (error) {
      res.json({
        ...base,
        ok: false,
        error: formatHfApiError(error)
      });
    }
  }));

  app.put('/api/admin/hf-secrets', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await hfSecretUpdateSchema.parseAsync(req.body ?? {});
    const token = resolveHfWriteToken(input.hfToken);
    const spaceId = resolveHfSpaceId(config);

    if (!spaceId) {
      res.status(400).json({
        error: {
          code: 'HF_SPACE_ID_MISSING',
          message: 'HF_SPACE_ID/SPACE_ID is not configured'
        }
      });
      return;
    }
    if (!token) {
      res.status(400).json({
        error: {
          code: 'HF_WRITE_TOKEN_MISSING',
          message: 'HF_WRITE_TOKEN is not configured'
        }
      });
      return;
    }

    const results = await writeHfSecrets(config, { token, secrets: input.secrets });

    const ok = results.every((item) => item.ok);
    const successfulKeys = new Set(results.filter((item) => item.ok).map((item) => item.key));
    const successfulSecrets = input.secrets.filter((item) => successfulKeys.has(item.key));
    let runtimeAuthUpdated = false;
    let adminRequiresLogin = false;
    const runtimeChangedKeys = [];

    const findSecretValue = (key) => successfulSecrets.find((item) => item.key === key)?.value;
    const findTrimmedSecretValue = (key) => {
      const value = findSecretValue(key);
      return typeof value === 'string' ? value.trim() : value;
    };
    const nextAdminToken = findTrimmedSecretValue('ADMIN_TOKEN');
    const nextSessionSecret = findSecretValue('SESSION_SECRET');
    const nextMcpAuthToken = findTrimmedSecretValue('MCP_AUTH_TOKEN');

    if (nextAdminToken) {
      config.adminToken = nextAdminToken;
      config.adminAuthEnabled = true;
      config.sessionSecret = nextSessionSecret || createSecret();
      runtimeAuthUpdated = true;
      adminRequiresLogin = true;
      runtimeChangedKeys.push('ADMIN_TOKEN', 'SESSION_SECRET');
    } else if (nextSessionSecret) {
      config.sessionSecret = nextSessionSecret;
      runtimeAuthUpdated = true;
      adminRequiresLogin = true;
      runtimeChangedKeys.push('SESSION_SECRET');
    }

    if (nextMcpAuthToken) {
      config.mcpAuthToken = nextMcpAuthToken;
      runtimeAuthUpdated = true;
      runtimeChangedKeys.push('MCP_AUTH_TOKEN');
    }

    if (runtimeAuthUpdated) {
      auth.update({
        adminAuthEnabled: config.adminAuthEnabled,
        adminToken: config.adminToken,
        sessionSecret: config.sessionSecret,
        mcpAuthToken: config.mcpAuthToken
      });
      await persistConfig();
      if (adminRequiresLogin) {
        auth.clearSession(req, res);
      }
    }

    logEvent(ok ? 'info' : 'warn', 'hf-secrets', 'Hugging Face Secrets update finished', {
      ok,
      updatedKeys: results.filter((item) => item.ok).map((item) => item.key),
      failedKeys: results.filter((item) => !item.ok).map((item) => item.key),
      runtimeChangedKeys,
      adminRequiresLogin
    });

    res.status(ok ? 200 : 207).json({
      ok,
      spaceId,
      endpoint: resolveHfEndpoint(config),
      updatedKeys: results.filter((item) => item.ok).map((item) => item.key),
      results,
      runtimeAuthUpdated,
      runtimeChangedKeys,
      adminRequiresLogin,
      note: 'Hugging Face restarts or rebuilds may be needed before changed secrets are visible to the running container.'
    });
  }));

  app.post('/api/admin/test/search', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminSearchTestSchema.parseAsync(req.body ?? {});
    const query = resolveQuery(input.query);
    const overrides = {
      pageno: input.page?.toString(),
      categories: input.categories,
      language: input.language,
      time_range: input.time_range,
      safesearch: input.safesearch
    };

    const timeout = createTimeoutSignal();
    const startedAt = Date.now();
    try {
      const { payload, params } = await executeSearch({
        endpoint: config.searchEndpoint,
        defaultParams: config.defaultParams,
        query,
        overrides,
        signal: timeout.signal
      });
      monitoring.record('libresearch', {
        ok: true,
        message: 'Admin LibreSearch 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        params,
        resultCount: Array.isArray(payload?.results) ? payload.results.length : 0,
        summary: buildSummaryLines({ query, params, payload }).join('\n'),
        payload
      });
    } catch (error) {
      monitoring.record('libresearch', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    } finally {
      timeout.clear();
    }
  }));

  app.post('/api/admin/test/search-sh', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminSearchShTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();

    if (!config.searchShChatEndpoint) {
      monitoring.record('search2api', {
        status: 'paused',
        message: '未配置 Search-2api 接口',
        source: 'admin-test'
      });
      res.json({ ok: false, error: { message: '未配置 Search-2api 接口' } });
      return;
    }

    const body = {
      model: input.model || 'search-sh-ai',
      messages: [{ role: 'user', content: input.prompt }]
    };
    const headers = { 'Content-Type': 'application/json' };
    if (config.searchShApiKey) {
      headers.Authorization = `Bearer ${config.searchShApiKey}`;
    }

    const requestSearch2Api = async (stream) => {
      const timeout = createTimeoutSignal(45_000);
      try {
        const response = await fetch(config.searchShChatEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, stream }),
          signal: timeout.signal
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { text };
        }
        if (!response.ok) {
          return {
            ok: false,
            error: {
              message: `Search-2api 响应 ${response.status} ${response.statusText}`,
              body: text.slice(0, 1200)
            }
          };
        }

        const answer = stream ? extractSearch2ApiSseText(text) : extractSearch2ApiJsonText(payload);
        if (!answer) {
          return {
            ok: false,
            error: {
              message: stream ? 'Search-2api 流式响应未返回有效内容' : 'Search-2api 非流式响应未返回有效内容',
              body: text.slice(0, 1200)
            }
          };
        }

        return { ok: true, answer, payload };
      } catch (error) {
        return {
          ok: false,
          error: formatAdminTestError(
            error,
            error instanceof Error ? error.message : String(error)
          )
        };
      } finally {
        timeout.clear();
      }
    };

    const streamResult = await requestSearch2Api(true);
    const result = streamResult.ok ? streamResult : await requestSearch2Api(false);

    if (result.ok) {
      monitoring.record('search2api', {
        ok: true,
        message: `Admin Search-2api ${streamResult.ok ? 'stream' : 'non-stream'} 测试通过`,
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        model: body.model,
        mode: streamResult.ok ? 'stream' : 'non-stream',
        answer: result.answer,
        payload: result.payload,
        fallback: streamResult.ok ? null : streamResult.error
      });
      return;
    }

    monitoring.record('search2api', {
      ok: false,
      message: result.error?.message || 'Search-2api 测试失败',
      responseTimeMs: Date.now() - startedAt,
      source: 'admin-test'
    });
    res.json({
      ok: false,
      error: result.error,
      fallback: streamResult.ok ? null : streamResult.error
    });
  }));

  app.post('/api/admin/test/search2api-status', auth.requireAdmin, asyncHandler(async (_req, res) => {
    const baseUrl = getSearch2ApiBaseUrl(config.searchShChatEndpoint);
    const authHeaders = config.searchShApiKey ? { Authorization: `Bearer ${config.searchShApiKey}` } : undefined;
    const result = {
      ok: true,
      source: {
        project: 'lza6/Search-2api',
        url: config.searchShProjectUrl,
        expectedChatEndpoint: '/v1/chat/completions',
        cookieRisk: 'Search-2api 依赖 search.sh 浏览器 Cookie，Cookie 或上游接口变更会导致失效'
      },
      configured: {
        chatEndpoint: config.searchShChatEndpoint,
        baseUrl,
        hasApiKey: Boolean(config.searchShApiKey)
      }
    };

    try {
      const repoTimeout = createTimeoutSignal(8000);
      let repoResponse;
      let repoPayload;
      try {
        repoResponse = await fetch(SEARCH_2API_REPO_API, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: repoTimeout.signal
        });
        repoPayload = await repoResponse.json().catch(() => ({}));
      } finally {
        repoTimeout.clear();
      }
      const pushedAt = repoPayload?.commit?.committer?.date || repoPayload?.commit?.author?.date;
      const ageDays = pushedAt ? Math.floor((Date.now() - new Date(pushedAt).getTime()) / 86_400_000) : null;
      result.upstream = {
        ok: repoResponse.ok,
        status: repoResponse.status,
        latestCommit: repoPayload?.sha,
        latestCommitAt: pushedAt,
        ageDays,
        stale: typeof ageDays === 'number' ? ageDays > SEARCH_2API_STALE_DAYS : null,
        message: typeof ageDays === 'number' && ageDays > SEARCH_2API_STALE_DAYS
          ? `上游最近提交已超过 ${SEARCH_2API_STALE_DAYS} 天，需要以实际接口测试为准`
          : '上游仓库可访问'
      };
    } catch (error) {
      result.ok = false;
      result.upstream = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (!baseUrl) {
      result.ok = false;
      result.runtime = {
        ok: false,
        message: '未配置 Search-2api Chat Completions 地址'
      };
      res.json(result);
      return;
    }

    const rootUrl = `${baseUrl}/`;
    const modelsUrl = `${baseUrl}/v1/models`;
    try {
      const [rootCheck, modelsCheck] = await Promise.all([
        fetchTextWithTimeout(rootUrl, { timeoutMs: 8000 }),
        fetchTextWithTimeout(modelsUrl, { timeoutMs: 8000, headers: authHeaders })
      ]);
      result.runtime = {
        ok: rootCheck.ok || modelsCheck.ok,
        root: rootCheck,
        models: modelsCheck,
        message: modelsCheck.ok
          ? 'Search-2api /v1/models 可访问'
          : 'Search-2api 未通过模型接口探针，请检查服务、Cookie 或 API_MASTER_KEY'
      };
      if (!result.runtime.ok) result.ok = false;
    } catch (error) {
      result.ok = false;
      result.runtime = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    res.json(result);
  }));

  app.post('/api/admin/test/grok', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminGrokTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeGrokWebSearch({
        config,
        query: input.query,
        platform: input.platform,
        model: input.model,
        extraSources: input.extraSources ?? 0,
        timeoutMs: ADMIN_TEST_TIMEOUT_MS
      });
      monitoring.record('grok', {
        ok: true,
        message: 'Admin Grok 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      monitoring.record('grok', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.post('/api/admin/test/tavily-search', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminTavilySearchTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeTavilySearchOnly({
        config,
        query: input.query,
        maxResults: input.maxResults ?? 5
      });
      monitoring.record('tavily', {
        ok: true,
        message: 'Admin Tavily Search 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        provider: result.provider,
        resultCount: result.results.length,
        results: result.results
      });
    } catch (error) {
      monitoring.record('tavily', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.post('/api/admin/test/tavily-fetch', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminFetchTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeTavilyExtractOnly({
        config,
        url: input.url,
        timeoutMs: ADMIN_TEST_TIMEOUT_MS
      });
      monitoring.record('tavily', {
        ok: true,
        message: 'Admin Tavily Fetch 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        provider: result.provider,
        preview: result.content.slice(0, 2000),
        length: result.content.length
      });
    } catch (error) {
      monitoring.record('tavily', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.post('/api/admin/test/fusion-fetch', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminFetchTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeTavilyFetch({
        config,
        url: input.url,
        timeoutMs: ADMIN_TEST_TIMEOUT_MS
      });
      monitoring.record(result.provider === 'firecrawl' ? 'firecrawl' : 'tavily', {
        ok: true,
        message: `Admin Fusion Fetch 通过：${result.provider}`,
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        provider: result.provider,
        preview: result.content.slice(0, 2000),
        length: result.content.length
      });
    } catch (error) {
      monitoring.record('tavily', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.post('/api/admin/test/firecrawl-fetch', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminFetchTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeFirecrawlFetch({
        config,
        url: input.url,
        timeoutMs: ADMIN_TEST_TIMEOUT_MS
      });
      monitoring.record('firecrawl', {
        ok: true,
        message: 'Admin Firecrawl 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: true,
        provider: result.provider,
        preview: result.content.slice(0, 2000),
        length: result.content.length
      });
    } catch (error) {
      monitoring.record('firecrawl', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.post('/api/admin/test/fusion-map', auth.requireAdmin, asyncHandler(async (req, res) => {
    const input = await adminMapTestSchema.parseAsync(req.body ?? {});
    const startedAt = Date.now();
    try {
      const result = await executeTavilyMap({ config, ...input, timeout: input.timeout ?? 30 });
      monitoring.record('tavily', {
        ok: true,
        message: 'Admin Tavily Map 测试通过',
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      monitoring.record('tavily', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'admin-test'
      });
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.get('/api/admin/fusion/config-info', auth.requireAdmin, asyncHandler(async (req, res) => {
    const testConnection = req.query.test === '1' || req.query.test === 'true';
    const info = await buildFusionConfigInfo({ config, testConnection });
    res.json(info);
  }));

  app.get('/api/admin/fusion/models', auth.requireAdmin, asyncHandler(async (_req, res) => {
    try {
      const models = await fetchAvailableModels({ config, timeoutMs: ADMIN_TEST_TIMEOUT_MS });
      res.json({ ok: true, models });
    } catch (error) {
      res.json({
        ok: false,
        error: formatAdminTestError(
          error,
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  }));

  app.use('/api/admin', (error, _req, res, _next) => {
    sendAdminError(error, res);
  });

  const streamableSessions = new Map();
  const sseSessions = new Map();

  const registerMcpProfile = (server, profile) => {
    createPrecisionTools(server, config, sourceCache, {
      includeSearch: profile === 'full' || profile === 'libresearch',
      includeFusion: profile === 'full' || profile === 'fusion',
      monitoring
    });

    if (profile === 'full' || profile === 'libresearch') {
      createSearchTool(server, config);
      createBatchSearchTool(server, config);
      createTopLinksTool(server, config);
      createAnswersTool(server, config);
      createFetchHtmlTool(server);
    }

    if (profile === 'full') {
      createDualSearchTool(server, config);
    }

    if (profile === 'full' || profile === 'fusion') {
      createSearchShTool(server, config);
      createFusionSearchTools(server, config, sourceCache, persistConfig);
    }

    registerResources(server, config);
  };

  const createServerInstance = (profile = 'full') => {
    const server = new McpServer(
      {
        name: config.serverName,
        version: config.serverVersion,
        icons: [
          {
            src: 'https://huggingface.co/favicon.ico',
            sizes: ['32x32'],
            mimeType: 'image/png'
          }
        ]
      },
      {
        capabilities: {
          logging: {},
          tools: {
            listChanged: true
          },
          resources: {
            listChanged: true
          }
        },
        instructions:
          `This endpoint exposes the "${profile}" FusionSearch MCP profile. ` +
          'Use /mcp as the primary unified FusionSearch MCP entry. It combines five provider layers: LibreSearch, Search-2api, Grok/OpenAI-compatible, Tavily, and Firecrawl. ' +
          'Preferred smart tools are "smart_research", "smart_fetch", and "fusion_status"; provider tools are "web_search", "web_fetch", "web_map", "libre_search", "search2api_chat", and "fusion_research". Legacy fusionsearch_* and libresearch_* tools remain available for compatibility. ' +
          'POST initialize/call requests to / or /mcp (Streamable HTTP). If headers are inconvenient, /mcp/ApiKey=<token> is supported as a convenience shortcut. Legacy SSE clients connect to /sse (or /mcp/sse) and POST to /messages (or /mcp/messages) with the provided sessionId.'
      }
    );

    registerMcpProfile(server, profile);

    return server;
  };

  const streamableRoutes = [
    { path: '/mcp', profile: 'full' },
    { path: '/', profile: 'full' },
    { path: '/libresearch/mcp', profile: 'libresearch' },
    { path: '/fusion/mcp', profile: 'fusion' }
  ];
  const tokenizedStreamableRoutes = streamableRoutes
    .filter(({ path }) => path !== '/')
    .map(({ path, profile }) => ({
      path: `${path}/ApiKey=:mcpPathToken`,
      profile
    }));

  const streamablePostHandler = (profile) => async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? streamableSessions.get(sessionId) : undefined;

    try {
      if (!session) {
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: 无有效的 session 初始化请求'
            },
            id: null
          });
          return;
        }

        const server = createServerInstance(profile);
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            streamableSessions.set(id, {
              transport: newTransport,
              server
            });
          }
        });

        newTransport.onclose = () => {
          if (newTransport.sessionId) {
            streamableSessions.delete(newTransport.sessionId);
          }
          if (typeof server.close === 'function') {
            server.close().catch((error) => {
              console.error('[MCP] 关闭 server 失败', error);
            });
          }
        };

        await server.connect(newTransport);
        await newTransport.handleRequest(req, res, req.body);
        return;
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] 请求处理失败', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error?.message ?? 'Internal Server Error'
          },
          id: null
        });
      }
    }
  };

  [...streamableRoutes, ...tokenizedStreamableRoutes].forEach(({ path, profile }) => {
    app.post(path, auth.requireMcp, streamablePostHandler(profile));
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!sessionId || !session) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('[MCP] session 请求失败', error);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  };

  [...streamableRoutes, ...tokenizedStreamableRoutes].forEach(({ path }) => {
    if (path === '/') {
      app.get(path, (req, res, next) => {
        if (envEnabled('ENABLE_GATEWAY_PROXY')) {
          next('route');
          return;
        }
        const accept = String(req.headers.accept ?? '');
        if (!req.headers['mcp-session-id'] && (accept.includes('text/html') || accept === '*/*')) {
          res.redirect(302, '/admin');
          return;
        }
        auth.requireMcp(req, res, next);
      }, handleSessionRequest);
    } else {
      app.get(path, auth.requireMcp, handleSessionRequest);
    }
    app.delete(path, auth.requireMcp, handleSessionRequest);
  });

  const sseRoutes = [
    { path: '/mcp/sse', eventPath: '/mcp/messages', profile: 'full' },
    { path: '/sse', eventPath: '/messages', profile: 'full' },
    { path: '/libresearch/mcp/sse', eventPath: '/libresearch/mcp/messages', profile: 'libresearch' },
    { path: '/fusion/mcp/sse', eventPath: '/fusion/mcp/messages', profile: 'fusion' }
  ];
  const tokenizedSseRoutes = [
    {
      path: '/mcp/ApiKey=:mcpPathToken/sse',
      eventPath: (req) => `/mcp/ApiKey=${encodeURIComponent(req.params.mcpPathToken)}/messages`,
      profile: 'full'
    },
    {
      path: '/libresearch/mcp/ApiKey=:mcpPathToken/sse',
      eventPath: (req) => `/libresearch/mcp/ApiKey=${encodeURIComponent(req.params.mcpPathToken)}/messages`,
      profile: 'libresearch'
    },
    {
      path: '/fusion/mcp/ApiKey=:mcpPathToken/sse',
      eventPath: (req) => `/fusion/mcp/ApiKey=${encodeURIComponent(req.params.mcpPathToken)}/messages`,
      profile: 'fusion'
    }
  ];

  const createSseHandler = (eventPath, profile) => async (req, res) => {
    try {
      const server = createServerInstance(profile);
      const resolvedEventPath = typeof eventPath === 'function' ? eventPath(req) : eventPath;
      const transport = new SSEServerTransport(resolvedEventPath, res);

      sseSessions.set(transport.sessionId, { transport, server });

      res.on('close', async () => {
        if (transport.sessionId) {
          sseSessions.delete(transport.sessionId);
        }
        try {
          await transport.close();
        } catch (error) {
          console.error('[MCP] 关闭 SSE transport 失败', error);
        }
        try {
          if (typeof server.close === 'function') {
            await server.close();
          }
        } catch (error) {
          console.error('[MCP] 关闭 SSE server 失败', error);
        }
      });

      await server.connect(transport);
    } catch (error) {
      console.error('[MCP] SSE 初始化失败', error);
      if (!res.headersSent) {
        res.status(500).send('Failed to initialize SSE transport');
      }
    }
  };

  [...sseRoutes, ...tokenizedSseRoutes].forEach(({ path, eventPath, profile }) => {
    app.get(path, auth.requireMcp, createSseHandler(eventPath, profile));
  });

  const sseMessagePaths = ['/mcp/messages', '/messages', '/libresearch/mcp/messages', '/fusion/mcp/messages'];
  const tokenizedSseMessagePaths = [
    '/mcp/ApiKey=:mcpPathToken/messages',
    '/libresearch/mcp/ApiKey=:mcpPathToken/messages',
    '/fusion/mcp/ApiKey=:mcpPathToken/messages'
  ];

  const handleSseMessage = async (req, res) => {
    const sessionId = (req.query.sessionId ?? req.headers['mcp-session-id'])?.toString();
    if (!sessionId) {
      res.status(400).send('Missing sessionId');
      return;
    }

    const session = sseSessions.get(sessionId);
    if (!session) {
      res.status(400).send('No transport found for sessionId');
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('[MCP] 处理 SSE 消息失败', error);
      if (!res.headersSent) {
        res.status(500).send('Failed to handle SSE message');
      }
    }
  };

  [...sseMessagePaths, ...tokenizedSseMessagePaths].forEach((path) => {
    app.post(path, auth.requireMcp, handleSseMessage);
  });

  app.get('/api/search/stream', async (req, res) => {
    const query = resolveQuery(req.query.q);

    const overrides = { ...req.query };
    delete overrides.q;

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('init', {
      message: 'SSE stream established',
      query,
      endpoint: config.searchEndpoint
    });

    try {
      const { payload, params } = await executeSearch({
        endpoint: config.searchEndpoint,
        defaultParams: config.defaultParams,
        query,
        overrides,
        signal: abortController.signal
      });

      sendEvent('results', {
        receivedAt: new Date().toISOString(),
        params,
        payload
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        sendEvent('aborted', { message: 'Request aborted by client.' });
      } else {
        sendEvent('error', {
          message: 'Failed to fetch search results.',
          details: error instanceof Error ? error.message : error,
          status: error?.status,
          body: error?.body
        });
      }
    } finally {
      sendEvent('end', { message: 'Stream closed.' });
      res.end();
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/status', (_req, res) => {
    res.json({
      name: config.serverName,
      version: config.serverVersion,
      mcpEndpoint: '/mcp',
      mcpEndpoints: {
        full: '/mcp',
        fullApiKeyShortcut: '/mcp/ApiKey=<MCP_AUTH_TOKEN>',
        libresearch: '/libresearch/mcp',
        fusion: '/fusion/mcp',
        sseApiKeyShortcut: '/mcp/ApiKey=<MCP_AUTH_TOKEN>/sse'
      },
      mcpAuthEnabled: auth.mcpAuthEnabled,
      adminAuthEnabled: auth.adminAuthEnabled,
      sseEndpoint: '/api/search/stream'
    });
  });

  registerGatewayProxy(app);

  return app;
}
