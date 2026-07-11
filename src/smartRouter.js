import { buildSummaryLines, executeSearch, resolveQuery } from './searchClient.js';
import {
  executeFirecrawlFetch,
  executeGrokWebSearch,
  executeTavilyExtractOnly,
  executeTavilySearchOnly
} from './fusionClients.js';
import {
  buildEvidencePipeline,
  buildFetchSynthesisPrompt,
  buildResearchSynthesisPrompt,
  formatEvidencePipeline
} from './fusionOrchestrator.js';
import { mergeSources } from './sourceCache.js';
import { resolveSmartStrategy } from './smartStrategies.js';

const DEFAULT_TIMEOUT_MS = 45_000;
// Grok 总结/汇总的独立短超时：Grok 中转挂/慢时，到点就降级返回抓取原文/证据，别用满整个
// timeoutMs 干等——那会撞爆 MCP 客户端 ~60s 硬超时，连已抓到的降级内容都拿不到。
const GROK_SUMMARY_TIMEOUT_MS = 30_000;
const MAX_CONTENT_FOR_GROK = 12_000;

export function isLikelyUrl(value = '') {
  return Boolean(normalizeUrl(value));
}

export async function executeSmartFetch({
  config,
  url,
  question = '',
  summarize = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  monitor
}) {
  const targetUrl = normalizeUrl(url);
  if (!targetUrl) {
    throw new Error('smart_fetch 需要合法 URL');
  }

  const attempts = [];
  let content = '';
  let provider = '';

  const tryProvider = async (providerId, label, fn) => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      const text = typeof result === 'string' ? result : result.content;
      if (!text?.trim()) {
        throw new Error(`${label} 返回空内容`);
      }
      content = text.trim();
      provider = result.provider || providerId;
      attempts.push({
        provider: providerId,
        status: 'up',
        message: `${label} 抓取成功`,
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, providerId, {
        ok: true,
        message: `${label} 抓取成功`,
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_fetch'
      });
      return true;
    } catch (error) {
      const status = isNotConfiguredError(error) ? 'paused' : 'down';
      attempts.push({
        provider: providerId,
        status,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, providerId, {
        status,
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_fetch'
      });
      return false;
    }
  };

  if (!content) {
    await tryProvider('tavily', 'Tavily Extract', () => executeTavilyExtractOnly({ config, url: targetUrl, timeoutMs }));
  }
  if (!content) {
    await tryProvider('firecrawl', 'Firecrawl Scrape', () => executeFirecrawlFetch({ config, url: targetUrl, timeoutMs }));
  }
  if (!content) {
    await tryProvider('html_fetch', 'HTML Fetch', () => fetchHtmlText(targetUrl, timeoutMs));
  }

  if (!content) {
    return {
      ok: false,
      mode: 'url',
      url: targetUrl,
      attempts,
      providers: providerMap(attempts),
      error: '所有抓取链路均失败'
    };
  }

  let answer = '';
  const pipeline = buildEvidencePipeline({
    query: question || targetUrl,
    sources: [{ provider, title: targetUrl, url: targetUrl, content, fetched: true }],
    fetched: [{ provider, title: targetUrl, url: targetUrl, content, fetched: true }],
    attempts,
    limit: 5
  });
  if (summarize || question.trim()) {
    const startedAt = Date.now();
    try {
      const result = await executeGrokWebSearch({
        config,
        query: buildFetchSynthesisPrompt({ url: targetUrl, question, content, attempts }),
        extraSources: 0,
        timeoutMs: Math.min(timeoutMs, GROK_SUMMARY_TIMEOUT_MS)
      });
      answer = result.content;
      recordMonitor(monitor, 'grok', {
        ok: true,
        message: 'Grok 已基于抓取内容完成总结',
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_fetch'
      });
    } catch (error) {
      attempts.push({
        provider: 'grok',
        status: isNotConfiguredError(error) ? 'paused' : 'down',
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, 'grok', {
        status: isNotConfiguredError(error) ? 'paused' : 'down',
        message: error instanceof Error ? error.message : String(error),
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_fetch'
      });
    }
  }

  return {
    ok: true,
    mode: 'url',
    url: targetUrl,
    provider,
    attempts,
    providers: providerMap(attempts),
    pipeline,
    answer,
    content,
    preview: content.slice(0, 2000)
  };
}

export async function executeSmartResearch({
  config,
  input,
  question = '',
  limit,
  deep,
  summarize,
  strategy,
  timeoutMs = 60_000,
  monitor
}) {
  const normalizedInput = String(input || question || '').trim();
  if (!normalizedInput) {
    throw new Error('smart_research 需要关键词、问题或 URL');
  }

  // 档位预设：未指定 strategy 时保持现状默认（limit=5, deep=false, summarize=true）。
  // 指定 strategy 时，显式入参优先，其次档位预设，最后内置默认。
  const resolvedStrategy = strategy ? resolveSmartStrategy(strategy) : null;
  const effectiveLimit = limit ?? resolvedStrategy?.limit ?? 5;
  const effectiveDeep = deep ?? resolvedStrategy?.deep ?? false;
  const effectiveSummarize = summarize ?? resolvedStrategy?.summarize ?? true;
  const strategyOverrides = resolvedStrategy?.searchOverrides || {};

  const url = normalizeUrl(normalizedInput);
  if (url) {
    return executeSmartFetch({
      config,
      url,
      question,
      summarize: effectiveSummarize || Boolean(question.trim()),
      timeoutMs,
      monitor
    });
  }

  const query = resolveQuery(normalizedInput);
  const attempts = [];
  const evidence = [];
  const evidenceBlocks = [];
  const sourceGroups = [];

  const run = async (providerId, label, fn) => {
    const startedAt = Date.now();
    try {
      const value = await fn();
      attempts.push({
        provider: providerId,
        status: 'up',
        message: `${label} 成功`,
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, providerId, {
        ok: true,
        message: `${label} 成功`,
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_research'
      });
      return { ok: true, value };
    } catch (error) {
      const status = isNotConfiguredError(error) ? 'paused' : 'down';
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        provider: providerId,
        status,
        message,
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, providerId, {
        status,
        message,
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_research'
      });
      return { ok: false, error: message };
    }
  };

  const [libre, search2api, tavily] = await Promise.all([
    run('libresearch', 'LibreSearch 搜索', async () => {
      const { payload, params } = await executeSearch({
        endpoint: config.searchEndpoint,
        defaultParams: config.defaultParams,
        query,
        // strategyOverrides 的 categories/time_range 会覆盖默认值并真正进入 LibreSearch/SearXNG 查询串。
        overrides: {
          pageno: '1',
          categories: config.defaultParams?.categories || 'general',
          ...strategyOverrides
        }
      });
      return { payload, params };
    }),
    run('search2api', 'Search-2api 答案', () => callSearch2Api(config, { prompt: query, timeoutMs: Math.min(timeoutMs, 90_000) })),
    run('tavily', 'Tavily Search', () => executeTavilySearchOnly({ config, query, maxResults: effectiveLimit }))
  ]);

  if (libre.ok) {
    const content = buildSummaryLines({ query, params: libre.value.params, payload: libre.value.payload }).join('\n');
    evidence.push(content);
    evidenceBlocks.push({ provider: 'libresearch', title: 'LibreSearch structured results', content });
    sourceGroups.push(getLibreResultItems(libre.value.payload, effectiveLimit).map((item) => ({ ...item, provider: 'libresearch' })));
  } else {
    const content = `## LibreSearch\n失败: ${libre.error}`;
    evidence.push(content);
    evidenceBlocks.push({ provider: 'libresearch', title: 'LibreSearch error', content });
  }

  if (search2api.ok) {
    const content = `## Search-2api\n模型: ${search2api.value.model}\n模式: ${search2api.value.mode}\n\n${search2api.value.content}`;
    evidence.push(content);
    evidenceBlocks.push({ provider: 'search2api', title: 'Search-2api answer', content });
  } else {
    const content = `## Search-2api\n失败: ${search2api.error}`;
    evidence.push(content);
    evidenceBlocks.push({ provider: 'search2api', title: 'Search-2api error', content });
  }

  if (tavily.ok) {
    const results = tavily.value.results || [];
    const content = formatSourceEvidence('Tavily', results, effectiveLimit);
    evidence.push(content);
    evidenceBlocks.push({ provider: 'tavily', title: 'Tavily search results', content });
    sourceGroups.push(results);
  } else {
    const content = `## Tavily\n失败: ${tavily.error}`;
    evidence.push(content);
    evidenceBlocks.push({ provider: 'tavily', title: 'Tavily error', content });
  }

  let sources = mergeSources(...sourceGroups).slice(0, Math.max(effectiveLimit, 1) * 2);
  const fetched = [];
  if (effectiveDeep) {
    for (const source of sources.filter((item) => item.url).slice(0, 2)) {
      const fetchedResult = await executeSmartFetch({
        config,
        url: source.url,
        summarize: false,
        timeoutMs: Math.min(timeoutMs, 45_000),
        monitor
      });
      fetched.push({
        title: source.title,
        url: source.url,
        ok: fetchedResult.ok,
        provider: fetchedResult.provider,
        preview: fetchedResult.preview || fetchedResult.error,
        content: fetchedResult.content || ''
      });
      if (fetchedResult.ok) {
        const content = `## 抓取正文: ${source.title || source.url}\nURL: ${source.url}\nProvider: ${fetchedResult.provider}\n\n${fetchedResult.content.slice(0, 3000)}`;
        evidence.push(content);
        evidenceBlocks.push({ provider: fetchedResult.provider || 'fetch', title: source.title || source.url, url: source.url, content });
      }
    }
  }

  const anyEvidence = attempts.some((item) => item.status === 'up');
  let pipeline = buildEvidencePipeline({
    query,
    sources,
    evidenceBlocks,
    fetched,
    attempts,
    limit: Math.max(effectiveLimit, 1) * 2
  });

  // P2: gap-fill 补搜 —— 首轮交叉验证置信度为 low/medium 时, 追加 1 轮 LibreSearch
  // (换 categories + time_range, 触达不同信源), 合并后重算 crossCheck。仅 1 轮, 控成本/延迟。
  // 仅当首轮 LibreSearch 本就可用时才补 (否则同端点必然再失败, 是无谓调用)。
  let gapFill = null;
  if (anyEvidence && libre.ok && (pipeline.crossCheck.confidence === 'low' || pipeline.crossCheck.confidence === 'medium')) {
    const confidenceBefore = pipeline.crossCheck.confidence;
    // 按查询意图选补搜类目, 别再无脑翻去 news 把无关时事拖进来抬高置信度。
    const intent = inferQueryIntent(query);
    const altCategories = intent === 'it'
      ? 'it'
      : intent === 'news'
        ? 'news'
        : (config.defaultParams?.categories || 'general');
    const gapOverrides = { pageno: '1', categories: altCategories };
    // 只有时效性查询才套时间窗; 静态技术/知识问题不加 time_range。
    if (intent === 'news') gapOverrides.time_range = 'week';
    const supplementary = await run('libresearch', `LibreSearch 补搜 (gap-fill ${altCategories})`, async () => {
      const { payload, params } = await executeSearch({
        endpoint: config.searchEndpoint,
        defaultParams: config.defaultParams,
        query,
        overrides: gapOverrides
      });
      return { payload, params };
    });
    if (supplementary.ok) {
      const supItems = getLibreResultItems(supplementary.value.payload, effectiveLimit)
        .map((item) => ({ ...item, provider: 'libresearch' }));
      const content = buildSummaryLines({ query, params: supplementary.value.params, payload: supplementary.value.payload }).join('\n');
      evidence.push(content);
      evidenceBlocks.push({ provider: 'libresearch', title: `LibreSearch gap-fill (${altCategories})`, content });
      sourceGroups.push(supItems);
      // 补搜结果与首轮信源合并 —— 与 tavily/search2api 命中的同 URL 会因此获得 ≥2 独立源佐证。
      sources = mergeSources(...sourceGroups).slice(0, Math.max(effectiveLimit, 1) * 2);
      pipeline = buildEvidencePipeline({
        query,
        sources,
        evidenceBlocks,
        fetched,
        attempts,
        limit: Math.max(effectiveLimit, 1) * 2
      });
    }
    gapFill = {
      ran: true,
      ok: supplementary.ok,
      categories: altCategories,
      confidenceBefore,
      confidenceAfter: pipeline.crossCheck.confidence
    };
  }

  let answer = '';
  if (effectiveSummarize && anyEvidence) {
    const startedAt = Date.now();
    try {
      const result = await executeGrokWebSearch({
        config,
        query: buildResearchSynthesisPrompt(pipeline),
        extraSources: 0,
        timeoutMs: Math.min(timeoutMs, GROK_SUMMARY_TIMEOUT_MS)
      });
      answer = result.content;
      sourceGroups.push(result.sources);
      attempts.push({
        provider: 'grok',
        status: 'up',
        message: 'Grok 汇总成功',
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, 'grok', {
        ok: true,
        message: 'Grok 汇总成功',
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_research'
      });
    } catch (error) {
      const status = isNotConfiguredError(error) ? 'paused' : 'down';
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        provider: 'grok',
        status,
        message,
        responseTimeMs: Date.now() - startedAt
      });
      recordMonitor(monitor, 'grok', {
        status,
        message,
        responseTimeMs: Date.now() - startedAt,
        source: 'smart_research'
      });
    }
  }

  return {
    ok: anyEvidence,
    mode: 'keyword',
    strategy: resolvedStrategy?.id ?? 'fast',
    summarize: effectiveSummarize,
    query,
    attempts,
    providers: providerMap(attempts),
    pipeline,
    gapFill,
    answer,
    evidence,
    sources: mergeSources(...sourceGroups, pipeline.items).slice(0, 20),
    fetched
  };
}

