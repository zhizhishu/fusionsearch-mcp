# Importing necessary modules
# re: Regular expressions for pattern matching
# sys: System-specific parameters and functions
# json: JSON parsing and serialization
# random: Random number generation
# mimetypes: Guessing MIME types of files
# uuid: Generating unique identifiers
# curl_cffi: HTTP requests and multipart form data handling
import re
import sys
import json
import time
import random
import logging
import threading
import mimetypes
from uuid import uuid4

# Try importing curl_cffi, but allow it to fail for testing environments
# that mock the requests anyway
try:
    from curl_cffi import CurlMime, requests
except ImportError:
    # Minimal stub for testing if curl_cffi is missing
    class requests:
        class Session:
            def __init__(self, *args, **kwargs): pass
            def get(self, *args, **kwargs): pass
            def post(self, *args, **kwargs): pass

    class CurlMime:
        def __init__(self, *args, **kwargs): pass
        def addpart(self, *args, **kwargs): pass

from .config import (
    DEFAULT_HEADERS,
    ENDPOINT_AUTH_SESSION,
    ENDPOINT_AUTH_SIGNIN,
    ENDPOINT_SSE_ASK,
    ENDPOINT_UPLOAD_URL,
    FILE_UPLOAD_TIMEOUT,
    SOCKS_PROXY,
    MIN_TIMEOUT_SECONDS,
    PERPLEXITY_EXIT_MAX_RETRY,
    PERPLEXITY_EXIT_ATTEMPT_TIMEOUT,
    PERPLEXITY_EXIT_TOTAL_BUDGET,
    build_exit_pool,
    get_search_timeout,
)
from .emailnator import Emailnator

logger = logging.getLogger(__name__)


def _extract_legacy_text_response(response_payload):
    """Normalize the legacy ``text`` step list into top-level answer fields."""
    encoded_text = response_payload.get("text")
    if not isinstance(encoded_text, str) or not encoded_text:
        return

    try:
        parsed_text = json.loads(encoded_text)
    except (json.JSONDecodeError, TypeError):
        return

    response_payload["text"] = parsed_text
    if not isinstance(parsed_text, list):
        return

    for step in parsed_text:
        if not isinstance(step, dict) or step.get("step_type") != "FINAL":
            continue
        encoded_answer = step.get("content", {}).get("answer")
        if not isinstance(encoded_answer, str) or not encoded_answer:
            continue
        try:
            answer_payload = json.loads(encoded_answer)
        except (json.JSONDecodeError, TypeError):
            continue
        response_payload["answer"] = answer_payload.get("answer", "")
        response_payload["chunks"] = answer_payload.get("chunks", [])
        return


def _extract_block_response(response_payload):
    """Normalize the current Perplexity ``blocks`` response shape.

    Perplexity moved final markdown from ``text[].FINAL.content.answer`` to
    ``blocks[].markdown_block.answer``. Search sources likewise moved to
    ``blocks[].web_result_block.web_results``. Keep both formats supported because
    deployments can briefly serve either shape during upstream rollouts.
    """
    blocks = response_payload.get("blocks")
    if not isinstance(blocks, list):
        return

    completed_answers = []
    partial_answers = []
    web_results = []

    for block in blocks:
        if not isinstance(block, dict):
            continue

        markdown_block = block.get("markdown_block")
        if isinstance(markdown_block, dict):
            answer = markdown_block.get("answer")
            if not isinstance(answer, str) or not answer.strip():
                markdown_chunks = markdown_block.get("chunks")
                if isinstance(markdown_chunks, list):
                    answer = "".join(
                        chunk for chunk in markdown_chunks if isinstance(chunk, str)
                    )
            if isinstance(answer, str) and answer.strip():
                if str(markdown_block.get("progress", "")).upper() == "DONE":
                    completed_answers.append(answer)
                else:
                    partial_answers.append(answer)

        web_result_block = block.get("web_result_block")
        if isinstance(web_result_block, dict):
            block_results = web_result_block.get("web_results")
            if isinstance(block_results, list):
                web_results.extend(
                    result for result in block_results if isinstance(result, dict)
                )

    answer_candidates = completed_answers or partial_answers
    if answer_candidates:
        response_payload["answer"] = answer_candidates[-1]
    if web_results:
        response_payload["chunks"] = web_results


