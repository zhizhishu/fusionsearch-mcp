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
  fusion: 'keys',
  mcp: 'full',
  deploy: 'docker',
  security: 'session',
  tests: 'libresearch-test',
  status: 'monitoring'
};

// 只读栏目（无可保存配置）：切进去时隐藏底部保存条
const READONLY_GROUPS = new Set(['tests', 'status']);
let currentGroup = 'sources';

const legacyRoutes = {
  libresearch: ['sources', 'libresearch'],
  search2api: ['sources', 'search2api'],
  fusion: ['fusion', 'keys'],
  keys: ['fusion', 'keys'],
  grok: ['fusion', 'grok'],
  prompt: ['fusion', 'prompt'],
  tavily: ['fusion', 'tavily'],
  firecrawl: ['fusion', 'firecrawl'],
  preview: ['tests', 'libresearch-test'],
  search: ['tests', 'libresearch-test'],
  'fusion-test': ['tests', 'grok-test'],
  fetch: ['tests', 'tavily-test'],
  runtime: ['status', 'runtime'],
  monitoring: ['status', 'monitoring']
};

const fields = {
  searchEndpoint: $('#searchEndpoint'),
  searchShEndpoint: $('#searchShEndpoint'),
  search2apiProjectUrl: $('#search2apiProjectUrl'),
  search2apiBaseUrl: $('#search2apiBaseUrl'),
  search2apiUpstreamState: $('#search2apiUpstreamState'),
  search2apiRuntimeState: $('#search2apiRuntimeState'),
  search2apiStatusHint: $('#search2apiStatusHint'),
  grokApiUrl: $('#grokApiUrl'),
  grokModel: $('#grokModel'),
  grokModelList: $('#grokModelList'),
  grokModelHint: $('#grokModelHint'),
  syncGrokHfSecrets: $('#syncGrokHfSecrets'),
  grokHfToken: $('#grokHfToken'),
  grokSystemPrompt: $('#grokSystemPrompt'),
  resetGrokPrompt: $('#resetGrokPrompt'),
  tavilyEnabled: $('#tavilyEnabled'),
  tavilyProvider: $('#tavilyProvider'),
  tavilyProviderChoices: $$('input[name="tavilyProviderChoice"]'),
  tavilyProviderOptions: $$('[data-tavily-provider-option]'),
  tavilyProviderPanels: $$('[data-tavily-provider-panel]'),
  tavilyApiUrl: $('#tavilyApiUrl'),
  tavilyMcpUrl: $('#tavilyMcpUrl'),
  tavilyMcpSearchTool: $('#tavilyMcpSearchTool'),
  tavilyMcpExtractTool: $('#tavilyMcpExtractTool'),
  tavilyMcpMapTool: $('#tavilyMcpMapTool'),
  firecrawlApiUrl: $('#firecrawlApiUrl'),
  keyStatusGrid: $('#keyStatusGrid'),
  keyStatusHint: $('#keyStatusHint'),
  categories: $('#categories'),
  language: $('#language'),
  safesearch: $('#safesearch'),
  timeRange: $('#timeRange'),
  testQuery: $('#testQuery'),
  testPrompt: $('#testPrompt'),
  testGrokQuery: $('#testGrokQuery'),
  testTavilyQuery: $('#testTavilyQuery'),
  testFetchUrl: $('#testFetchUrl'),
  testMapUrl: $('#testMapUrl'),
  testFirecrawlUrl: $('#testFirecrawlUrl'),
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
  rotateSessionSecret: $('#rotateSessionSecret'),
  syncSecurityHfSecrets: $('#syncSecurityHfSecrets'),
  securityHfToken: $('#securityHfToken'),
  securityHint: $('#securityHint'),
  keysWriteHf: $('#keysWriteHf'),
  keysHfToken: $('#keysHfToken'),
  logFilePath: $('#logFilePath'),
  logCount: $('#logCount'),
  logLevel: $('#logLevel'),
  logScope: $('#logScope'),
  logLimit: $('#logLimit'),
  logViewer: $('#logViewer'),
  monitoringCount: $('#monitoringCount'),
  monitorBars: $('#monitorBars'),
  monitoringHint: $('#monitoringHint'),
  monitoringServices: $('#monitoringServices'),
  keyState: $('#keyState'),
  fusionKeyState: $('#fusionKeyState'),
  saveHint: $('#saveHint')
};

