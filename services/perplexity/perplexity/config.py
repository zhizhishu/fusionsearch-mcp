"""
Configuration constants for Perplexity AI API.

This module contains all configurable constants used throughout the library.
Modify these values to customize behavior without changing core code.
"""

import logging
import os
import re
from pathlib import Path
from typing import Dict, Optional

# Load environment variables from .env file
from dotenv import load_dotenv

# Try to load .env from multiple locations
_env_locations = [
    Path.cwd() / ".env",  # Current working directory
    Path(__file__).parent.parent / ".env",  # Project root
    Path.home() / ".perplexity" / ".env",  # User home directory
]

for _env_path in _env_locations:
    if _env_path.exists():
        load_dotenv(_env_path)
        break
else:
    # Load from default location if no .env found
    load_dotenv()

# SOCKS Proxy Configuration
# Format: socks5://[user[:pass]@]host[:port][#remark]
# Examples:
#   socks5://127.0.0.1:1080
#   socks5://user:pass@127.0.0.1:1080
#   socks5://user:pass@127.0.0.1:1080#my-proxy
SOCKS_PROXY: Optional[str] = os.getenv("SOCKS_PROXY", None)

_logger = logging.getLogger(__name__)
if SOCKS_PROXY:
    _logger.debug("SOCKS_PROXY loaded: %s", SOCKS_PROXY.split("@")[-1].split("#")[0])
else:
    _logger.debug("SOCKS_PROXY not configured, will use direct connection")

# Token Pool Configuration
# Path to JSON config file containing multiple tokens for load balancing
# Format: {"tokens": [{"id": "user1", "csrf_token": "xxx", "session_token": "yyy"}, ...]}
PPLX_TOKEN_POOL_CONFIG: Optional[str] = os.getenv("PPLX_TOKEN_POOL_CONFIG", None)

# API Configuration
API_BASE_URL = "https://www.perplexity.ai"
API_VERSION = "2.18"
API_TIMEOUT = 30

# Search Request Timeouts (seconds)
# Perplexity 的 SSE 响应总时长在不同模式下差异很大：
#   - auto / pro / reasoning：通常 30~120s
#   - deep research：常见 3~10 分钟，偶尔更久
#
# 真正生效的超时值由 ClientPool 在运行时根据下面的优先级决定：
#   1) admin API /timeouts/config (会持久化进 token_pool_config.json)
#   2) token_pool_config.json 里的 "timeouts" 段
#   3) 环境变量 PPLX_SEARCH_TIMEOUT / PPLX_DEEP_RESEARCH_TIMEOUT / PPLX_FILE_UPLOAD_TIMEOUT
#   4) 这里的内置默认值

# 共享下限：env / json / admin API 三条路径都用同一个守卫，避免一处放行另一处拦截
MIN_TIMEOUT_SECONDS: int = 10


def _read_int_env(name: str, default: int, min_value: int = MIN_TIMEOUT_SECONDS) -> int:
    """
    Read a positive integer from env. Values below `min_value` are rejected and
    fall back to `default` so e.g. `PPLX_SEARCH_TIMEOUT=1` (typo) doesn't make
    every request fail almost immediately.
    """
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        _logger.warning(
            "Ignoring %s=%r: not an integer; using default %d", name, raw, default
        )
        return default
    if value < min_value:
        _logger.warning(
            "Ignoring %s=%d: below minimum %ds; using default %d",
            name, value, min_value, default,
        )
        return default
    return value


# 内置兜底默认（最低优先级）
DEFAULT_SEARCH_TIMEOUT: int = 300
DEFAULT_DEEP_RESEARCH_TIMEOUT: int = 900
DEFAULT_FILE_UPLOAD_TIMEOUT: int = 180


# ── perplexity resin 出口池（A方案·跨请求粘性游走，治单出口飘）────────────────
# resin 按 socks5 URL 里的 <账号> 分配出口 IP（同账号粘 168h）。把 SOCKS_PROXY 当模板，
# 池首条=原落点账号(已知好→立即命中)，后接 <prefix>1..N-1 备用出口(漂了才逐格游走)。
# 见 Client.search_resilient。POOL_SIZE<=1（默认）= 关闭游走、行为与旧版完全一致；设 >1 才启用。
PERPLEXITY_EXIT_POOL_SIZE: int = _read_int_env("PERPLEXITY_EXIT_POOL_SIZE", 1, min_value=1)
# 单发最多试几个出口(受 TOTAL_BUDGET 封顶，两者先到先停)；失败的指针跨请求持久、下发继续游走。
PERPLEXITY_EXIT_MAX_RETRY: int = _read_int_env("PERPLEXITY_EXIT_MAX_RETRY", 5, min_value=1)
# 单次尝试超时(秒)：good 实测~6s，设 15 足够且坏出口(500秒挂/hang)快弃。
PERPLEXITY_EXIT_ATTEMPT_TIMEOUT: int = _read_int_env(
    "PERPLEXITY_EXIT_ATTEMPT_TIMEOUT", 15, min_value=MIN_TIMEOUT_SECONDS
)
# 单发总预算封顶(秒)：卡进调用方真实 abort(fusion/admin ~60s)内。get_search_timeout 默认 300
# 远大于真实 abort，不封顶会一发试太久超预算(上轮栽点)。
PERPLEXITY_EXIT_TOTAL_BUDGET: int = _read_int_env(
    "PERPLEXITY_EXIT_TOTAL_BUDGET", 50, min_value=MIN_TIMEOUT_SECONDS
)
PERPLEXITY_EXIT_ACCOUNT_PREFIX: str = os.getenv("PERPLEXITY_EXIT_ACCOUNT_PREFIX", "pplx")


