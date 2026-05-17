const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const mainNavItems = $$('.rail-item[data-group]');
const subNavGroups = $$('.subnav-group[data-subnav-group]');
const subNavItems = $$('.subnav-item[data-subview]');
const viewPanels = $$('.view-panel[data-group-panel][data-view-panel]');
const workbench = $('.workbench');
const saveBar = $('.save-bar');
const defaultGrokSystemPrompt = [
  'You are FusionSearch MCP, a careful web research assistant.',
  'Tools and model-side analysis should operate in English when useful; final user-facing answers should be written in Chinese unless the user requests another language.',
  'Search results are evidence, not automatic truth. Cross-check important factual claims across independent sources whenever evidence is available.',
  'Prefer authoritative, recent, primary sources. State uncertainty, conflicts, scope limits, and confidence level when the evidence is incomplete.',
  'Use concise Markdown. Put direct conclusions first, then evidence and citations. Never fabricate citations.'
].join('\n');

const defaultSubviews = {
  sources: 'libresearch',
  fusion: 'grok',
  mcp: 'full',
  deploy: 'docker',
  security: 'admin',
  tests: 'search',
  status: 'runtime'
};

const legacyRoutes = {
  libresearch: ['sources', 'libresearch'],
  search2api: ['sources', 'search2api'],
  fusion: ['fusion', 'grok'],
  grok: ['fusion', 'grok'],
  prompt: ['fusion', 'prompt'],
  tavily: ['fusion', 'tavily'],
  firecrawl: ['fusion', 'firecrawl'],
  preview: ['tests', 'search'],
  runtime: ['status', 'runtime']
};

const fields = {
  searchEndpoint: $('#searchEndpoint'),
  searchShEndpoint: $('#searchShEndpoint'),
  searchShApiKey: $('#searchShApiKey'),
  clearSearchShApiKey: $('#clearSearchShApiKey'),
  search2apiProjectUrl: $('#search2apiProjectUrl'),
  search2apiBaseUrl: $('#search2apiBaseUrl'),
  search2apiUpstreamState: $('#search2apiUpstreamState'),
  search2apiRuntimeState: $('#search2apiRuntimeState'),
  search2apiStatusHint: $('#search2apiStatusHint'),
  gudaBaseUrl: $('#gudaBaseUrl'),
  gudaApiKey: $('#gudaApiKey'),
  clearGudaApiKey: $('#clearGudaApiKey'),
  grokApiUrl: $('#grokApiUrl'),
  grokApiKey: $('#grokApiKey'),
  clearGrokApiKey: $('#clearGrokApiKey'),
  grokModel: $('#grokModel'),
  grokSystemPrompt: $('#grokSystemPrompt'),
  resetGrokPrompt: $('#resetGrokPrompt'),
  tavilyEnabled: $('#tavilyEnabled'),
  tavilyApiUrl: $('#tavilyApiUrl'),
  tavilyApiKey: $('#tavilyApiKey'),
  clearTavilyApiKey: $('#clearTavilyApiKey'),
  firecrawlApiUrl: $('#firecrawlApiUrl'),
  firecrawlApiKey: $('#firecrawlApiKey'),
  clearFirecrawlApiKey: $('#clearFirecrawlApiKey'),
  categories: $('#categories'),
  language: $('#language'),
  safesearch: $('#safesearch'),
  timeRange: $('#timeRange'),
  testQuery: $('#testQuery'),
  testPrompt: $('#testPrompt'),
  testGrokQuery: $('#testGrokQuery'),
  testFetchUrl: $('#testFetchUrl'),
  testMapUrl: $('#testMapUrl'),
  output: $('#testOutput'),
  runtimeStatus: $('#runtimeStatus'),
  loginPanel: $('#loginPanel'),
  adminTokenInput: $('#adminTokenInput'),
  loginHint: $('#loginHint'),
  loginAdmin: $('#loginAdmin'),
  logoutAdmin: $('#logoutAdmin'),
  mcpEndpoint: $('#mcpEndpoint'),
  healthState: $('#healthState'),
  configPath: $('#configPath'),
  configPathMirror: $('#configPathMirror'),
  adminAuthState: $('#adminAuthState'),
  mcpAuthState: $('#mcpAuthState'),
  currentAdminToken: $('#currentAdminToken'),
  currentMcpAdminToken: $('#currentMcpAdminToken'),
  newAdminToken: $('#newAdminToken'),
  rotateSessionSecret: $('#rotateSessionSecret'),
  newMcpAuthToken: $('#newMcpAuthToken'),
  clearMcpAuthToken: $('#clearMcpAuthToken'),
  securityHint: $('#securityHint'),
  adminEnvState: $('#adminEnvState'),
  mcpEnvState: $('#mcpEnvState'),
  hfSpaceId: $('#hfSpaceId'),
  hfWriteState: $('#hfWriteState'),
  hfSecretCount: $('#hfSecretCount'),
  hfOneTimeToken: $('#hfOneTimeToken'),
  hfSecretFields: $('#hfSecretFields'),
  logFilePath: $('#logFilePath'),
  logCount: $('#logCount'),
  logLevel: $('#logLevel'),
  logScope: $('#logScope'),
  logLimit: $('#logLimit'),
  logViewer: $('#logViewer'),
  keyState: $('#keyState'),
  fusionKeyState: $('#fusionKeyState'),
  saveHint: $('#saveHint')
};

