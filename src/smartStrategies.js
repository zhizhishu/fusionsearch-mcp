export const SMART_STRATEGIES = {
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Light multi-provider search with no deep page fetch by default.',
    limit: 5,
    deep: false,
    summarize: true,
    searchOverrides: {}
  },
  deep: {
    id: 'deep',
    label: 'Deep',
    description: 'Search multiple providers and fetch top candidate pages before synthesis.',
    limit: 8,
    deep: true,
    summarize: true,
    searchOverrides: {}
  },
  url_fetch: {
    id: 'url_fetch',
    label: 'URL Fetch',
    description: 'Prefer URL extraction and fallback fetch chain.',
    limit: 5,
    deep: false,
    summarize: true,
    searchOverrides: {}
  },
  news_time: {
    id: 'news_time',
    label: 'News/Time',
    description: 'Bias LibreSearch toward news and recent results.',
    limit: 6,
    deep: false,
    summarize: true,
    searchOverrides: {
      categories: 'news',
      time_range: 'week'
    }
  },
  it_docs: {
    id: 'it_docs',
    label: 'IT/Docs',
    description: 'Bias LibreSearch toward technical and documentation results.',
    limit: 6,
    deep: true,
    summarize: true,
    searchOverrides: {
      categories: 'it'
    }
  }
};

export const SMART_STRATEGY_IDS = Object.keys(SMART_STRATEGIES);

export function resolveSmartStrategy(strategy = 'fast') {
  const id = String(strategy || 'fast').trim();
  return SMART_STRATEGIES[id] || SMART_STRATEGIES.fast;
}
