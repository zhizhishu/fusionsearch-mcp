import { executeSearch } from './searchClient.js';
import { fetchAvailableModels, getFusionPublicConfig, resolveFusionConfig } from './fusionClients.js';
import { logEvent } from './logger.js';

const MONITORED_SERVICES = [
  { id: 'libresearch', name: 'LibreSearch', type: 'search/api' },
  { id: 'search2api', name: 'Search-2api', type: 'chat/api' },
  { id: 'grok', name: 'Grok', type: 'ai/api' },
  { id: 'tavily', name: 'Tavily', type: 'search/fetch/map' },
  { id: 'firecrawl', name: 'Firecrawl', type: 'scrape/api' }
];
const PROBE_COOLDOWN_MS = 10 * 60 * 1000;

export function createMonitoringState() {
  const events = new Map();
  let lastProbeAt = 0;
  return {
    record(serviceId, event = {}) {
      const service = MONITORED_SERVICES.find((item) => item.id === serviceId);
      if (!service) return null;
      const normalized = normalizeMonitorEvent(serviceId, event);
      events.set(serviceId, normalized);
      logEvent(normalized.status === 'down' ? 'warn' : 'info', 'monitoring', 'Provider status updated', {
        service: serviceId,
        status: normalized.status,
        message: normalized.message,
        responseTimeMs: normalized.responseTimeMs,
        source: normalized.source
      });
      return normalized;
    },
    get(serviceId) {
      return events.get(serviceId) || null;
    },
    getLastProbeAt() {
      return lastProbeAt;
    },
    setLastProbeAt(value = Date.now()) {
      lastProbeAt = value;
    }
  };
}

export function buildKeyStatus(config = {}) {
  const fusion = resolveFusionConfig(config);
  return [
    endpointStatus('libresearchEndpoint', 'LibreSearch Endpoint', config.searchEndpoint, ['SEARCH_ENDPOINT']),
    secretStatus('search2apiBearer', 'Search-2api Bearer', config.searchShApiKey, ['SEARCH_SH_API_KEY', 'API_MASTER_KEY']),
    cookieStatus('search2apiCookie', 'Search-2api Cookie', process.env.SEARCH_SH_COOKIE || ''),
    secretStatus('grokApiKey', 'Grok API Key', fusion.grokApiKey, ['GROK_API_KEY']),
    secretStatus('tavilyApiKey', 'Tavily REST Key', fusion.tavilyApiKey, ['TAVILY_API_KEY']),
    secretStatus('tavilyMcpToken', 'Tavily MCP Token', fusion.tavilyMcpToken, ['TAVILY_MCP_TOKEN', 'TAVILY_HIKARI_TOKEN']),
    secretStatus('firecrawlApiKey', 'Firecrawl Key', fusion.firecrawlApiKey, ['FIRECRAWL_API_KEY']),
    secretStatus('adminToken', 'Admin Token', config.adminToken, ['ADMIN_TOKEN']),
    secretStatus('mcpAuthToken', 'MCP Token', config.mcpAuthToken, ['MCP_AUTH_TOKEN'])
  ];
}

// Owner-only: the live plaintext value behind each key-status row, resolved the same
// way buildKeyStatus resolves configured/masked (env var wins, then runtime config).
// Used by the 👁 reveal in the admin key center so runtime-only values also show,
// not just the ones injected from HF Secrets. Never logged; admin-locked endpoint only.
export function buildKeyReveal(config = {}) {
  const fusion = resolveFusionConfig(config);
  const pick = (envNames, fallback) => {
    for (const name of envNames) {
      if (process.env[name]) return process.env[name];
    }
    return fallback || '';
  };
  return {
    libresearchEndpoint: pick(['SEARCH_ENDPOINT'], config.searchEndpoint),
    search2apiBearer: pick(['SEARCH_SH_API_KEY', 'API_MASTER_KEY'], config.searchShApiKey),
    search2apiCookie: pick(['SEARCH_SH_COOKIE'], ''),
    grokApiKey: pick(['GROK_API_KEY'], fusion.grokApiKey),
    tavilyApiKey: pick(['TAVILY_API_KEY'], fusion.tavilyApiKey),
    tavilyMcpToken: pick(['TAVILY_MCP_TOKEN', 'TAVILY_HIKARI_TOKEN'], fusion.tavilyMcpToken),
    firecrawlApiKey: pick(['FIRECRAWL_API_KEY'], fusion.firecrawlApiKey),
    adminToken: pick(['ADMIN_TOKEN'], config.adminToken),
    mcpAuthToken: pick(['MCP_AUTH_TOKEN'], config.mcpAuthToken)
  };
}