let grokModelOptions = [];

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
    fusion.hasTavilyCredentials ? `Tavily ${fusion.tavilyProvider === 'mcp' ? 'MCP' : 'REST'}` : '',
    fusion.hasFirecrawlApiKey ? 'Firecrawl' : ''
  ].filter(Boolean);
  return providers.length ? `${providers.join(' / ')} 已配置` : '未配置';
}

function getTavilyProvider() {
  const selected = fields.tavilyProviderChoices.find((choice) => choice.checked)?.value;
  return selected === 'mcp' ? 'mcp' : 'rest';
}

function setTavilyProvider(value = 'rest') {
  const provider = value === 'mcp' ? 'mcp' : 'rest';
  if (fields.tavilyProvider) {
    fields.tavilyProvider.value = provider;
  }
  fields.tavilyProviderChoices.forEach((choice) => {
    choice.checked = choice.value === provider;
  });
  fields.tavilyProviderOptions.forEach((option) => {
    const isActive = option.dataset.tavilyProviderOption === provider;
    option.classList.toggle('active', isActive);
    option.setAttribute('aria-checked', String(isActive));
  });
  fields.tavilyProviderPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tavilyProviderPanel !== provider;
  });
}

function normalizeModelList(models = []) {
  return Array.from(new Set(
    models
      .map((model) => String(model || '').trim())
      .filter(Boolean)
  ));
}

function getCurrentGrokModel() {
  return fields.grokModel?.value.trim() || 'grok-4.20-beta';
}

function renderGrokModels(models = grokModelOptions, { source = '' } = {}) {
  if (!fields.grokModelList) return;
  const currentModel = getCurrentGrokModel();
  const normalized = normalizeModelList([currentModel, ...models]);
  grokModelOptions = normalized;

  fields.grokModelList.innerHTML = normalized
    .map((model) => {
      const active = model === currentModel;
      return `
        <button class="model-card ${active ? 'active' : ''}" type="button" data-model-id="${escapeHtml(model)}" aria-pressed="${String(active)}">
          <strong>${escapeHtml(model)}</strong>
          <small>${active ? '当前默认' : '点击选择'}</small>
        </button>
      `;
    })
    .join('');

  if (fields.grokModelHint) {
    const countText = normalized.length > 1 ? `${normalized.length} 个模型可选` : '当前模型可编辑';
    fields.grokModelHint.textContent = source ? `${source} · ${countText}` : countText;
  }
}

function selectGrokModel(model) {
  if (!model || !fields.grokModel) return;
  fields.grokModel.value = model;
  renderGrokModels(grokModelOptions, { source: '已选择' });
  fields.saveHint.textContent = '模型已选择，保存后生效';
}

let revealedValuesCache = null;

// Fetch the live effective values once per render so eye-toggles show real plaintext
// (env var OR runtime config) without re-hitting the server on every click. Reset
// whenever the key list re-renders.
async function ensureRevealValues() {
  if (revealedValuesCache) return revealedValuesCache;
  const payload = await requestJson('/api/admin/keys/reveal');
  revealedValuesCache = payload?.values || {};
  return revealedValuesCache;
}