export function formatSmartFetchResult(result) {
  const lines = [
    `# Smart Fetch`,
    `URL: ${result.url}`,
    `状态: ${result.ok ? 'ok' : 'failed'}`,
    `Provider: ${result.provider || 'none'}`,
    '',
    '## Provider 状态',
    ...formatAttempts(result.attempts)
  ];
  if (result.answer) {
    lines.push('', '## 总结', result.answer);
  }
  if (result.pipeline) {
    lines.push('', formatEvidencePipeline(result.pipeline));
  }
  if (result.content) {
    lines.push('', '## 内容', result.content);
  }
  if (result.error) {
    lines.push('', `错误: ${result.error}`);
  }
  return lines.join('\n');
}

export function formatSmartResearchResult(result) {
  const title = result.mode === 'url' ? 'Smart Research URL' : 'Smart Research';
  const lines = [
    `# ${title}`,
    result.query ? `查询: ${result.query}` : `URL: ${result.url}`,
    `状态: ${result.ok ? 'ok' : 'failed'}`,
    '',
    '## Provider 状态',
    ...formatAttempts(result.attempts)
  ];
  if (result.gapFill?.ran) {
    lines.push(
      '',
      '## 补搜 (gap-fill)',
      `- 触发: 首轮置信度 ${result.gapFill.confidenceBefore}; 补搜类目: ${result.gapFill.categories}; 结果: ${result.gapFill.ok ? '成功' : '失败'}`,
      `- 置信度变化: ${result.gapFill.confidenceBefore} → ${result.gapFill.confidenceAfter}`
    );
  }
  if (result.answer) {
    lines.push('', '## 汇总答案', result.answer);
  } else if (result.summarize === false) {
    lines.push('', '## 汇总答案', '汇总已按请求关闭 (summarization: disabled)，以下为已取得证据。');
  } else if (result.mode === 'keyword') {
    const grokAttempt = (result.attempts || []).find((attempt) => attempt.provider === 'grok');
    const reason = grokAttempt
      ? `Grok 汇总失败（${grokAttempt.message || '未知错误'}）`
      : 'Grok 未返回汇总';
    lines.push('', '## 汇总答案', `${reason}，以下为已取得证据。`);
  }
  if (result.pipeline) {
    lines.push('', formatEvidencePipeline(result.pipeline));
  }
  if (result.evidence?.length) {
    lines.push('', '## 证据', result.evidence.join('\n\n---\n\n'));
  }
  if (result.sources?.length) {
    lines.push('', '## 信源');
    result.sources.slice(0, 20).forEach((source, index) => {
      lines.push(`- (${index + 1}) ${source.title || source.url}`);
      if (source.url) lines.push(`  URL: ${source.url}`);
      if (source.provider) lines.push(`  Provider: ${source.provider}`);
      if (source.description) lines.push(`  摘要: ${source.description}`);
    });
  }
  if (result.content) {
    lines.push('', '## 内容', result.content);
  }
  return lines.join('\n');
}

