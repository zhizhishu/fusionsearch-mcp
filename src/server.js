import { createApp } from './app.js';
import { configureLogger, logEvent } from './logger.js';
import { getRuntimeConfigPath, loadRuntimeConfig, saveRuntimeConfig } from './runtimeConfig.js';

const PORT = Number.parseInt(process.env.PORT ?? '1666', 10);
const runtimeConfigPath = getRuntimeConfigPath();
const runtimeConfig = await loadRuntimeConfig(runtimeConfigPath);
configureLogger({ logDir: process.env.LOG_DIR });
const initialAdminToken = process.env.ADMIN_TOKEN ?? runtimeConfig.adminToken ?? '';
const initialMcpAuthToken = process.env.MCP_AUTH_TOKEN ?? runtimeConfig.mcpAuthToken ?? '';
const envFlag = (name, fallback = false) => {
  if (process.env[name] === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(process.env[name].toLowerCase());
};

const app = createApp({
  ...runtimeConfig,
  searchEndpoint: process.env.SEARCH_ENDPOINT ?? runtimeConfig.searchEndpoint,
  serverName: process.env.SERVER_NAME ?? runtimeConfig.serverName,
  serverVersion: process.env.SERVER_VERSION ?? runtimeConfig.serverVersion,
  searchShChatEndpoint: process.env.SEARCH_SH_CHAT_ENDPOINT ?? runtimeConfig.searchShChatEndpoint,
  searchShApiKey: process.env.SEARCH_SH_API_KEY ?? runtimeConfig.searchShApiKey,
  gudaBaseUrl: process.env.GUDA_BASE_URL ?? runtimeConfig.gudaBaseUrl,
  gudaApiKey: process.env.GUDA_API_KEY ?? runtimeConfig.gudaApiKey,
  grokApiUrl: process.env.GROK_API_URL ?? runtimeConfig.grokApiUrl,
  grokApiKey: process.env.GROK_API_KEY ?? runtimeConfig.grokApiKey,
  grokModel: process.env.GROK_MODEL ?? runtimeConfig.grokModel,
  grokSystemPrompt: process.env.GROK_SYSTEM_PROMPT ?? runtimeConfig.grokSystemPrompt,
  tavilyEnabled:
    process.env.TAVILY_ENABLED !== undefined
      ? ['true', '1', 'yes'].includes(process.env.TAVILY_ENABLED.toLowerCase())
      : runtimeConfig.tavilyEnabled,
  tavilyApiUrl: process.env.TAVILY_API_URL ?? runtimeConfig.tavilyApiUrl,
  tavilyApiKey: process.env.TAVILY_API_KEY ?? runtimeConfig.tavilyApiKey,
  firecrawlApiUrl: process.env.FIRECRAWL_API_URL ?? runtimeConfig.firecrawlApiUrl,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? runtimeConfig.firecrawlApiKey,
  hfEndpoint: process.env.HF_ENDPOINT ?? runtimeConfig.hfEndpoint,
  hfSpaceId: process.env.HF_SPACE_ID ?? process.env.SPACE_ID ?? runtimeConfig.hfSpaceId,
  logDir: process.env.LOG_DIR ?? runtimeConfig.logDir,
  adminAuthEnabled: envFlag('ADMIN_AUTH_ENABLED', runtimeConfig.adminAuthEnabled ?? Boolean(initialAdminToken)),
  adminToken: initialAdminToken,
  sessionSecret: process.env.SESSION_SECRET ?? runtimeConfig.sessionSecret ?? '',
  mcpAuthToken: initialMcpAuthToken,
  runtimeConfigPath,
  saveRuntimeConfig: (nextConfig) => saveRuntimeConfig(nextConfig, runtimeConfigPath)
});

app.listen(PORT, () => {
  console.log(`MCP search server listening on port ${PORT}`);
  logEvent('info', 'server', 'FusionSearch server started', {
    port: PORT,
    runtimeConfigPath
  });
});
