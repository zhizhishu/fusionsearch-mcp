import { randomUUID } from 'node:crypto';

export function newSessionId() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

export class SourceCache {
  constructor(maxSize = 256) {
    this.maxSize = maxSize;
    this.items = new Map();
  }

  set(sessionId, sources) {
    if (this.items.has(sessionId)) {
      this.items.delete(sessionId);
    }
    this.items.set(sessionId, Array.isArray(sources) ? sources : []);
    while (this.items.size > this.maxSize) {
      const oldest = this.items.keys().next().value;
      this.items.delete(oldest);
    }
  }

  get(sessionId) {
    if (!this.items.has(sessionId)) return null;
    const sources = this.items.get(sessionId);
    this.items.delete(sessionId);
    this.items.set(sessionId, sources);
    return sources;
  }
}

export function mergeSources(...sourceLists) {
  const seen = new Set();
  const merged = [];
  for (const sources of sourceLists) {
    for (const item of sources ?? []) {
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push({ ...item, url });
    }
  }
  return merged;
}

export function extractSourcesFromText(text) {
  const sources = [];
  const seen = new Set();
  const raw = text || '';
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const urlPattern = /https?:\/\/[^\s)\]}>"']+/g;

  for (const match of raw.matchAll(markdownLinkPattern)) {
    const title = match[1]?.trim();
    const url = normalizeUrl(match[2]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push(title ? { title, url } : { url });
  }

  for (const match of raw.matchAll(urlPattern)) {
    const url = normalizeUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url });
  }

  return sources;
}

export function splitAnswerAndSources(text) {
  const raw = (text || '').trim();
  if (!raw) return { answer: '', sources: [] };

  const headingPattern =
    /(^|\n)\s*(#{1,6}\s*)?(\*\*)?\s*(sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)\s*(\*\*)?\s*[:：]?\s*(\n|$)/i;
  const match = raw.match(headingPattern);
  if (match?.index != null) {
    const answer = raw.slice(0, match.index).trim();
    const tail = raw.slice(match.index).trim();
    const sources = extractSourcesFromText(tail);
    if (sources.length > 0) {
      return { answer, sources };
    }
  }

  const sources = extractSourcesFromText(raw);
  return { answer: raw, sources };
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/[.,;:!?，。；：！？]+$/u, '');
}