// One delegated listener on the grid; survives innerHTML re-renders of the cards.
function bindKeyReveal() {
  if (!fields.keyStatusGrid || fields.keyStatusGrid.dataset.revealBound) return;
  fields.keyStatusGrid.dataset.revealBound = '1';
  fields.keyStatusGrid.addEventListener('click', async (event) => {
    const btn = event.target.closest('.key-eye');
    if (!btn) return;
    const card = btn.closest('.key-status-card');
    const code = card?.querySelector('code');
    if (!code) return;
    const keyId = card.dataset.keyId || '';
    if (card.classList.contains('revealed')) {
      code.textContent = code.dataset.masked || '未设置';
      card.classList.remove('revealed');
      btn.textContent = '👁';
      btn.setAttribute('aria-label', '显示明文');
      return;
    }
    btn.disabled = true;
    try {
      const values = await ensureRevealValues();
      const value = values[keyId];
      code.textContent = (value === undefined || value === '')
        ? '（当前没取到值）'
        : value;
      card.classList.add('revealed');
      btn.textContent = '🙈';
      btn.setAttribute('aria-label', '隐藏明文');
    } catch (error) {
      code.textContent = `读取明文失败：${error?.message || error}`;
    } finally {
      btn.disabled = false;
    }
  });
}

// Per-row editing rules for the unified key center. Mirrors KEY_CENTER_FIELDS on the
// server: which rows are editable, whether they write back to HF, whether they can be
// cleared, and the small footnote hint.
const KEY_CENTER_META = {
  libresearchEndpoint: { editable: false, hf: false },
  search2apiBearer: { editable: true, hf: true, clear: true },
  search2apiCookie: { editable: true, hf: true, clear: false, note: '环境变量 · 存后需重启 Space 生效' },
  grokApiKey: { editable: true, hf: true, clear: true },
  tavilyApiKey: { editable: true, hf: true, clear: true },
  tavilyMcpToken: { editable: true, hf: true, clear: true },
  firecrawlApiKey: { editable: true, hf: true, clear: true },
  adminToken: { editable: true, hf: true, clear: false, note: '改后需用新口令重新登录' },
  mcpAuthToken: { editable: true, hf: true, clear: true }
};

function renderKeyStatus(items = []) {
  if (!fields.keyStatusGrid) return;
  revealedValuesCache = null;
  fields.keyStatusGrid.innerHTML = items.length
    ? items.map((item) => {
      const meta = KEY_CENTER_META[item.id] || { editable: false, hf: false };
      const masked = item.masked || '未设置';
      const eye = item.configured
        ? `<button type="button" class="key-eye" aria-label="显示明文" title="显示 / 隐藏明文">👁</button>`
        : '';
      const tag = meta.hf ? '<span class="key-tag">HF</span>' : '';
      const editor = meta.editable
        ? `
        <div class="key-edit">
          <input class="key-edit-input" type="password" autocomplete="new-password" placeholder="留空则不改，输入即替换" data-key-id="${escapeHtml(item.id)}" />
          ${meta.clear ? `<label class="key-clear"><input type="checkbox" class="key-clear-box" data-key-id="${escapeHtml(item.id)}" />清空</label>` : ''}
        </div>
        ${meta.note ? `<small class="key-note">${escapeHtml(meta.note)}</small>` : ''}`
        : '<small class="key-note">在对应服务面板里修改</small>';
      return `
      <article class="key-status-card ${item.configured ? 'configured' : 'missing'}" data-key-id="${escapeHtml(item.id)}">
        <div>
          <span>${escapeHtml(item.label)}${tag}</span>
          <div class="key-actions"><strong>${item.configured ? '已配置' : '未配置'}</strong>${eye}</div>
        </div>
        <code data-masked="${escapeHtml(masked)}">${escapeHtml(masked)}</code>
        <small>${escapeHtml(formatKeySource(item))}</small>
        ${editor}
      </article>`;
    }).join('')
    : '<div class="empty-note">暂无 Key 状态</div>';
  bindKeyReveal();
}