async function callSearch2Api(config, { prompt, model = 'search-sh-ai', timeoutMs = DEFAULT_TIMEOUT_MS, stream = true }) {
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

async function fetchHtmlText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'User-Agent': 'fusionsearch-mcp/1.0'
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTML Fetch 响应 ${response.status} ${response.statusText}`);
    }
    return {
      provider: 'html-fetch',
      content: stripHtml(text).slice(0, 80_000)
    };
  } finally {
    clearTimeout(timer);
  }
}

function getLibreResultItems(payload, limit = 5) {
  return Array.isArray(payload?.results)
    ? payload.results.slice(0, limit).map((item, index) => ({
        title: item?.title || `结果 ${index + 1}`,
        url: item?.url || item?.href || item?.link || '',
        description: typeof (item?.content ?? item?.snippet) === 'string'
          ? (item.content ?? item.snippet).replace(/\s+/g, ' ').trim()
          : '',
        provider: 'libresearch'
      }))
    : [];
}

function formatSourceEvidence(label, sources, limit) {
  const lines = [`## ${label}`];
  if (!sources.length) {
    lines.push('未返回结果。');
    return lines.join('\n');
  }
  sources.slice(0, limit).forEach((item, index) => {
    lines.push(`- (${index + 1}) ${item.title || item.url || '结果'}`);
    if (item.url) lines.push(`  链接: ${item.url}`);
    if (item.description) lines.push(`  摘要: ${item.description}`);
  });
  return lines.join('\n');
}

