import { createApp } from './app.js';
import { configureLogger, logEvent } from './logger.js';
import { getRuntimeConfigPath, loadRuntimeConfig, saveRuntimeConfig } from './runtimeConfig.js';
import {
  supabaseEnabled,
  ensureBucket,
  restoreRuntimeConfig,
  backupRuntimeConfig,
  supabaseStoreInfo
} from './supabaseStore.js';

const PORT = Number.parseInt(process.env.PORT ?? '1666', 10);
const runtimeConfigPath = getRuntimeConfigPath();
configureLogger({ logDir: process.env.LOG_DIR });

// On ephemeral hosts (HF Spaces) hydrate runtime.json from Supabase before the
// local config is read, so Admin edits survive a rebuild. No-op when unset.
if (supabaseEnabled()) {
  try {
    await ensureBucket();
    const restored = await restoreRuntimeConfig(runtimeConfigPath);
    logEvent(
      'info',
      'supabase',
      restored ? 'Runtime config restored from Supabase' : 'No Supabase snapshot yet, starting fresh',
      {}
    );
  } catch (error) {
    logEvent('warn', 'supabase', 'Runtime config restore skipped', {
      error: String(error?.message || error)
    });
  }
}

const runtimeConfig = await loadRuntimeConfig(runtimeConfigPath);
const initialAdminToken = process.env.ADMIN_TOKEN ?? runtimeConfig.adminToken ?? '';
const initialMcpAuthToken = process.env.MCP_AUTH_TOKEN ?? runtimeConfig.mcpAuthToken ?? '';
const envFlag = (name, fallback = false) => {
  if (process.env[name] === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(process.env[name].toLowerCase());
};
const resolveTavilyProvider = () => {
  if (process.env.TAVILY_PROVIDER || process.env.TAVILY_MODE) {
    return process.env.TAVILY_PROVIDER ?? process.env.TAVILY_MODE;
  }
  if (process.env.TAVILY_MCP_URL || process.env.TAVILY_MCP_TOKEN || process.env.TAVILY_HIKARI_TOKEN) {
    return 'mcp';
  }
  return runtimeConfig.tavilyProvider;
};

const app = createApp({
  ...runtimeConfig,
  searchEndpoint: process.env.SEARCH_ENDPOINT ?? runtimeConfig.searchEndpoint,
  serverName: process.env.SERVER_NAME ?? runtimeConfig.serverName,
  serverVersion: process.env.SERVER_VERSION ?? runtimeConfig.serverVersion,
  searchShChatEndpoint: process.env.SEARCH_SH_CHAT_ENDPOINT ?? runtimeConfig.searchShChatEndpoint,
  searchShApiKey: process.env.SEARCH_SH_API_KEY ?? runtimeConfig.searchShApiKey,
  grokApiUrl: process.env.GROK_API_URL ?? runtimeConfig.grokApiUrl,
  grokApiKey: process.env.GROK_API_KEY ?? runtimeConfig.grokApiKey,
  grokModel: process.env.GROK_MODEL ?? runtimeConfig.grokModel,
  grokSystemPrompt: process.env.GROK_SYSTEM_PROMPT ?? runtimeConfig.grokSystemPrompt,
  perplexityApiUrl: process.env.PERPLEXITY_API_URL ?? runtimeConfig.perplexityApiUrl,
  perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? runtimeConfig.perplexityApiKey,
  perplexityModel: process.env.PERPLEXITY_MODEL ?? runtimeConfig.perplexityModel ?? 'perplexity-search',
  tavilyEnabled:
    process.env.TAVILY_ENABLED !== undefined
      ? ['true', '1', 'yes'].includes(process.env.TAVILY_ENABLED.toLowerCase())
      : runtimeConfig.tavilyEnabled,
  tavilyProvider: resolveTavilyProvider(),
  tavilyApiUrl: process.env.TAVILY_API_URL ?? runtimeConfig.tavilyApiUrl,
  tavilyApiKey: process.env.TAVILY_API_KEY ?? runtimeConfig.tavilyApiKey,
  tavilyMcpUrl: process.env.TAVILY_MCP_URL ?? runtimeConfig.tavilyMcpUrl,
  tavilyMcpToken: process.env.TAVILY_MCP_TOKEN ?? process.env.TAVILY_HIKARI_TOKEN ?? runtimeConfig.tavilyMcpToken,
  tavilyMcpSearchTool: process.env.TAVILY_MCP_SEARCH_TOOL ?? runtimeConfig.tavilyMcpSearchTool,
  tavilyMcpExtractTool: process.env.TAVILY_MCP_EXTRACT_TOOL ?? runtimeConfig.tavilyMcpExtractTool,
  tavilyMcpMapTool: process.env.TAVILY_MCP_MAP_TOOL ?? runtimeConfig.tavilyMcpMapTool,
  firecrawlApiUrl: process.env.FIRECRAWL_API_URL ?? runtimeConfig.firecrawlApiUrl,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? runtimeConfig.firecrawlApiKey,
  hfEndpoint: process.env.HF_ENDPOINT ?? runtimeConfig.hfEndpoint,
  hfSpaceId: process.env.HF_SPACE_ID ?? process.env.SPACE_ID ?? runtimeConfig.hfSpaceId,
  logDir: process.env.LOG_DIR ?? runtimeConfig.logDir,
  adminAuthEnabled: envFlag('ADMIN_AUTH_ENABLED', runtimeConfig.adminAuthEnabled ?? Boolean(initialAdminToken)),
  adminToken: initialAdminToken,
  sessionSecret: process.env.SESSION_SECRET ?? runtimeConfig.sessionSecret ?? '',
  siteGatePassword: process.env.SITE_GATE_PASSWORD ?? runtimeConfig.siteGatePassword ?? '',
  mcpAuthToken: initialMcpAuthToken,
  runtimeConfigPath,
  saveRuntimeConfig: async (nextConfig) => {
    await saveRuntimeConfig(nextConfig, runtimeConfigPath);
    if (supabaseEnabled()) {
      // Mirror the save to Supabase without blocking the Admin response.
      backupRuntimeConfig(runtimeConfigPath).catch((error) =>
        logEvent('warn', 'supabase', 'Runtime config backup failed', {
          error: String(error?.message || error)
        })
      );
    }
  }
});

app.listen(PORT, () => {
  console.log(`MCP search server listening on port ${PORT}`);
  logEvent('info', 'server', 'FusionSearch server started', {
    port: PORT,
    runtimeConfigPath
  });
  if (supabaseEnabled()) {
    const everyMs = Number.parseInt(process.env.SUPABASE_BACKUP_INTERVAL_MS ?? '300000', 10);
    if (Number.isFinite(everyMs) && everyMs > 0) {
      const timer = setInterval(() => {
        backupRuntimeConfig(runtimeConfigPath).catch((error) =>
          logEvent('warn', 'supabase', 'Periodic backup failed', {
            error: String(error?.message || error)
          })
        );
      }, everyMs);
      timer.unref?.();
    }
    logEvent('info', 'supabase', 'Supabase persistence enabled', {
      bucket: supabaseStoreInfo.bucket,
      object: supabaseStoreInfo.object,
      intervalMs: everyMs
    });
  }
});
