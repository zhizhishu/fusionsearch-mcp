const MAX_DESCRIPTION_LENGTH = 900;
const MAX_CONTENT_LENGTH = 3000;
const TITLE_SIMILARITY_THRESHOLD = 0.86;

export function normalizeEvidenceItems(provider, rawItems = [], options = {}) {
  const sourceProvider = String(provider || options.provider || 'unknown').trim() || 'unknown';
  const items = Array.isArray(rawItems) ? rawItems : [rawItems].filter(Boolean);

  return items
    .map((item, index) => normalizeEvidenceItem(sourceProvider, item, index, options))
    .filter((item) => item.title || item.url || item.description || item.content);
}

export function buildEvidencePipeline({
  query = '',
  sources = [],
  evidenceBlocks = [],
  fetched = [],
  attempts = [],
  limit = 10
} = {}) {
  const normalizedSources = normalizeEvidenceItems('source', sources);
  const normalizedFetched = normalizeEvidenceItems(
    'fetch',
    fetched.map((item) => ({
      ...item,
      content: item.content || item.preview,
      fetched: true
    }))
  );
  const normalizedBlocks = normalizeEvidenceItems(
    'evidence',
    evidenceBlocks.map((block, index) => ({
      title: block.title || block.provider || `Evidence ${index + 1}`,
      provider: block.provider || 'evidence',
      content: block.content || block.text || String(block || ''),
      description: block.description || ''
    }))
  );

  const merged = mergeEvidenceItems([...normalizedSources, ...normalizedFetched, ...normalizedBlocks])
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
  const crossCheck = buildCrossCheck({ items: merged, attempts });

  return {
    query: String(query || '').trim(),
    items: merged,
    evidenceBlocks,
    fetched,
    attempts,
    crossCheck,
    confidence: crossCheck.confidence
  };
}

export function buildResearchSynthesisPrompt(pipeline) {
  const evidenceLines = pipeline.items.slice(0, 12).map((item, index) => [
    `Evidence ${index + 1}`,
    `Title: ${item.title || 'Untitled'}`,
    item.url ? `URL: ${item.url}` : '',
    `Providers: ${item.matchedProviders.join(', ')}`,
    `Score: ${item.score.toFixed(2)}`,
    item.description ? `Summary: ${item.description.slice(0, MAX_DESCRIPTION_LENGTH)}` : '',
    item.content ? `Content excerpt: ${item.content.slice(0, MAX_CONTENT_LENGTH)}` : ''
  ].filter(Boolean).join('\n'));

  return [
    `User question: ${pipeline.query}`,
    '',
    'You are FusionSearch Orchestrator. Answer in Chinese unless the user asks otherwise.',
    'Use only the evidence below. Cross-check important factual claims across independent providers.',
    'State confidence as High, Medium, or Low. If evidence conflicts or is single-source, say so explicitly.',
    '',
    'Provider status:',
    formatAttemptSummary(pipeline.attempts),
    '',
    `Cross-check confidence: ${pipeline.crossCheck.confidence}`,
    `Cross-check reasons: ${pipeline.crossCheck.reasons.join('; ') || 'No specific reason'}`,
    '',
    'Per-evidence corroboration (top ranked, independent source support):',
    formatTopCorroboration(pipeline.crossCheck.topCorroboration),
    pipeline.crossCheck.singleSourceTopCount
      ? `单源警告: top ${pipeline.crossCheck.topCorroboration.length} 条证据中有 ${pipeline.crossCheck.singleSourceTopCount} 条仅单源支持，下结论时请注明独立佐证不足。`
      : '',
    '',
    'Ranked evidence:',
    evidenceLines.join('\n\n---\n\n') || 'No normalized evidence.',
    '',
    'Raw evidence blocks:',
    formatRawEvidenceBlocks(pipeline.evidenceBlocks)
  ].join('\n');
}

export function buildFetchSynthesisPrompt({ url, question = '', content = '', attempts = [] } = {}) {
  return [
    `URL: ${url}`,
    question ? `User question: ${question}` : 'Task: Summarize the page and extract key facts.',
    '',
    'You are FusionSearch Orchestrator. Answer in Chinese unless the user asks otherwise.',
    'Use only the fetched content below. If the content is insufficient, say what is missing.',
    '',
    'Provider status:',
    formatAttemptSummary(attempts),
    '',
    'Fetched content:',
    String(content || '').slice(0, 12_000)
  ].join('\n');
}