def build_exit_pool(base: Optional[str] = None, size: Optional[int] = None) -> list:
    """从 SOCKS_PROXY 模板生成出口池，**首条=原落点账号**(已知好落点打头，立即命中/粘住)。

    base 形如 `socks5://HighPurity.pplxq:TOKEN@host:port`。
    - 无 base → []（直连，不游走）
    - size<=1 或结构不认(无 platform.account) → [base]（单出口，不游走）
    - 否则 → [base] + N-1 条备用账号(`<prefix>1..N-1`=resin 别的出口)，共 N 条
    """
    if base is None:
        base = SOCKS_PROXY or ""
    if base and "#" in base:
        base = base.split("#")[0]
    n = size if size is not None else PERPLEXITY_EXIT_POOL_SIZE
    if not base:
        return []
    if n <= 1:
        return [base]
    # 必须是 resin 账号形态 <platform>.<account>:<token>@<host>:<port>（靠 @ 分隔 auth/host 识别）；
    # 纯 host:port 代理无 @ → 不匹配 → 回退单条不游走。
    # ⚠️ 本池化仅为 resin 出口游走设计：带点用户名的普通代理(如 socks5://john.doe:pw@host)会被误当
    #    platform.account 游走——非 resin 代理别设 PERPLEXITY_EXIT_POOL_SIZE>1。
    m = re.match(r"^(socks5h?://)([^.:/@]+)\.([^:@]+):([^@]+@.+)$", base)
    if not m:
        return [base]
    scheme, platform, _account, rest = m.group(1), m.group(2), m.group(3), m.group(4)
    prefix = PERPLEXITY_EXIT_ACCOUNT_PREFIX
    alts = [f"{scheme}{platform}.{prefix}{i}:{rest}" for i in range(1, n)]  # N-1 条备用
    return [base] + alts  # 原落点(已验证好)打头 + 备用出口

# 环境变量覆盖（用于不依赖 ClientPool 的 fallback 路径，如匿名 Client）
SEARCH_TIMEOUT: int = _read_int_env("PPLX_SEARCH_TIMEOUT", DEFAULT_SEARCH_TIMEOUT)
DEEP_RESEARCH_TIMEOUT: int = _read_int_env(
    "PPLX_DEEP_RESEARCH_TIMEOUT", DEFAULT_DEEP_RESEARCH_TIMEOUT
)
FILE_UPLOAD_TIMEOUT: int = _read_int_env(
    "PPLX_FILE_UPLOAD_TIMEOUT", DEFAULT_FILE_UPLOAD_TIMEOUT
)


def get_search_timeout(mode: str) -> int:
    """
    Module-level fallback used when no per-call/per-pool override is provided.
    Higher-priority sources (admin API, token_pool_config.json) are resolved by
    ClientPool.get_search_timeout(mode).
    """
    if mode == "deep research":
        return DEEP_RESEARCH_TIMEOUT
    return SEARCH_TIMEOUT

# Endpoints
ENDPOINT_AUTH_SESSION = f"{API_BASE_URL}/api/auth/session"
ENDPOINT_AUTH_SIGNIN = f"{API_BASE_URL}/api/auth/signin/email"
ENDPOINT_SSE_ASK = f"{API_BASE_URL}/rest/sse/perplexity_ask"
ENDPOINT_UPLOAD_URL = f"{API_BASE_URL}/rest/uploads/create_upload_url"
ENDPOINT_SOCKET_IO = f"{API_BASE_URL}/socket.io/"

# Emailnator Configuration
EMAILNATOR_BASE_URL = "https://www.emailnator.com"
EMAILNATOR_GENERATE_ENDPOINT = f"{EMAILNATOR_BASE_URL}/generate-email"
EMAILNATOR_MESSAGE_LIST_ENDPOINT = f"{EMAILNATOR_BASE_URL}/message-list"