let hfSecretOptions = [];

function setStatus(text, kind = '') {
  fields.runtimeStatus.textContent = text;
  fields.runtimeStatus.className = `status-pill ${kind}`.trim();
}

function renderOutput(value) {
  if (!fields.output) return;
  fields.output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function formatFusionKeyState(fusion = {}) {
  const providers = [
    fusion.hasGrokApiKey ? 'Grok' : '',
    fusion.hasTavilyApiKey ? 'Tavily' : '',
    fusion.hasFirecrawlApiKey ? 'Firecrawl' : ''
  ].filter(Boolean);
  return providers.length ? `${providers.join(' / ')} 已配置` : '未配置';
}

function renderHfSecretFields(options = []) {
  if (!fields.hfSecretFields) return;
  hfSecretOptions = options;
  fields.hfSecretFields.innerHTML = options
    .map((option) => {
      const control = option.multiline
        ? `<textarea class="hf-secret-input" data-secret-key="${option.key}" data-secret-description="${option.label}" rows="4" spellcheck="false" placeholder="留空不修改"></textarea>`
        : `<input class="hf-secret-input" data-secret-key="${option.key}" data-secret-description="${option.label}" type="password" autocomplete="new-password" placeholder="留空不修改" />`;
      return `
        <label class="field hf-secret-field">
          <span>${option.key}</span>
          ${control}
          <small>${option.label || ''}</small>
        </label>
      `;
    })
    .join('');
}

function collectHfSecretUpdates() {
  return $$('.hf-secret-input')
    .map((input) => ({
      key: input.dataset.secretKey,
      value: input.value,
      description: input.dataset.secretDescription || ''
    }))
    .filter((item) => item.key && item.value.trim())
    .map((item) => ({ ...item, value: item.value.trim() }));
}

function clearHfSecretInputs() {
  $$('.hf-secret-input').forEach((input) => {
    input.value = '';
  });
}

function hasPanel(group, subview) {
  return viewPanels.some((panel) => panel.dataset.groupPanel === group && panel.dataset.viewPanel === subview);
}

function normalizeRoute(rawHash = '') {
  const hash = rawHash.replace(/^#/, '').trim();
  if (!hash) return ['sources', defaultSubviews.sources];
  if (legacyRoutes[hash]) return legacyRoutes[hash];

  const [requestedGroup, requestedSubview] = hash.split(':');
  const group = defaultSubviews[requestedGroup] ? requestedGroup : 'sources';
  const subview = requestedSubview || defaultSubviews[group];
  return hasPanel(group, subview) ? [group, subview] : [group, defaultSubviews[group]];
}

function setActiveRoute(group, subview, updateHash = true) {
  const [targetGroup, targetSubview] = hasPanel(group, subview)
    ? [group, subview]
    : ['sources', defaultSubviews.sources];

  mainNavItems.forEach((item) => {
    const active = item.dataset.group === targetGroup;
    item.classList.toggle('active', active);
    item.toggleAttribute('aria-current', active);
  });

  subNavGroups.forEach((navGroup) => {
    const active = navGroup.dataset.subnavGroup === targetGroup;
    navGroup.hidden = !active;
    navGroup.classList.toggle('active', active);
  });

  subNavItems.forEach((item) => {
    const groupElement = item.closest('.subnav-group');
    const active = groupElement?.dataset.subnavGroup === targetGroup && item.dataset.subview === targetSubview;
    item.classList.toggle('active', active);
    item.toggleAttribute('aria-current', active);
  });

  viewPanels.forEach((panel) => {
    const active = panel.dataset.groupPanel === targetGroup && panel.dataset.viewPanel === targetSubview;
    panel.hidden = !active;
    panel.classList.toggle('active-panel', active);
  });

  if (targetGroup === 'tests' && fields.output) {
    const activePanel = viewPanels.find((panel) => (
      panel.dataset.groupPanel === targetGroup && panel.dataset.viewPanel === targetSubview
    ));
    activePanel?.append(fields.output);
  }

  if (targetGroup === 'status' && targetSubview === 'logs') {
    void loadLogs().catch(() => {});
  }

  const nextHash = `#${targetGroup}:${targetSubview}`;
  if (updateHash && window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function requestJson(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function renderSession(session = {}) {
  const locked = Boolean(session.adminAuthEnabled && !session.adminAuthenticated);
  fields.loginPanel.hidden = !locked;
  workbench.hidden = locked;
  saveBar.hidden = locked;
  fields.logoutAdmin.hidden = !session.adminAuthEnabled || locked;
  if (fields.adminAuthState) {
    fields.adminAuthState.textContent = session.adminAuthEnabled ? (session.adminAuthenticated ? '已登录' : '需要登录') : '未启用';
  }
  if (fields.mcpAuthState) {
    fields.mcpAuthState.textContent = session.mcpAuthEnabled ? '已启用' : '未启用';
  }
  setStatus(locked ? '待登录' : '读取中', locked ? '' : '');
}

async function refreshSession() {
  const session = await requestJson('/api/admin/session');
  renderSession(session);
  return session;
}

async function loginAdmin() {
  const token = fields.adminTokenInput.value.trim();
  fields.loginHint.textContent = '登录中';
  const session = await requestJson('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  fields.adminTokenInput.value = '';
  fields.loginHint.textContent = '已登录';
  renderSession(session);
  await loadConfig();
  await checkRuntime();
}

async function logoutAdmin() {
  const session = await requestJson('/api/admin/logout', { method: 'POST' });
  renderSession(session);
}

async function loadConfig() {
  setStatus('读取中');
  const config = await requestJson('/api/admin/config');
  fields.searchEndpoint.value = config.searchEndpoint || '';
  fields.searchShEndpoint.value = config.searchShChatEndpoint || '';
  if (fields.search2apiProjectUrl) fields.search2apiProjectUrl.textContent = config.searchShProjectUrl || 'https://github.com/lza6/Search-2api';
  if (fields.search2apiBaseUrl) fields.search2apiBaseUrl.textContent = config.searchShBaseUrl || '未配置';
  fields.categories.value = config.defaultParams?.categories || 'general';
  fields.language.value = config.defaultParams?.language || 'auto';
  fields.safesearch.value = config.defaultParams?.safesearch || '0';
  fields.timeRange.value = config.defaultParams?.time_range || '';
  fields.configPath.textContent = config.runtimeConfigPath || 'memory';
  if (fields.configPathMirror) fields.configPathMirror.textContent = config.runtimeConfigPath || 'memory';
  fields.keyState.textContent = config.hasSearchShApiKey ? '已配置' : '未配置';
  fields.fusionKeyState.textContent = formatFusionKeyState(config.fusion);
  if (fields.hfSpaceId) fields.hfSpaceId.textContent = config.hfSecrets?.spaceId || '未配置';
  if (fields.hfWriteState) {
    fields.hfWriteState.textContent = config.hfSecrets?.canWrite ? 'HF_WRITE_TOKEN 已配置' : '需要 HF_WRITE_TOKEN 或一次性 Token';
  }
  if (fields.hfSecretCount) fields.hfSecretCount.textContent = '-';
  renderHfSecretFields(config.hfSecrets?.options || hfSecretOptions);
  if (fields.adminAuthState) {
    fields.adminAuthState.textContent = config.auth?.adminAuthEnabled ? '已启用' : '未启用';
  }
  if (fields.mcpAuthState) {
    fields.mcpAuthState.textContent = config.auth?.mcpAuthEnabled ? '已启用' : '未启用';
  }
  if (fields.adminEnvState) {
    fields.adminEnvState.textContent = config.envOverrides?.adminToken ? '环境变量已提供，可被运行配置覆盖' : '运行配置管理';
  }
  if (fields.mcpEnvState) {
    fields.mcpEnvState.textContent = config.envOverrides?.mcpAuthToken ? '环境变量已提供，可被运行配置覆盖' : '运行配置管理';
  }
  fields.gudaBaseUrl.value = config.fusion?.gudaBaseUrl || 'https://code.guda.studio';
  fields.grokApiUrl.value = config.fusion?.grokApiUrl || '';
  fields.grokModel.value = config.fusion?.grokModel || 'grok-4.20-beta';
  fields.grokSystemPrompt.value = config.fusion?.grokSystemPrompt || defaultGrokSystemPrompt;
  fields.tavilyEnabled.checked = config.fusion?.tavilyEnabled !== false;
  fields.tavilyApiUrl.value = config.fusion?.tavilyApiUrl || 'https://api.tavily.com';
  fields.firecrawlApiUrl.value = config.fusion?.firecrawlApiUrl || 'https://api.firecrawl.dev/v2';
  fields.searchShApiKey.value = '';
  fields.clearSearchShApiKey.checked = false;
  resetFusionSecrets();
  setStatus('已连接', 'ok');
}

async function saveConfig() {
  fields.saveHint.textContent = '保存中';
  const body = {
    searchEndpoint: fields.searchEndpoint.value.trim(),
    searchShChatEndpoint: fields.searchShEndpoint.value.trim(),
    searchShApiKey: fields.searchShApiKey.value,
    clearSearchShApiKey: fields.clearSearchShApiKey.checked,
    gudaBaseUrl: fields.gudaBaseUrl.value.trim(),
    gudaApiKey: fields.gudaApiKey.value,
    clearGudaApiKey: fields.clearGudaApiKey.checked,
    grokApiUrl: fields.grokApiUrl.value.trim(),
    grokApiKey: fields.grokApiKey.value,
    clearGrokApiKey: fields.clearGrokApiKey.checked,
    grokModel: fields.grokModel.value.trim() || 'grok-4.20-beta',
    grokSystemPrompt: fields.grokSystemPrompt.value.trim() || defaultGrokSystemPrompt,
    tavilyEnabled: fields.tavilyEnabled.checked,
    tavilyApiUrl: fields.tavilyApiUrl.value.trim(),
    tavilyApiKey: fields.tavilyApiKey.value,
    clearTavilyApiKey: fields.clearTavilyApiKey.checked,
    firecrawlApiUrl: fields.firecrawlApiUrl.value.trim(),
    firecrawlApiKey: fields.firecrawlApiKey.value,
    clearFirecrawlApiKey: fields.clearFirecrawlApiKey.checked,
    defaultParams: {
      categories: fields.categories.value,
      language: fields.language.value.trim() || 'auto',
      safesearch: fields.safesearch.value,
      time_range: fields.timeRange.value,
      format: 'json',
      pageno: '1'
    }
  };

  const config = await requestJson('/api/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  fields.keyState.textContent = config.hasSearchShApiKey ? '已配置' : '未配置';
  fields.fusionKeyState.textContent = formatFusionKeyState(config.fusion);
  fields.searchShApiKey.value = '';
  fields.clearSearchShApiKey.checked = false;
  resetFusionSecrets();
  fields.saveHint.textContent = '已保存';
  setStatus('已保存', 'ok');
}

async function checkRuntime() {
  const [status, health] = await Promise.all([
    requestJson('/status'),
    requestJson('/health')
  ]);
  fields.mcpEndpoint.textContent = status.mcpEndpoint || '/mcp';
  fields.healthState.textContent = health.status || '-';
  setStatus('运行中', 'ok');
}

async function loadHfSecrets() {
  renderOutput('读取 Hugging Face Secrets 状态中...');
  const payload = await requestJson('/api/admin/hf-secrets');
  renderHfSecretFields(payload.options || hfSecretOptions);
  if (fields.hfSpaceId) fields.hfSpaceId.textContent = payload.spaceId || '未配置';
  if (fields.hfWriteState) {
    fields.hfWriteState.textContent = payload.hasEnvToken ? 'HF_WRITE_TOKEN 已配置' : '可使用一次性 Token 保存';
  }
  if (fields.hfSecretCount) {
    fields.hfSecretCount.textContent = Array.isArray(payload.secrets) ? `${payload.secrets.length} 个` : '-';
  }
  renderOutput({
    ok: payload.ok,
    spaceId: payload.spaceId,
    hasEnvToken: payload.hasEnvToken,
    knownSecrets: (payload.secrets || []).map((item) => item.key),
    message: payload.message || payload.error?.message
  });
  setStatus(payload.ok ? 'HF 已连接' : 'HF 待配置', payload.ok ? 'ok' : 'fail');
}

async function saveHfSecrets() {
  const secrets = collectHfSecretUpdates();
  if (secrets.length === 0) {
    renderOutput('没有填写需要替换的 Secret。');
    return;
  }
  renderOutput(`准备保存 ${secrets.length} 个 Hugging Face Secret...`);
  const payload = await requestJson('/api/admin/hf-secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hfToken: fields.hfOneTimeToken?.value.trim() || undefined,
      secrets
    })
  });
  fields.hfOneTimeToken.value = '';
  clearHfSecretInputs();
  renderOutput({
    ok: payload.ok,
    updatedKeys: payload.updatedKeys,
    runtimeChangedKeys: payload.runtimeChangedKeys,
    failed: (payload.results || []).filter((item) => !item.ok).map((item) => ({
      key: item.key,
      status: item.error?.status,
      message: item.error?.message
    })),
    note: payload.note
  });
  setStatus(payload.ok ? 'HF 已保存' : 'HF 部分失败', payload.ok ? 'ok' : 'fail');
  if (payload.adminRequiresLogin) {
    await refreshSession();
  }
}

async function testSearch() {
  renderOutput('LibreSearch 测试中...');
  const payload = await requestJson('/api/admin/test/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: fields.testQuery.value.trim() || 'test',
      categories: fields.categories.value,
      language: fields.language.value.trim() || 'auto',
      safesearch: fields.safesearch.value,
      time_range: fields.timeRange.value || undefined
    })
  });
  renderOutput(payload.ok ? payload.summary : payload.error);
  setStatus(payload.ok ? '搜索正常' : '搜索异常', payload.ok ? 'ok' : 'fail');
}

async function testSearchSh() {
  renderOutput('Search-2api 测试中...');
  const payload = await requestJson('/api/admin/test/search-sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: fields.testPrompt.value.trim() || 'test'
    })
  });
  renderOutput(payload.ok ? (payload.answer || payload.payload) : payload.error);
  setStatus(payload.ok ? 'Chat 正常' : 'Chat 异常', payload.ok ? 'ok' : 'fail');
}