export function buildMonitoringSnapshot(config = {}, monitor = createMonitoringState()) {
  const keyStatus = buildKeyStatus(config);
  const fusion = getFusionPublicConfig(config);
  const services = MONITORED_SERVICES.map((service) => {
    const configured = isServiceConfigured(service.id, config, fusion, keyStatus);
    const last = monitor.get(service.id);
    const status = last?.status || (configured ? 'warning' : 'paused');
    const message = last?.message || (configured ? '已配置，等待最近调用或手动探针确认' : '未配置或已关闭');
    return {
      ...service,
      configured,
      status,
      statusLabel: statusLabel(status),
      message,
      responseTimeMs: last?.responseTimeMs ?? null,
      checkedAt: last?.checkedAt ?? null,
      source: last?.source || (configured ? 'config' : 'config-missing')
    };
  });
  const counts = services.reduce((acc, service) => {
    acc[service.status] = (acc[service.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    count: services.length,
    counts: {
      up: counts.up || 0,
      warning: counts.warning || 0,
      down: counts.down || 0,
      paused: counts.paused || 0
    },
    services,
    keyStatus,
    lastProbeAt: monitor.getLastProbeAt() || null
  };
}

export async function runMonitoringProbe({ config, monitor, force = false }) {
  const state = monitor || createMonitoringState();
  const now = Date.now();
  const lastProbeAt = state.getLastProbeAt();
  if (!force && lastProbeAt && now - lastProbeAt < PROBE_COOLDOWN_MS) {
    return {
      ...buildMonitoringSnapshot(config, state),
      probe: {
        skipped: true,
        reason: `主动探针冷却中，${Math.ceil((PROBE_COOLDOWN_MS - (now - lastProbeAt)) / 1000)} 秒后可再次运行`
      }
    };
  }

  state.setLastProbeAt(now);
  await Promise.allSettled([
    probeLibreSearch(config, state),
    probeSearch2Api(config, state),
    probeGrok(config, state),
    probeTavily(config, state),
    probeFirecrawl(config, state)
  ]);

  return {
    ...buildMonitoringSnapshot(config, state),
    probe: {
      skipped: false,
      checkedAt: new Date(now).toISOString()
    }
  };
}

function normalizeMonitorEvent(serviceId, event) {
  const status = event.status || (event.ok === true ? 'up' : event.ok === false ? 'down' : 'warning');
  return {
    serviceId,
    status: normalizeStatus(status),
    message: event.message || (event.ok ? '最近调用成功' : '最近调用失败'),
    responseTimeMs: Number.isFinite(event.responseTimeMs) ? Math.max(0, Math.round(event.responseTimeMs)) : null,
    checkedAt: event.checkedAt || new Date().toISOString(),
    source: event.source || 'runtime'
  };
}

function normalizeStatus(status) {
  return ['up', 'warning', 'down', 'paused'].includes(status) ? status : 'warning';
}

function statusLabel(status) {
  return {
    up: 'Up',
    warning: 'Warning',
    down: 'Down',
    paused: 'Paused'
  }[status] || 'Warning';
}

function isServiceConfigured(id, config, fusion, keyStatus) {
  const hasKey = (key) => keyStatus.find((item) => item.id === key)?.configured;
  if (id === 'libresearch') return Boolean(config.searchEndpoint);
  if (id === 'search2api') return Boolean(config.searchShChatEndpoint || hasKey('search2apiCookie'));
  if (id === 'grok') return Boolean(fusion.grokApiUrl && fusion.hasGrokApiKey);
  if (id === 'tavily') return Boolean(fusion.tavilyEnabled && fusion.hasTavilyCredentials);
  if (id === 'firecrawl') return Boolean(fusion.hasFirecrawlApiKey);
  return false;
}

async function probeLibreSearch(config, monitor) {
  if (!config.searchEndpoint) {
    monitor.record('libresearch', { status: 'paused', message: '未配置 LibreSearch endpoint', source: 'probe' });
    return;
  }
  const startedAt = Date.now();
  try {
    await executeSearch({
      endpoint: config.searchEndpoint,
      defaultParams: config.defaultParams,
      query: 'fusionsearch health',
      overrides: { pageno: '1', categories: 'general' }
    });
    monitor.record('libresearch', {
      ok: true,
      message: 'LibreSearch JSON 搜索探针通过',
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  } catch (error) {
    monitor.record('libresearch', {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  }
}

async function probeSearch2Api(config, monitor) {
  const baseUrl = getSearch2ApiBaseUrl(config.searchShChatEndpoint);
  if (!baseUrl) {
    monitor.record('search2api', { status: 'paused', message: '未配置 Search-2api endpoint', source: 'probe' });
    return;
  }
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
      headers: config.searchShApiKey ? { Authorization: `Bearer ${config.searchShApiKey}` } : undefined
    });
    monitor.record('search2api', {
      ok: response.ok,
      message: response.ok ? 'Search-2api /v1/models 探针通过' : `Search-2api models 响应 ${response.status}`,
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  } catch (error) {
    monitor.record('search2api', {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  }
}

async function probeGrok(config, monitor) {
  const fusion = getFusionPublicConfig(config);
  if (!fusion.grokApiUrl || !fusion.hasGrokApiKey) {
    monitor.record('grok', { status: 'paused', message: '未配置 Grok API URL 或 Key', source: 'probe' });
    return;
  }
  const startedAt = Date.now();
  try {
    const models = await fetchAvailableModels({ config, timeoutMs: 10_000 });
    monitor.record('grok', {
      ok: true,
      message: `Grok /models 探针通过，模型 ${models.length} 个`,
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  } catch (error) {
    monitor.record('grok', {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      responseTimeMs: Date.now() - startedAt,
      source: 'probe'
    });
  }
}

async function probeTavily(config, monitor) {
  const fusion = getFusionPublicConfig(config);
  if (!fusion.tavilyEnabled || !fusion.hasTavilyCredentials) {
    monitor.record('tavily', { status: 'paused', message: 'Tavily 未启用或未配置 Key/Token', source: 'probe' });
    return;
  }
  monitor.record('tavily', {
    status: 'warning',
    message: 'Tavily 已配置；为避免消耗额度，主动探针不发起搜索/抓取。请用测试页或 smart 工具刷新真实状态。',
    source: 'probe'
  });
}

async function probeFirecrawl(config, monitor) {
  const fusion = getFusionPublicConfig(config);
  if (!fusion.hasFirecrawlApiKey) {
    monitor.record('firecrawl', { status: 'paused', message: '未配置 Firecrawl Key', source: 'probe' });
    return;
  }
  monitor.record('firecrawl', {
    status: 'warning',
    message: 'Firecrawl 已配置；为避免消耗额度，主动探针不执行 Scrape。请用测试页或 smart_fetch 刷新真实状态。',
    source: 'probe'
  });
}

async function fetchWithTimeout(url, { headers, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });
    await response.text().catch(() => '');
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function endpointStatus(id, label, value, envNames) {
  const source = resolveSource(envNames, value);
  return {
    id,
    label,
    configured: Boolean(value),
    masked: value ? maskUrl(value) : '',
    source
  };
}

function secretStatus(id, label, configValue, envNames) {
  const envValue = envNames.map((name) => process.env[name]).find(Boolean);
  const value = envValue || configValue || '';
  return {
    id,
    label,
    configured: Boolean(value),
    masked: value ? maskSecret(value) : '',
    source: envValue ? envNames.find((name) => process.env[name] === envValue) : configValue ? 'runtime' : 'missing'
  };
}

function cookieStatus(id, label, value) {
  const hasClearance = /(?:^|;\s*)cf_clearance=/i.test(value);
  return {
    id,
    label,
    configured: Boolean(value),
    masked: value ? `${hasClearance ? 'cf_clearance=****' : 'cookie=****'}; len ${value.length}` : '',
    source: value ? 'SEARCH_SH_COOKIE' : 'missing',
    meta: {
      hasCfClearance: hasClearance,
      hasUserAgent: Boolean(process.env.SEARCH_SH_USER_AGENT)
    }
  };
}

function resolveSource(envNames, configValue) {
  const envName = envNames.find((name) => process.env[name]);
  if (envName) return envName;
  return configValue ? 'runtime' : 'missing';
}

function maskSecret(value) {
  const normalized = String(value).trim();
  if (!normalized) return '';
  if (normalized.length <= 8) return '*'.repeat(Math.min(normalized.length, 8));
  const prefix = normalized.slice(0, Math.min(4, Math.floor(normalized.length / 3)));
  const suffix = normalized.slice(-Math.min(4, Math.floor(normalized.length / 3)));
  return `${prefix}****${suffix}`;
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).slice(0, 120);
  }
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