export function formatEvidencePipeline(pipeline) {
  const lines = [
    '# Fusion Orchestrator Evidence Pipeline',
    pipeline.query ? `查询: ${pipeline.query}` : '',
    `置信度: ${pipeline.crossCheck.confidence}`,
    `证据数量: ${pipeline.items.length}`,
    '',
    '## Provider 覆盖',
    ...pipeline.crossCheck.providerCoverage.map((item) => (
      `- ${item.provider}: ${item.status}; evidence=${item.evidenceCount}; ${item.message || 'ok'}`
    )),
    '',
    '## 交叉验证',
    ...pipeline.crossCheck.reasons.map((reason) => `- ${reason}`),
    ...(pipeline.crossCheck.topCorroboration?.length
      ? [
          '',
          '## 逐条佐证 (前 5 条)',
          ...pipeline.crossCheck.topCorroboration.map((item, index) => (
            `- [${index + 1}] ${item.title} — 佐证: ${item.providerCount} 源 (${item.providers.join(', ') || '未知'})`
          ))
        ]
      : []),
    '',
    '## 排序证据'
  ].filter(Boolean);

  pipeline.items.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${item.title || item.url || 'Untitled evidence'}`,
      item.url ? `URL: ${item.url}` : '',
      `Provider: ${item.matchedProviders.join(', ')}`,
      `Score: ${item.score.toFixed(2)}`,
      item.description ? `摘要: ${item.description}` : '',
      item.content ? `内容片段: ${item.content.slice(0, 900)}` : ''
    );
  });

  return lines.filter(Boolean).join('\n');
}

function normalizeEvidenceItem(provider, item, index, options) {
  const rawProvider = item?.provider || provider;
  const title = cleanText(item?.title || item?.name || item?.heading || '');
  const url = cleanUrl(item?.url || item?.href || item?.link || '');
  const description = cleanText(
    item?.description || item?.contentSnippet || item?.snippet || item?.summary || item?.content || ''
  ).slice(0, MAX_DESCRIPTION_LENGTH);
  const content = cleanText(item?.content || item?.text || '').slice(0, MAX_CONTENT_LENGTH);
  const fetched = Boolean(options.fetched || item?.fetched || item?.provider === 'fetch');
  const normalizedUrl = normalizeUrlKey(url);
  const idSeed = normalizedUrl || normalizeTitleKey(title) || `${rawProvider}-${index}`;
  const signals = {
    hasUrl: Boolean(url),
    hasTitle: Boolean(title),
    hasDescription: Boolean(description),
    hasContent: Boolean(content),
    fetched
  };

  return {
    id: `${rawProvider}:${idSeed}`,
    provider: String(rawProvider || provider),
    title,
    url,
    normalizedUrl,
    description,
    content,
    score: scoreEvidence({ signals, matchedProviders: [String(rawProvider || provider)] }),
    signals,
    matchedProviders: [String(rawProvider || provider)]
  };
}

function mergeEvidenceItems(items) {
  const merged = [];

  for (const item of items) {
    const existing = findDuplicate(merged, item);
    if (!existing) {
      merged.push({ ...item, matchedProviders: Array.from(new Set(item.matchedProviders)) });
      continue;
    }
    mergeInto(existing, item);
  }

  return merged.map((item) => ({
    ...item,
    score: scoreEvidence(item)
  }));
}

function findDuplicate(items, item) {
  if (item.normalizedUrl) {
    const byUrl = items.find((candidate) => candidate.normalizedUrl && candidate.normalizedUrl === item.normalizedUrl);
    if (byUrl) return byUrl;
  }
  if (!item.title) return null;
  return items.find((candidate) => (
    !candidate.normalizedUrl &&
    candidate.title &&
    titleSimilarity(candidate.title, item.title) >= TITLE_SIMILARITY_THRESHOLD
  ));
}

function mergeInto(target, item) {
  target.matchedProviders = Array.from(new Set([...target.matchedProviders, ...item.matchedProviders]));
  if (!target.title && item.title) target.title = item.title;
  if (!target.url && item.url) target.url = item.url;
  if (!target.normalizedUrl && item.normalizedUrl) target.normalizedUrl = item.normalizedUrl;
  if (item.description.length > target.description.length) target.description = item.description;
  if (item.content.length > target.content.length) target.content = item.content;
  target.signals = {
    hasUrl: target.signals.hasUrl || item.signals.hasUrl,
    hasTitle: target.signals.hasTitle || item.signals.hasTitle,
    hasDescription: target.signals.hasDescription || item.signals.hasDescription,
    hasContent: target.signals.hasContent || item.signals.hasContent,
    fetched: target.signals.fetched || item.signals.fetched,
    multiProvider: target.matchedProviders.length > 1
  };
}

export function buildCrossCheck({ items, attempts }) {
  const evidenceByProvider = new Map();
  for (const item of items) {
    for (const provider of item.matchedProviders) {
      evidenceByProvider.set(provider, (evidenceByProvider.get(provider) || 0) + 1);
    }
  }
  const attemptByProvider = new Map((attempts || []).map((attempt) => [attempt.provider, attempt]));
  const providers = Array.from(new Set([...evidenceByProvider.keys(), ...attemptByProvider.keys()]));
  const providerCoverage = providers.map((provider) => {
    const attempt = attemptByProvider.get(provider);
    return {
      provider,
      status: attempt?.status || (evidenceByProvider.has(provider) ? 'up' : 'unknown'),
      message: attempt?.message || '',
      evidenceCount: evidenceByProvider.get(provider) || 0
    };
  });

  const upProviderCount = providerCoverage.filter((item) => item.status === 'up' && item.evidenceCount > 0).length;
  const multiProviderEvidence = items.filter((item) => item.matchedProviders.length > 1).length;
  const fetchedEvidence = items.filter((item) => item.signals.fetched || item.signals.hasContent).length;

  // 逐条佐证：每条证据被多少个独立 provider 返回。corroboratedItems = 至少 2 源佐证的条数。
  const corroboratedItems = items.filter((item) => (item.matchedProviders?.length || 0) >= 2).length;

  // 逐源佐证明细：items 已按 score 降序排列，取排在前面的 top 5。
  const topCorroboration = items.slice(0, 5).map((item) => {
    const itemProviders = Array.from(new Set(item.matchedProviders || []));
    return {
      title: item.title || truncateLabel(item.url) || 'Untitled evidence',
      providerCount: itemProviders.length,
      providers: itemProviders
    };
  });
  const singleSourceTopCount = topCorroboration.filter((item) => item.providerCount <= 1).length;
  const topIsSingleSource = Boolean(topCorroboration[0]) && topCorroboration[0].providerCount <= 1;

  const reasons = [
    `${upProviderCount} 个 provider 返回可用证据`,
    `${multiProviderEvidence} 条证据获得多 provider 支持`,
    `${corroboratedItems} 条证据获 ≥2 独立源佐证`,
    `${fetchedEvidence} 条证据包含正文或抓取内容`
  ];
  if (topIsSingleSource) {
    reasons.push('最佳信源仅单源支持，置信度受限');
  }

  // 置信度只认"独立佐证"，不认原始数量。
  // 关键: 早期版本有 `|| fetchedEvidence >= 2` 的松口子——只要抓到 2 篇正文(哪怕是
  // gap-fill 拖进来的无关新闻)就升 medium，导致"无关证据越多越自信"。现已移除:
  // 升 medium/high 必须有跨独立源真佐证(corroboratedItems = 同一条被 ≥2 provider 命中)，
  // fetchedEvidence 仅作展示、不再充当置信度杠杆。
  let confidence = 'low';
  if (upProviderCount >= 3 && corroboratedItems >= 2) {
    confidence = 'high';
  } else if (upProviderCount >= 2 && corroboratedItems >= 1) {
    confidence = 'medium';
  }
  if (!items.length) {
    reasons.push('没有可排序证据');
    confidence = 'low';
  }

  return {
    confidence,
    providerCoverage,
    reasons,
    multiProviderEvidence,
    fetchedEvidence,
    corroboratedItems,
    topCorroboration,
    singleSourceTopCount
  };
}

function scoreEvidence(item) {
  const providers = new Set(item.matchedProviders || [item.provider].filter(Boolean));
  const providerBonus = Math.max(0, providers.size - 1) * 1.4;
  const descriptionBonus = Math.min((item.description || '').length / 260, 1.2);
  const contentBonus = Math.min((item.content || '').length / 900, 1.8);
  return 1 +
    providerBonus +
    (item.signals?.hasUrl ? 0.7 : 0) +
    (item.signals?.hasTitle ? 0.3 : 0) +
    descriptionBonus +
    contentBonus +
    (item.signals?.fetched ? 1.2 : 0);
}

function formatTopCorroboration(topCorroboration = []) {
  if (!topCorroboration.length) return '- No ranked evidence to corroborate.';
  return topCorroboration.map((item, index) => {
    const providers = item.providers?.length ? item.providers.join(', ') : 'unknown';
    return `- [${index + 1}] ${item.title} — 佐证: ${item.providerCount} 源 (${providers})`;
  }).join('\n');
}

function truncateLabel(value = '', max = 80) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatAttemptSummary(attempts = []) {
  if (!attempts.length) return '- No provider attempts recorded.';
  return attempts.map((attempt) => (
    `- ${attempt.provider}: ${attempt.status || 'unknown'}${attempt.message ? ` - ${attempt.message}` : ''}`
  )).join('\n');
}

function formatRawEvidenceBlocks(blocks = []) {
  if (!blocks.length) return 'No raw evidence blocks.';
  return blocks.map((block, index) => {
    const label = block.provider || block.title || `Evidence block ${index + 1}`;
    const content = block.content || block.text || String(block || '');
    return `## ${label}\n${String(content).slice(0, MAX_CONTENT_LENGTH)}`;
  }).join('\n\n---\n\n');
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function cleanUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function normalizeUrlKey(value = '') {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return `${url.hostname.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return '';
  }
}

function normalizeTitleKey(value = '') {
  return cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80);
}

function titleSimilarity(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function tokenSet(value) {
  const normalized = cleanText(value).toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length > 1) return new Set(words);
  const compact = normalized.replace(/\s+/gu, '');
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return new Set(grams.length ? grams : [compact].filter(Boolean));
}