async function auditSearch2api() {
  renderOutput('Search-2api 维护检查中...');
  if (fields.search2apiStatusHint) fields.search2apiStatusHint.textContent = '检查中';
  const payload = await requestJson('/api/admin/test/search2api-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (fields.search2apiUpstreamState) {
    fields.search2apiUpstreamState.textContent = payload.upstream?.stale
      ? `偏旧：${payload.upstream.ageDays} 天`
      : (payload.upstream?.ok ? '可访问' : '异常');
  }
  if (fields.search2apiRuntimeState) {
    fields.search2apiRuntimeState.textContent = payload.runtime?.ok ? '接口可访问' : '需要维修';
  }
  if (fields.search2apiStatusHint) {
    fields.search2apiStatusHint.textContent = payload.ok ? '检查通过' : '需要处理';
  }
  renderOutput(payload);
  setStatus(payload.ok ? '2api 正常' : '2api 需维修', payload.ok ? 'ok' : 'fail');
}

async function rotateAdminSecurity() {
  fields.securityHint.textContent = '更新中';
  const body = {
    currentAdminToken: fields.currentAdminToken.value,
    newAdminToken: fields.newAdminToken.value.trim() || undefined,
    rotateSessionSecret: fields.rotateSessionSecret.checked
  };
  const payload = await saveSecurityPayload(body);
  fields.currentAdminToken.value = '';
  fields.newAdminToken.value = '';
  fields.rotateSessionSecret.checked = true;
  fields.securityHint.textContent = payload.adminRequiresLogin ? '已更新，请使用新 Admin Token 重新登录' : '已更新';
  renderOutput({
    ok: payload.ok,
    adminRequiresLogin: payload.adminRequiresLogin,
    auth: payload.auth,
    note: 'Token 已写入运行配置；Hugging Face 免费 Space 重启后仍建议同步更新 Settings Secrets。'
  });
  if (payload.adminRequiresLogin) {
    await refreshSession();
  } else {
    await loadConfig();
  }
}