// When the Space already has HF_WRITE_TOKEN + Space ID, the one-time-token inputs are
// pure noise — hide them and show a calm "ready" line instead. Only surface an input
// when write-back couldn't otherwise happen.
function applyHfTokenVisibility(canWrite) {
  const pairs = [
    ['keysHfTokenField', 'keysHfReady'],
    ['securityHfTokenField', 'securityHfReady'],
    ['grokHfTokenField', 'grokHfReady']
  ];
  for (const [fieldId, readyId] of pairs) {
    const field = document.getElementById(fieldId);
    const ready = document.getElementById(readyId);
    if (field) field.hidden = Boolean(canWrite);
    if (ready) ready.hidden = !canWrite;
  }
}

function formatKeySource(item) {
  const source = item.source || 'missing';
  if (source === 'runtime') return 'runtime config';
  if (source === 'missing') return 'not set';
  const meta = item.meta || {};
  const extra = item.id === 'search2apiCookie'
    ? `; cf_clearance ${meta.hasCfClearance ? 'yes' : 'no'}; UA ${meta.hasUserAgent ? 'yes' : 'no'}`
    : '';
  return `${source}${extra}`;
}

function renderMonitoring(snapshot = {}) {
  const services = snapshot.services || [];
  if (fields.monitoringCount) fields.monitoringCount.textContent = String(snapshot.count ?? services.length);
  if (fields.monitorBars) {
    fields.monitorBars.innerHTML = services
      .map((service) => `<span class="monitor-bar ${escapeHtml(service.status)}" title="${escapeHtml(service.name)}: ${escapeHtml(service.statusLabel)}"></span>`)
      .join('');
  }
  if (fields.monitoringServices) {
    fields.monitoringServices.innerHTML = services.length
      ? `
        <div class="monitor-row monitor-row-head">
          <span>Service Name</span>
          <span>Service Type</span>
          <span>Service Status</span>
          <span>Last Check</span>
        </div>
        ${services.map((service) => `
          <div class="monitor-row">
            <strong>${escapeHtml(service.name)}</strong>
            <span>${escapeHtml(service.type)}</span>
            <span class="service-pill ${escapeHtml(service.status)}">${escapeHtml(service.statusLabel)}</span>
            <small>${escapeHtml(formatMonitorCheck(service))}</small>
            <p>${escapeHtml(service.message || '')}</p>
          </div>
        `).join('')}
      `
      : '<div class="empty-note">暂无监控服务</div>';
  }
  if (fields.monitoringHint) {
    const counts = snapshot.counts || {};
    const probe = snapshot.probe?.skipped ? `；${snapshot.probe.reason}` : '';
    fields.monitoringHint.textContent = `Up ${counts.up || 0} / Warning ${counts.warning || 0} / Down ${counts.down || 0} / Paused ${counts.paused || 0}${probe}`;
  }
}