function buildResearchPrompt({ query, evidence }) {
  return [
    `User question: ${query}`,
    '',
    'Use the following FusionSearch evidence. Cross-check claims, identify weak evidence, and answer in Chinese unless the user asked otherwise.',
    evidence.join('\n\n---\n\n')
  ].join('\n');
}

function buildUrlSummaryPrompt({ url, question, content }) {
  return [
    `URL: ${url}`,
    question ? `User question: ${question}` : 'Task: Summarize the page and extract key facts.',
    '',
    'Use only this fetched content unless clearly stating that more evidence is needed.',
    content.slice(0, MAX_CONTENT_FOR_GROK)
  ].join('\n');
}

// 按查询意图粗分类目: 技术/文档(it) · 时效/新闻(news) · 通用(general)。
// 供 gap-fill 补搜选类目用——静态技术问题不该被拖去 news 堆里捞无关时事。
function inferQueryIntent(query = '') {
  const q = String(query || '').toLowerCase();
  if (/\b(http|https|api|rfc|sdk|cli|npm|pip|regex|sql|json|yaml|docker|kubernetes|linux|python|javascript|typescript|golang|rust|compiler|error|exception|stack\s?trace|status\s?code)\b/u.test(q)
      || /协议|标准|规范|文档|报错|异常|函数|方法|接口|参数|配置|编译|源码|算法/u.test(query)) {
    return 'it';
  }
  if (/\b(news|today|tonight|latest|breaking|release|price|stock|market)\b/u.test(q)
      || /最新|今天|今日|近期|昨天|本周|新闻|发布|上市|价格|行情|股价|排行|排名/u.test(query)) {
    return 'news';
  }
  return 'general';
}

function normalizeUrl(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : /^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/iu.test(trimmed) ? `https://${trimmed}` : '';
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
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

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

function providerMap(attempts) {
  return Object.fromEntries(
    attempts.map((attempt) => [
      attempt.provider,
      {
        status: attempt.status,
        message: attempt.message,
        responseTimeMs: attempt.responseTimeMs
      }
    ])
  );
}

function formatAttempts(attempts = []) {
  if (!attempts.length) return ['- 无 provider 尝试记录'];
  return attempts.map((attempt) => [
    `- ${attempt.provider}: ${attempt.status}`,
    attempt.responseTimeMs != null ? ` (${attempt.responseTimeMs}ms)` : '',
    attempt.message ? ` - ${attempt.message}` : ''
  ].join(''));
}

function isNotConfiguredError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /未配置|not configured|已关闭|disabled|missing key|missing token/iu.test(message);
}

function recordMonitor(monitor, providerId, event) {
  if (!monitor?.record) return;
  const serviceId = providerId === 'html_fetch' || providerId === 'html-fetch' ? null : providerId;
  if (!serviceId) return;
  monitor.record(serviceId, event);
}