# Account Limits
DEFAULT_COPILOT_QUERIES = 5
DEFAULT_FILE_UPLOADS = 10
ACCOUNT_TIMEOUT = 20  # seconds to wait for email

# Search Modes
SEARCH_MODES = ["auto", "pro", "reasoning", "deep research"]
SEARCH_SOURCES = ["web", "scholar", "social"]
SEARCH_LANGUAGES = ["en-US", "en-GB", "pt-BR", "es-ES", "fr-FR", "de-DE", "zh-CN"]

# Model Mappings
MODEL_MAPPINGS: Dict[str, Dict[str, str]] = {
    "auto": {None: "turbo"},
    "pro": {
        None: "pplx_pro",
        "sonar": "experimental",
        "gpt-5.4": "gpt54",
        "claude-4.6-sonnet": "claude46sonnet",
        "gemini-3.1-pro": "gemini31pro_high",
    },
    "reasoning": {
        None: "pplx_reasoning",
        "gpt-5.4-thinking": "gpt54_thinking",
        "claude-4.6-sonnet-thinking": "claude46sonnetthinking",
        "gemini-3.1-pro": "gemini31pro_high",
        "kimi-k2-thinking": "kimik2thinking",
    },
    "deep research": {None: "pplx_alpha"},
}

# Labs Models
LABS_MODELS = [
    "r1-1776",
    "sonar-pro",
    "sonar",
    "sonar-reasoning-pro",
    "sonar-reasoning",
]

# HTTP Headers Template
DEFAULT_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",  # noqa: E501
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "dnt": "1",
    "priority": "u=0, i",
    "sec-ch-ua": '"Not;A=Brand";v="24", "Chromium";v="128"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version": '"128.0.6613.120"',
    "sec-ch-ua-full-version-list": '"Not;A=Brand";v="24.0.0.0", "Chromium";v="128.0.6613.120"',  # noqa: E501
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"19.0.0"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",  # noqa: E501
}

# Emailnator Headers Template
EMAILNATOR_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "dnt": "1",
    "origin": EMAILNATOR_BASE_URL,
    "priority": "u=1, i",
    "referer": f"{EMAILNATOR_BASE_URL}/",
    "sec-ch-ua": '"Not;A=Brand";v="24", "Chromium";v="128"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version": '"128.0.6613.120"',
    "sec-ch-ua-full-version-list": '"Not;A=Brand";v="24.0.0.0", "Chromium";v="128.0.6613.120"',  # noqa: E501
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"19.0.0"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",  # noqa: E501
    "x-requested-with": "XMLHttpRequest",
}

# Allowed file extensions for upload (documents, code, images, audio, video)
ALLOWED_FILE_EXTENSIONS: frozenset = frozenset({
    # Documents
    ".pdf", ".doc", ".docx", ".pptx", ".xlsx", ".csv", ".txt", ".text",
    ".md", ".markdown", ".rmd", ".latex", ".tex",
    # Code & Config
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".cpp",
    ".c", ".cxx", ".h", ".hpp", ".cs", ".rb", ".php", ".pl", ".pm",
    ".swift", ".kt", ".kts", ".scala", ".dart", ".lua", ".r", ".R",
    ".m", ".sh", ".bash", ".zsh", ".fish", ".ksh", ".bat", ".sql",
    ".html", ".htm", ".css", ".less", ".xml", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".conf", ".config", ".in", ".log",
    ".coffee", ".diff", ".ipynb",
    # Images
    ".jpg", ".jpeg", ".jpe", ".jp2", ".png", ".gif", ".bmp",
    ".tiff", ".tif", ".svg", ".webp", ".ico", ".avif", ".heic", ".heif",
    # Audio
    ".mp3", ".wav", ".aiff", ".ogg", ".flac",
    # Video
    ".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp",
})

# Retry Configuration
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_FACTOR = 2
RETRY_EXCEPTIONS = (ConnectionError, TimeoutError)

# Logging Configuration
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_LEVEL = "DEBUG"
LOG_FILE = "perplexity.log"

# Rate Limiting
RATE_LIMIT_MIN_DELAY = 1.0  # seconds
RATE_LIMIT_MAX_DELAY = 3.0  # seconds
RATE_LIMIT_ENABLED = True

# Admin Authentication
# Set this environment variable to enable admin authentication for pool management
# If not set, admin operations will be disabled for security
ADMIN_TOKEN: Optional[str] = os.getenv("PPLX_ADMIN_TOKEN", None)

# Validation Patterns
EMAIL_SUBJECT_PATTERN = "Sign in to Perplexity"
SIGNIN_URL_PATTERN = r'"(https://www\.perplexity\.ai/api/auth/callback/email\?callbackUrl=.*?)"'