async function rotateMcpSecurity() {
  const body = {
    currentAdminToken: fields.currentMcpAdminToken.value,
    newMcpAuthToken: fields.newMcpAuthToken.value.trim() || undefined,
    clearMcpAuthToken: fields.clearMcpAuthToken.checked
  };
  const payload = await saveSecurityPayload(body);
  fields.currentMcpAdminToken.value = '';
  fields.newMcpAuthToken.value = '';
  fields.clearMcpAuthToken.checked = false;
  renderOutput({
    ok: payload.ok,
    auth: payload.auth,
    note: 'MCP 客户端需要同步替换 Bearer Token。'
  });
  await loadConfig();
}

async function saveSecurityPayload(body) {
  const payload = await requestJson('/api/admin/security', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  setStatus('安全已更新', 'ok');
  return payload;
}

async function loadLogs() {
  if (!fields.logViewer) return;
  fields.logViewer.innerHTML = '<div class="empty-note">读取中</div>';
  const params = new URLSearchParams({
    limit: fields.logLimit?.value || '120'
  });
  if (fields.logLevel?.value) params.set('level', fields.logLevel.value);
  if (fields.logScope?.value.trim()) params.set('scope', fields.logScope.value.trim());

  const payload = await requestJson(`/api/admin/logs?${params.toString()}`);
  if (fields.logFilePath) fields.logFilePath.textContent = payload.logFilePath || '-';
  if (fields.logCount) fields.logCount.textContent = String(payload.count ?? 0);
  fields.logViewer.innerHTML = (payload.entries || []).length
    ? payload.entries.map(renderLogEntry).join('')
    : '<div class="empty-note">暂无日志</div>';
  setStatus('日志已刷新', 'ok');
}

function renderLogEntry(entry) {
  const details = entry.details && Object.keys(entry.details).length
    ? `<pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre>`
    : '';
  return `
    <article class="log-entry ${escapeHtml(entry.level || 'info')}">
      <div class="log-entry-head">
        <span>${escapeHtml(entry.level || 'info')}</span>
        <strong>${escapeHtml(entry.scope || 'app')}</strong>
        <time>${escapeHtml(formatLogTime(entry.ts))}</time>
      </div>
      <p>${escapeHtml(entry.message || '')}</p>
      ${details}
    </article>
  `;
}

function formatLogTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function testGrok() {
  renderOutput('Grok / GuDa 测试中...');
  const payload = await requestJson('/api/admin/test/grok', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: fields.testGrokQuery.value.trim() || 'test',
      model: fields.grokModel.value.trim() || undefined,
      extraSources: 2
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Fusion 正常' : 'Fusion 异常', payload.ok ? 'ok' : 'fail');
}

async function testFusionFetch() {
  renderOutput('网页抓取测试中...');
  const payload = await requestJson('/api/admin/test/fusion-fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: fields.testFetchUrl.value.trim()
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Fetch 正常' : 'Fetch 异常', payload.ok ? 'ok' : 'fail');
}

async function testFusionMap() {
  renderOutput('站点映射测试中...');
  const payload = await requestJson('/api/admin/test/fusion-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: fields.testMapUrl.value.trim(),
      maxDepth: 1,
      maxBreadth: 20,
      limit: 30,
      timeout: 30
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Map 正常' : 'Map 异常', payload.ok ? 'ok' : 'fail');
}

async function listGrokModels() {
  renderOutput('读取 Grok 模型中...');
  const payload = await requestJson('/api/admin/fusion/models');
  renderOutput(payload.ok ? payload.models : payload.error);
  setStatus(payload.ok ? '模型已读取' : '模型异常', payload.ok ? 'ok' : 'fail');
}

function resetFusionSecrets() {
  fields.gudaApiKey.value = '';
  fields.grokApiKey.value = '';
  fields.tavilyApiKey.value = '';
  fields.firecrawlApiKey.value = '';
  fields.clearGudaApiKey.checked = false;
  fields.clearGrokApiKey.checked = false;
  fields.clearTavilyApiKey.checked = false;
  fields.clearFirecrawlApiKey.checked = false;
}

function bindAction(selector, action) {
  const element = $(selector);
  if (!element) return;
  element.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      if (error.status === 401) {
        await refreshSession();
      }
      setStatus('异常', 'fail');
      renderOutput(error.message || String(error));
    } finally {
      button.disabled = false;
    }
  });
}

bindAction('#refreshConfig', loadConfig);
bindAction('#saveConfig', saveConfig);
bindAction('#loginAdmin', loginAdmin);
bindAction('#logoutAdmin', logoutAdmin);
bindAction('#checkRuntime', checkRuntime);
bindAction('#testSearch', testSearch);
bindAction('#testSearchSh', testSearchSh);
bindAction('#auditSearch2api', auditSearch2api);
bindAction('#rotateSecurity', rotateAdminSecurity);
bindAction('#rotateMcpSecurity', rotateMcpSecurity);
bindAction('#loadHfSecrets', loadHfSecrets);
bindAction('#saveHfSecrets', saveHfSecrets);
bindAction('#loadLogs', loadLogs);
bindAction('#testGrok', testGrok);
bindAction('#testGrokFromPreview', testGrok);
bindAction('#testFusionFetch', testFusionFetch);
bindAction('#testFusionMap', testFusionMap);
bindAction('#listGrokModels', listGrokModels);
bindAction('#resetGrokPrompt', async () => {
  fields.grokSystemPrompt.value = defaultGrokSystemPrompt;
  fields.saveHint.textContent = '提示词已恢复，保存后生效';
});

mainNavItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault();
    const group = item.dataset.group;
    setActiveRoute(group, defaultSubviews[group]);
  });
});

subNavItems.forEach((item) => {
  item.addEventListener('click', () => {
    const group = item.closest('.subnav-group')?.dataset.subnavGroup || 'sources';
    setActiveRoute(group, item.dataset.subview);
  });
});

window.addEventListener('hashchange', () => {
  setActiveRoute(...normalizeRoute(window.location.hash), false);
});

setActiveRoute(...normalizeRoute(window.location.hash), false);
const session = await refreshSession();
if (!(session.adminAuthEnabled && !session.adminAuthenticated)) {
  await loadConfig();
  await checkRuntime();
}