def normalize_search_response(response_payload):
    """Return one Perplexity SSE payload with old and new response shapes normalized."""
    if not isinstance(response_payload, dict):
        return response_payload
    _extract_legacy_text_response(response_payload)
    _extract_block_response(response_payload)
    return response_payload


def _has_nonempty_answer(response_payload):
    return isinstance(response_payload, dict) and bool(
        str(response_payload.get("answer") or "").strip()
    )


def _require_nonempty_answer(response_payload):
    if not _has_nonempty_answer(response_payload):
        raise RuntimeError("Perplexity response contained no answer")
    return response_payload


def _parse_sse_message(content):
    """Parse one complete SSE event block and normalize message payloads."""
    normalized_content = content.replace("\r\n", "\n")
    lines = normalized_content.split("\n")
    event_name = next(
        (line[len("event:") :].strip() for line in lines if line.startswith("event:")),
        "",
    )
    if event_name != "message":
        return event_name, None

    data_lines = [
        line[len("data:") :].strip() for line in lines if line.startswith("data:")
    ]
    if not data_lines:
        return event_name, None
    try:
        response_payload = json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        return event_name, None
    return event_name, normalize_search_response(response_payload)


class Client:
    """
    A client for interacting with the Perplexity AI API.
    """

    def __init__(self, cookies={}):
        # Store original cookies for export / session rebuild on exit rotation
        self._cookies = cookies.copy() if cookies else {}

        # resin 出口池：以 SOCKS_PROXY 为模板生成 <prefix>1..N（POOL_SIZE<=1 → 单条，不轮换）。
        # Format: socks5://[user[:pass]@]host[:port][#remark]
        self._exit_pool = build_exit_pool()
        self._exit_idx = 0        # 当前(粘性)出口下标；A方案跨请求持久，命中粘住/失败挪一格
        self._session_idx = 0     # self.session 当前是为哪个出口建的(惰性同步用，见 _ensure_session)
        # 串行化本 Client 的出口池查询：Client 被 ClientPool 跨线程共享(asyncio.to_thread)，
        # search_resilient 会在请求中途换 self.session/_exit_idx，无锁会被并发请求踩。
        # 单登录账号本也不该并发打(rate/风控)，串行既修 bug 又更对。
        self._exit_lock = threading.Lock()
        proxy_url = self._exit_pool[self._exit_idx] if self._exit_pool else None
        if proxy_url:
            logger.debug(
                "Client proxy configured: %s (exit-pool=%d)",
                proxy_url.split("@")[-1], len(self._exit_pool),
            )
        else:
            logger.debug("Client proxy not configured, using direct connection")

        # Initialize an HTTP session with default headers and optional cookies
        self.session = self._build_session(proxy_url)
        logger.debug(
            "Client session initialized (impersonate=chrome, proxy=%s)",
            "enabled" if proxy_url else "disabled",
        )

        # Flags and counters for account and query management
        self.own = bool(cookies)  # Indicates if the client uses its own account
        self.copilot = 0 if not cookies else float("inf")  # Remaining pro queries
        self.file_upload = 0 if not cookies else float("inf")  # Remaining file uploads

        # Regular expression for extracting sign-in links
        self.signin_regex = re.compile(
            r'"(https://www\\.perplexity\\.ai/api/auth/callback/email\\?' r'callbackUrl=.*?)"'
        )

        # Unique timestamp for session identification
        self.timestamp = format(random.getrandbits(32), "08x")

        # Initialize session by making a GET request
        logger.debug("Client initializing auth session via %s", ENDPOINT_AUTH_SESSION)
        self.session.get(ENDPOINT_AUTH_SESSION, timeout=30)

    def _build_session(self, proxy_url):
        """Create a fresh curl_cffi session (same cookies + chrome impersonation) on the given proxy."""
        return requests.Session(
            headers=DEFAULT_HEADERS.copy(),
            cookies=self._cookies,
            impersonate="chrome",
            proxy=proxy_url,
        )

    def _ensure_session(self) -> None:
        """惰性把 self.session 同步到当前 self._exit_idx。

        A方案跨请求粘性游走：失败时只挪 self._exit_idx(便宜)，session 不立刻重建；
        下次真要用这个出口时(本请求下一发 or 下一个请求首发)才在这里重建+暖场。
        好处：命中的出口 session 一直复用(粘住)；失败挪格不产生"末尾白暖场"浪费。
        """
        if self._session_idx == self._exit_idx and self.session is not None:
            return
        self.session = self._build_session(self._exit_pool[self._exit_idx])
        self._session_idx = self._exit_idx
        # 新出口=新 IP，旧 cf_clearance 失效；暖一次 auth session 让 CF 重新放行（best-effort，算进 deadline）。
        try:
            self.session.get(ENDPOINT_AUTH_SESSION, timeout=10)
        except Exception:
            pass

    def search_resilient(self, query, mode="auto", model=None, sources=["web"],
                         files={}, stream=False, language="en-US", follow_up=None,
                         incognito=False, timeout=None, file_upload_timeout=None):
        """search() 的出口自愈包装（A方案·跨请求粘性游走）。

        核心思路：好出口稀有、只有真查询验得出、探测=多IP有封号风险，所以：
        - **不在一发里穷举**：每发只试少量出口(受 TOTAL_BUDGET 封顶，卡进调用方 abort 内)、快速失败。
        - **失败只挪指针**(self._exit_idx，便宜)，session 惰性重建(_ensure_session)；指针**跨请求持久**，
          下一发从上次停的地方**继续走**，一格格走遍池子直到命中。
        - **命中即死死粘住**(idx 不动、session 复用)，之后所有查询都走这个好出口；它挂了才继续走。
        - 用户真实查询本身就是探针：不额外多IP、不额外烧额度(失败的查询本就会失败)。

        其它：透传(池<=1/stream/带files) / 全程持锁(跨线程共享) / AssertionError 直接抛 /
        单次超时 min(剩余, ATTEMPT_TIMEOUT)(good 实测~6s、设 15s 足够且坏出口快弃) / 判据=不抛且非空即成功。
        """
        pool_n = len(self._exit_pool)
        # 透传(不游走)：无池 / stream(生成器不便重试) / 带 files(重试会重复上传+扣额度)。
        if pool_n <= 1 or stream or files:
            return self.search(
                query, mode=mode, model=model, sources=sources, files=files,
                stream=stream, language=language, follow_up=follow_up,
                incognito=incognito, timeout=timeout, file_upload_timeout=file_upload_timeout,
            )

        # 全程持锁：Client 跨线程共享，游走会换 self.session/_exit_idx，串行防并发踩(见 __init__)。
        with self._exit_lock:
            attempts = min(PERPLEXITY_EXIT_MAX_RETRY, pool_n)
            floor = MIN_TIMEOUT_SECONDS
            budget = timeout if (timeout and timeout > 0) else get_search_timeout(mode)
            # 非 deep：把本发总预算封顶到 TOTAL_BUDGET(~50s，卡进调用方 ~60s abort 内；
            # get_search_timeout 默认 300 远大于真实 abort，不封顶会一发试太久超调用方预算)。
            if mode != "deep research":
                budget = min(budget, PERPLEXITY_EXIT_TOTAL_BUDGET)
            budget = max(budget, floor)  # 兜底保证至少能起一次尝试(否则 last_err=None)
            deadline = time.monotonic() + budget
            last_err = None
            for i in range(attempts):
                remaining = deadline - time.monotonic()
                if remaining < floor:
                    break
                self._ensure_session()  # 把 session 同步到当前(可能上一发/上一次挪过的)出口
                # deep research 天生慢→给满剩余；其余按 ATTEMPT_TIMEOUT 卡短(坏出口快弃)，但不超剩余。
                per_attempt = remaining if mode == "deep research" else min(remaining, PERPLEXITY_EXIT_ATTEMPT_TIMEOUT)
                try:
                    res = self.search(
                        query, mode=mode, model=model, sources=sources, files=files,
                        stream=False, language=language, follow_up=follow_up,
                        incognito=incognito, timeout=per_attempt,
                        file_upload_timeout=file_upload_timeout,
                    )
                    if _has_nonempty_answer(res):
                        if i > 0:
                            logger.info("perplexity: 游走命中好出口 idx=%d/%d，粘住", self._exit_idx, pool_n)
                        return res  # 好出口 → 粘住(idx 不动、session 复用)
                    last_err = "response contained no answer"
                except AssertionError:
                    raise
                except Exception as exc:
                    last_err = exc
                # 失败 → 挪到下一个出口(仅挪指针，session 惰性重建；指针跨请求持久，下一发继续走)。
                self._exit_idx = (self._exit_idx + 1) % pool_n
                logger.warning("perplexity: 出口失败，走到 idx=%d/%d (因: %s)",
                               self._exit_idx, pool_n, str(last_err)[:100])

            if isinstance(last_err, Exception):
                raise last_err
            raise RuntimeError(f"perplexity 出口池游走尝试均失败(idx 现停在 {self._exit_idx}): {last_err}")

    @property
    def cookies(self) -> dict:
        """
        Get the current cookies from the session.
        """
        if hasattr(self.session, "cookies") and hasattr(self.session.cookies, "get_dict"):
            return self.session.cookies.get_dict()
        return self._cookies

    def get_user_info(self) -> dict:
        """
        Get user session information from the auth session endpoint.

        Returns:
            dict: User session info including user details if logged in,
                  or empty dict if anonymous/not logged in.
        """
        try:
            resp = self.session.get(ENDPOINT_AUTH_SESSION, timeout=30)
            if resp.ok:
                return resp.json()
            return {}
        except Exception:
            return {}

    def create_account(self, cookies):
        """
        Creates a new account using Emailnator cookies.
        """
        while True:
            try:
                # Initialize Emailnator client
                emailnator_cli = Emailnator(cookies)

                # Send a POST request to initiate account creation
                resp = self.session.post(
                    ENDPOINT_AUTH_SIGNIN,
                    data={
                        "email": emailnator_cli.email,
                        "csrfToken": self.session.cookies.get_dict()["next-auth.csrf-token"].split(
                            "%"
                        )[0],
                        "callbackUrl": "https://www.perplexity.ai/",
                        "json": "true",
                    },
                    timeout=30,
                )

                # Check if the response is successful
                if resp.ok:
                    # Wait for the sign-in email to arrive
                    new_msgs = emailnator_cli.reload(
                        wait_for=lambda x: x["subject"] == "Sign in to Perplexity",
                        timeout=20,
                    )

                    if new_msgs:
                        break
                else:
                    print("Perplexity account creating error:", resp)

            except Exception:
                pass

        # Extract the sign-in link from the email
        msg = emailnator_cli.get(func=lambda x: x["subject"] == "Sign in to Perplexity")
        new_account_link = self.signin_regex.search(emailnator_cli.open(msg["messageID"])).group(1)

        # Complete the account creation process
        self.session.get(new_account_link)

        # Update query and file upload limits
        self.copilot = 5
        self.file_upload = 10

        return True

    def search(
        self,
        query,
        mode="auto",
        model=None,
        sources=["web"],
        files={},
        stream=False,
        language="en-US",
        follow_up=None,
        incognito=False,
        timeout=None,
        file_upload_timeout=None,
    ):
        """
        Executes a search query on Perplexity AI.

        Parameters:
        - query: The search query string.
        - mode: Search mode ('auto', 'pro', 'reasoning', 'deep research').
        - model: Specific model to use for the query.
        - sources: List of sources ('web', 'scholar', 'social').
        - files: Dictionary of files to upload.
        - stream: Whether to stream the response.
        - language: Language code (ISO 639).
        - follow_up: Information for follow-up queries.
        - incognito: Whether to enable incognito mode.
        """
        # Validate input parameters
        assert mode in [
            "auto",
            "pro",
            "reasoning",
            "deep research",
        ], "Invalid search mode."
        assert (
            model
            in {
                "auto": [None],
                "pro": [
                    None,
                    "sonar",
                    "gpt-5.4",
                    "claude-4.6-sonnet",
                    "gemini-3.1-pro",
                ],
                "reasoning": [
                    None,
                    "gpt-5.4-thinking",
                    "claude-4.6-sonnet-thinking",
                    "gemini-3.1-pro",
                    "kimi-k2-thinking",
                ],
                "deep research": [None],
            }[mode]
            if self.own
            else True
        ), "Invalid model for the selected mode."
        assert all(
            [source in ("web", "scholar", "social") for source in sources]
        ), "Invalid sources."
        assert (
            self.copilot > 0 if mode in ["pro", "reasoning", "deep research"] else True
        ), "No remaining pro queries."
        assert self.file_upload - len(files) >= 0 if files else True, "File upload limit exceeded."

        # Update query and file upload counters
        self.copilot = (
            self.copilot - 1 if mode in ["pro", "reasoning", "deep research"] else self.copilot
        )
        self.file_upload = self.file_upload - len(files) if files else self.file_upload

        # Upload files and prepare the query payload
        uploaded_files = []
        for filename, file in files.items():
            file_type = mimetypes.guess_type(filename)[0]
            file_upload_info = (
                self.session.post(
                    ENDPOINT_UPLOAD_URL,
                    params={"version": "2.18", "source": "default"},
                    json={
                        "content_type": file_type,
                        "file_size": sys.getsizeof(file),
                        "filename": filename,
                        "force_image": False,
                        "source": "default",
                    },
                    timeout=30,
                )
            ).json()

            # Upload the file to the server
            mp = CurlMime()
            for key, value in file_upload_info["fields"].items():
                mp.addpart(name=key, data=value)
            mp.addpart(
                name="file",
                content_type=file_type,
                filename=filename,
                data=file,
            )

            upload_timeout = file_upload_timeout if file_upload_timeout and file_upload_timeout > 0 else FILE_UPLOAD_TIMEOUT
            upload_resp = self.session.post(file_upload_info["s3_bucket_url"], multipart=mp, timeout=upload_timeout)

            if not upload_resp.ok:
                raise Exception("File upload error", upload_resp)

            # Extract the uploaded file URL
            if "image/upload" in file_upload_info["s3_object_url"]:
                uploaded_url = re.sub(
                    r"/private/s--.*?--/v\\d+/user_uploads/",
                    "/private/user_uploads/",
                    upload_resp.json()["secure_url"],
                )
            else:
                uploaded_url = file_upload_info["s3_object_url"]

            uploaded_files.append(uploaded_url)

        # Prepare the JSON payload for the query
        json_data = {
            "query_str": query,
            "params": {
                "attachments": (
                    uploaded_files + follow_up["attachments"] if follow_up else uploaded_files
                ),
                "frontend_context_uuid": str(uuid4()),
                "frontend_uuid": str(uuid4()),
                "is_incognito": incognito,
                "language": language,
                "last_backend_uuid": (follow_up["backend_uuid"] if follow_up else None),
                "mode": "concise" if mode == "auto" else "copilot",
                "model_preference": {
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
                }[mode][model],
                "source": "default",
                "sources": sources,
                "version": "2.18",
            },
        }

        # Send the query request and handle the response
        # 不同模式耗时差异巨大（deep research 经常需要数分钟）。
        # 优先使用调用方显式传入的 timeout（由 ClientPool 注入），否则按 mode 兜底。
        request_timeout = timeout if timeout and timeout > 0 else get_search_timeout(mode)
        resp = self.session.post(ENDPOINT_SSE_ASK, json=json_data, stream=True, timeout=request_timeout)
        chunks = []

        def stream_response(resp):
            """
            Generator for streaming responses.
            """
            for chunk in resp.iter_lines(delimiter=b"\r\n\r\n"):
                content = chunk.decode("utf-8")
                event_name, response_payload = _parse_sse_message(content)
                if event_name == "message" and response_payload is not None:
                    chunks.append(response_payload)
                    yield response_payload
                elif event_name == "end_of_stream":
                    return

        if stream:
            return stream_response(resp)

        latest_response = {}
        latest_answer_response = None
        latest_sources = []
        for chunk in resp.iter_lines(delimiter=b"\r\n\r\n"):
            content = chunk.decode("utf-8")
            event_name, response_payload = _parse_sse_message(content)
            if event_name == "message" and response_payload is not None:
                chunks.append(response_payload)
                latest_response = response_payload
                response_sources = response_payload.get("chunks")
                if isinstance(response_sources, list) and response_sources:
                    latest_sources = response_sources
                    if latest_answer_response is not None:
                        latest_answer_response["chunks"] = latest_sources
                if _has_nonempty_answer(response_payload):
                    if latest_sources and not response_payload.get("chunks"):
                        response_payload["chunks"] = latest_sources
                    latest_answer_response = response_payload
            elif event_name == "end_of_stream":
                return _require_nonempty_answer(latest_answer_response or latest_response)

        return _require_nonempty_answer(latest_answer_response or latest_response)
