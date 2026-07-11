"""
Perplexity MCP Server package.
Provides both MCP tools and OpenAI-compatible API endpoints.
"""

from .app import mcp, get_pool
from .main import run_server, main

# Import tools to ensure they're registered
from .mcp import (  # noqa: F401
    list_models,
    perplexity_ask,
    perplexity_reason,
    perplexity_research,
    perplexity_search,
    research,
    search,
)

__all__ = [
    "mcp",
    "get_pool",
    "run_server",
    "main",
    "list_models",
    "search",
    "research",
    "perplexity_ask",
    "perplexity_search",
    "perplexity_reason",
    "perplexity_research",
]
