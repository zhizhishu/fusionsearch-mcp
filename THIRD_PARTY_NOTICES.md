# Third Party Notices

## GuDaStudio/GrokSearch

- Source: https://github.com/GuDaStudio/GrokSearch/tree/grok-with-tavily
- License: MIT
- Usage: FusionSearch MCP references the GrokSearch tool design and provider flow, then reimplements the Grok/Tavily/Firecrawl integration as native Node.js MCP tools in this project.

## lza6/Search-2api

- Source: https://github.com/lza6/Search-2api
- License: MIT
- Usage: FusionSearch includes a maintained, minimal Search-2api-compatible FastAPI service under `services/search2api` for all-in-one deployments. Secrets such as `SEARCH_SH_COOKIE` are runtime configuration only.

## SearXNG

- Source: https://github.com/searxng/searxng
- License: AGPL-3.0-or-later
- Usage: FusionSearch all-in-one Docker Compose and Hugging Face images run SearXNG/LibreSearch as the local search engine and enable `format=json` in `deploy/searxng/settings.yml`.