function formatMonitorCheck(service) {
  const time = service.checkedAt ? formatLogTime(service.checkedAt) : 'waiting';
  const ms = service.responseTimeMs == null ? '' : ` · ${service.responseTimeMs}ms`;
  return `${time}${ms} · ${service.source || 'unknown'}`;
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
  if (targetGroup === 'status' && targetSubview === 'monitoring') {
    void loadMonitoring().catch(() => {});
  }
  if (targetGroup === 'fusion' && targetSubview === 'keys') {
    void loadKeyStatus().catch(() => {});
  }

  const nextHash = `#${targetGroup}:${targetSubview}`;
  if (updateHash && window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
  currentGroup = targetGroup;
  if (!workbench.hidden) {
    saveBar.hidden = READONLY_GROUPS.has(targetGroup);
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
  saveBar.hidden = locked || READONLY_GROUPS.has(currentGroup);
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
  renderKeyStatus(config.keyStatus || []);
  applyHfTokenVisibility(config.hfSecrets?.canWrite);
  if (fields.adminAuthState) {
    fields.adminAuthState.textContent = config.auth?.adminAuthEnabled ? '已启用' : '未启用';
  }
  if (fields.mcpAuthState) {
    fields.mcpAuthState.textContent = config.auth?.mcpAuthEnabled ? '已启用' : '未启用';
  }
  fields.grokApiUrl.value = config.fusion?.grokApiUrl || '';
  fields.grokModel.value = config.fusion?.grokModel || 'grok-4.20-beta';
  renderGrokModels([fields.grokModel.value], { source: '当前配置' });
  fields.grokSystemPrompt.value = config.fusion?.grokSystemPrompt || defaultGrokSystemPrompt;
  fields.tavilyEnabled.checked = config.fusion?.tavilyEnabled !== false;
  setTavilyProvider(config.fusion?.tavilyProvider || 'rest');
  fields.tavilyApiUrl.value = config.fusion?.tavilyApiUrl || 'https://api.tavily.com';
  fields.tavilyMcpUrl.value = config.fusion?.tavilyMcpUrl || '';
  fields.tavilyMcpSearchTool.value = config.fusion?.tavilyMcpSearchTool || '';
  fields.tavilyMcpExtractTool.value = config.fusion?.tavilyMcpExtractTool || '';
  fields.tavilyMcpMapTool.value = config.fusion?.tavilyMcpMapTool || '';
  fields.firecrawlApiUrl.value = config.fusion?.firecrawlApiUrl || 'https://api.firecrawl.dev/v2';
  setStatus('已连接', 'ok');
}

async function saveConfig() {
  fields.saveHint.textContent = '保存中';
  const body = {
    searchEndpoint: fields.searchEndpoint.value.trim(),
    searchShChatEndpoint: fields.searchShEndpoint.value.trim(),
    grokApiUrl: fields.grokApiUrl.value.trim(),
    grokModel: fields.grokModel.value.trim() || 'grok-4.20-beta',
    syncGrokHfSecrets: fields.syncGrokHfSecrets?.checked ?? false,
    grokHfToken: fields.grokHfToken?.value.trim() || undefined,
    grokSystemPrompt: fields.grokSystemPrompt.value.trim() || defaultGrokSystemPrompt,
    tavilyEnabled: fields.tavilyEnabled.checked,
    tavilyProvider: getTavilyProvider(),
    tavilyApiUrl: fields.tavilyApiUrl.value.trim(),
    tavilyMcpUrl: fields.tavilyMcpUrl.value.trim(),
    tavilyMcpSearchTool: fields.tavilyMcpSearchTool.value.trim(),
    tavilyMcpExtractTool: fields.tavilyMcpExtractTool.value.trim(),
    tavilyMcpMapTool: fields.tavilyMcpMapTool.value.trim(),
    firecrawlApiUrl: fields.firecrawlApiUrl.value.trim(),
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
  renderKeyStatus(config.keyStatus || []);
  if (fields.grokHfToken) fields.grokHfToken.value = '';
  if (config.hfSync?.requested) {
    const synced = config.hfSync.ok && config.hfSync.updatedKeys?.includes('GROK_MODEL');
    fields.saveHint.textContent = synced
      ? '已保存，GROK_MODEL 已同步到 HF Secrets'
      : `已保存，但 HF Secrets 未同步：${config.hfSync.error?.message || '请检查 HF_WRITE_TOKEN'}`;
    renderOutput({
      ok: true,
      grokModel: config.fusion?.grokModel,
      hfSync: {
        requested: config.hfSync.requested,
        ok: config.hfSync.ok,
        updatedKeys: config.hfSync.updatedKeys,
        failedKeys: (config.hfSync.results || []).filter((item) => !item.ok).map((item) => item.key),
        error: config.hfSync.error
      }
    });
    setStatus(synced ? 'HF 已同步' : 'HF 未同步', synced ? 'ok' : 'fail');
  } else {
    fields.saveHint.textContent = '已保存';
    setStatus('已保存', 'ok');
  }
}

async function loadKeyStatus() {
  const payload = await requestJson('/api/admin/keys/status');
  renderKeyStatus(payload.keyStatus || []);
  if (fields.keyStatusHint) fields.keyStatusHint.textContent = 'Key 状态已刷新。改完点「保存全部」；👁 可看当前明文。';
}

// Unified key-center save: collect every filled/cleared row and push to /api/admin/keys.
// The server applies each to the running config immediately and (by default) writes it
// back to HF Secrets so a restart keeps it.
async function saveKeys() {
  const edits = [];
  $$('.key-edit-input').forEach((input) => {
    const id = input.dataset.keyId;
    if (!id) return;
    const clearBox = $(`.key-clear-box[data-key-id="${id}"]`);
    const clear = Boolean(clearBox?.checked);
    const value = input.value;
    if (clear || value.trim()) edits.push({ id, value: value.trim(), clear });
  });
  if (!edits.length) {
    if (fields.keyStatusHint) fields.keyStatusHint.textContent = '没有要改的密钥（输入框都空着）。';
    setStatus('无改动', '');
    return;
  }
  const body = {
    edits,
    writeHf: fields.keysWriteHf?.checked ?? true,
    hfToken: fields.keysHfToken?.value.trim() || undefined
  };
  const payload = await requestJson('/api/admin/keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (fields.keysHfToken) fields.keysHfToken.value = '';
  renderKeyStatus(payload.keyStatus || []);
  const parts = [`已保存 ${payload.changed?.length || 0} 项`];
  if (payload.hfSync?.requested) {
    parts.push(payload.hfSync.ok
      ? `已写回 HF ${payload.hfSync.updatedKeys?.length || 0} 个`
      : `HF 写回失败：${payload.hfSync.error?.message || (payload.hfSync.failedKeys || []).join(', ') || '请检查 HF_WRITE_TOKEN'}`);
  }
  if (payload.envOnlyChanged?.length) parts.push('含环境变量项，需重启 Space 生效');
  if (payload.adminRequiresLogin) parts.push('Admin 口令已改，请用新口令重新登录');
  if (fields.keyStatusHint) fields.keyStatusHint.textContent = parts.join(' · ');
  const hfFailed = payload.hfSync?.requested && !payload.hfSync.ok;
  setStatus(hfFailed ? 'HF 未同步' : '密钥已保存', hfFailed ? 'fail' : 'ok');
  renderOutput({
    ok: payload.ok,
    changed: payload.changed,
    envOnlyChanged: payload.envOnlyChanged,
    adminRequiresLogin: payload.adminRequiresLogin,
    hfSync: payload.hfSync
  });
  if (payload.adminRequiresLogin) {
    await refreshSession();
  } else {
    await loadConfig().catch(() => {});
  }
}

// Session-only action from the slimmed 安全 panel: rotate the session secret (kick all
// old logins). Reuses the same unified endpoint with no key edits.
async function rotateSession() {
  if (fields.securityHint) fields.securityHint.textContent = '轮换中';
  const payload = await requestJson('/api/admin/keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      edits: [],
      rotateSessionSecret: fields.rotateSessionSecret?.checked ?? true,
      writeHf: fields.syncSecurityHfSecrets?.checked ?? true,
      hfToken: fields.securityHfToken?.value.trim() || undefined
    })
  });
  if (fields.securityHfToken) fields.securityHfToken.value = '';
  if (fields.securityHint) {
    fields.securityHint.textContent = payload.adminRequiresLogin ? '已轮换，请重新登录' : '已轮换';
  }
  renderOutput({ ok: payload.ok, adminRequiresLogin: payload.adminRequiresLogin, hfSync: payload.hfSync });
  setStatus('会话已轮换', 'ok');
  if (payload.adminRequiresLogin) await refreshSession();
}

async function loadMonitoring() {
  const payload = await requestJson('/api/admin/monitoring');
  renderMonitoring(payload);
  setStatus('监控已刷新', 'ok');
}

async function probeMonitoring() {
  renderOutput('Monitoring 主动探针中...');
  const payload = await requestJson('/api/admin/monitoring/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  renderMonitoring(payload);
  renderOutput(payload);
  setStatus(payload.probe?.skipped ? '探针冷却' : '探针完成', payload.counts?.down ? 'fail' : 'ok');
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
  renderOutput('Grok API 测试中...');
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
  setStatus(payload.ok ? 'Grok 正常' : 'Grok 异常', payload.ok ? 'ok' : 'fail');
}

async function testTavilySearch() {
  renderOutput('Tavily Search 测试中...');
  const payload = await requestJson('/api/admin/test/tavily-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: fields.testTavilyQuery.value.trim() || 'test',
      maxResults: 5
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Tavily Search 正常' : 'Tavily Search 异常', payload.ok ? 'ok' : 'fail');
}

async function testTavilyFetch() {
  renderOutput('Tavily Fetch 测试中...');
  const payload = await requestJson('/api/admin/test/tavily-fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: fields.testFetchUrl.value.trim()
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Tavily Fetch 正常' : 'Tavily Fetch 异常', payload.ok ? 'ok' : 'fail');
}

async function testFusionFetch() {
  renderOutput('融合抓取测试中...');
  const payload = await requestJson('/api/admin/test/fusion-fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: fields.testFetchUrl.value.trim()
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Fallback Fetch 正常' : 'Fallback Fetch 异常', payload.ok ? 'ok' : 'fail');
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

async function testFirecrawlFetch() {
  renderOutput('Firecrawl Scrape 测试中...');
  const payload = await requestJson('/api/admin/test/firecrawl-fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: fields.testFirecrawlUrl.value.trim()
    })
  });
  renderOutput(payload.ok ? payload : payload.error);
  setStatus(payload.ok ? 'Firecrawl 正常' : 'Firecrawl 异常', payload.ok ? 'ok' : 'fail');
}

async function listGrokModels() {
  renderOutput('读取 Grok 模型中...');
  const payload = await requestJson('/api/admin/fusion/models');
  if (payload.ok) {
    const models = normalizeModelList(payload.models || []);
    renderGrokModels(models, { source: '接口已读取' });
    renderOutput({
      currentModel: getCurrentGrokModel(),
      modelCount: models.length,
      models
    });
  } else {
    renderGrokModels(grokModelOptions, { source: '读取失败' });
    renderOutput(payload.error);
  }
  setStatus(payload.ok ? '模型可选择' : '模型异常', payload.ok ? 'ok' : 'fail');
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
bindAction('#auditSearch2apiFromTests', auditSearch2api);
bindAction('#rotateSession', rotateSession);
bindAction('#loadLogs', loadLogs);
bindAction('#saveKeys', saveKeys);
bindAction('#refreshKeyStatus', loadKeyStatus);
bindAction('#refreshMonitoring', loadMonitoring);
bindAction('#probeMonitoring', probeMonitoring);
bindAction('#testGrok', testGrok);
bindAction('#testGrokFromPreview', testGrok);
bindAction('#testTavilySearch', testTavilySearch);
bindAction('#testTavilyFetch', testTavilyFetch);
bindAction('#testFusionFetch', testFusionFetch);
bindAction('#testFusionMap', testFusionMap);
bindAction('#listGrokModels', listGrokModels);
bindAction('#listGrokModelsFromTests', listGrokModels);
bindAction('#testFirecrawlFetch', testFirecrawlFetch);
bindAction('#resetGrokPrompt', async () => {
  fields.grokSystemPrompt.value = defaultGrokSystemPrompt;
  fields.saveHint.textContent = '提示词已恢复，保存后生效';
});

fields.grokModel?.addEventListener('input', () => {
  renderGrokModels(grokModelOptions, { source: '手动输入' });
});

fields.grokModelList?.addEventListener('click', (event) => {
  const card = event.target.closest('.model-card[data-model-id]');
  if (!card) return;
  selectGrokModel(card.dataset.modelId);
});

fields.tavilyProviderChoices.forEach((choice) => {
  choice.addEventListener('change', () => setTavilyProvider(choice.value));
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
