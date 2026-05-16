import { randomUUID } from 'crypto';

export function resolveQuery(rawQuery) {
  const query = (rawQuery ?? '').toString().trim();
  return query || `random uuid ${randomUUID()}`;
}

export function buildSearchParams(defaultParams, overrides = {}) {
  const params = new URLSearchParams({ ...defaultParams });

  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) continue;
    params.set(key, value.toString());
  }

  return params;
}

function buildUnexpectedContentError({ endpoint, contentType, body }) {
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 800);
  let message = `搜索 API 未返回 JSON，实际 Content-Type: ${contentType || 'unknown'}`;

  if (body.includes('Preparing Space')) {
    message = 'Hugging Face LibreSearch Space 正在冷启动或准备中，请稍后重试';
  } else if (body.includes('This Space has been paused') || body.includes('Restart this Space')) {
    message = 'Hugging Face LibreSearch Space 当前已暂停，请先在 Hugging Face 页面重启 Space';
  } else if (body.includes('Hugging Face') && body.includes('Space')) {
    message = 'Hugging Face LibreSearch Space 当前未返回搜索 JSON，可能处于暂停、冷启动或代理页面状态';
  } else if (/format.*json.*not.*supported/i.test(body) || /invalid.*format/i.test(body)) {
    message = 'LibreSearch/SearXNG 当前未启用 JSON 输出，请开启 search.formats 中的 json';
  }

  const error = new Error(message);
  error.endpoint = endpoint;
  error.contentType = contentType;
  error.body = preview;
  return error;
}

export async function executeSearch({ endpoint, defaultParams, query, overrides = {}, signal }) {
  const searchParams = buildSearchParams(defaultParams, { ...overrides, q: query });
  const requestUrl = `${endpoint}?${searchParams.toString()}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'fusionsearch-mcp/1.0'
      }
    });
  } catch (fetchError) {
    const error = new Error('搜索 API 请求失败，可能是网络或目标服务暂时不可用');
    error.cause = fetchError;
    throw error;
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Search API responded with ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body.slice(0, 1200);
    throw error;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!contentType.toLowerCase().includes('json')) {
    throw buildUnexpectedContentError({ endpoint: requestUrl, contentType, body });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (parseError) {
    const error = new Error('搜索 API 返回内容不是合法 JSON');
    error.cause = parseError;
    error.body = body.slice(0, 1200);
    throw error;
  }

  return {
    payload,
    params: Object.fromEntries(searchParams.entries())
  };
}

export function buildSummaryLines({ query, params, payload }) {
  const lines = [];
  lines.push(`# 搜索词: ${query}`);
  lines.push(`API 参数: ${JSON.stringify(params)}`);

  const answers = Array.isArray(payload?.answers) ? payload.answers : [];
  if (answers.length > 0) {
    lines.push('\n## 直接答案');
    answers.forEach((item, index) => {
      const answerText = typeof item?.answer === 'string' ? item.answer : '';
      lines.push(`- (${index + 1}) ${answerText}`.trim());
      if (item?.url) {
        lines.push(`  链接: ${item.url}`);
      }
    });
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length > 0) {
    lines.push('\n## 站点结果 (前 5 条)');
    results.slice(0, 5).forEach((item, index) => {
      const title = item?.title || `结果 ${index + 1}`;
      const snippetSource = item?.content ?? item?.snippet ?? '';
      const snippet = typeof snippetSource === 'string' ? snippetSource.replace(/\s+/g, ' ').trim() : '';
      const url = item?.url || item?.href || item?.link;
      lines.push(`- ${title}`);
      if (snippet) {
        lines.push(`  摘要: ${snippet}`);
      }
      if (url) {
        lines.push(`  链接: ${url}`);
      }
    });
  } else {
    lines.push('\n未找到站点结果。');
  }

  const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
  if (suggestions.length > 0) {
    lines.push('\n## 相关搜索');
    suggestions.forEach((item) => {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else if (item?.phrase) {
        lines.push(`- ${item.phrase}`);
      }
    });
  }

  const unresponsive = Array.isArray(payload?.unresponsive_engines)
    ? payload.unresponsive_engines
    : [];
  if (unresponsive.length > 0) {
    lines.push('\n## 未响应引擎');
    unresponsive.forEach((row) => {
      if (Array.isArray(row) && row.length >= 2) {
        lines.push(`- ${row[0]}: ${row[1]}`);
      }
    });
  }

  return lines;
}
