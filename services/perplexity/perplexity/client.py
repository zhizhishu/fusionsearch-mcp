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
    build_exit_pool,
    get_search_timeout,
)
from .emailnator import Emailnator

logger = logging.getLogger(__name__)


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
        self._exit_idx = 0
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

    def _rotate_exit(self) -> bool:
        """Switch to the next resin exit in the pool (rebuild session + warm CF on new IP).

        Returns False when there is nothing to rotate (pool size <= 1).
        """
        if len(self._exit_pool) <= 1:
            return False
        self._exit_idx = (self._exit_idx + 1) % len(self._exit_pool)
        self.session = self._build_session(self._exit_pool[self._exit_idx])
        # 新出口=新 IP，旧 cf_clearance 失效；暖一次 auth session 让 CF 重新放行（best-effort）。
        # 超时收窄到 10s：暖场也算进 search_resilient 的 deadline 预算，别让它把总时长撑爆。
        try:
            self.session.get(ENDPOINT_AUTH_SESSION, timeout=10)
        except Exception:
            pass
        return True

    def search_resilient(self, query, mode="auto", model=None, sources=["web"],
                         files={}, stream=False, language="en-US", follow_up=None,
                         incognito=False, timeout=None, file_upload_timeout=None):
        """search() 的出口自愈包装：某个 resin 出口查询失败/超时就换下一个重试（最多 MAX_RETRY 次）。

        - 透传(不轮换)：出口池<=1 / stream(生成器不便重试) / 带 files(重试会重复上传+扣额度) → 直接单发 search()，行为与旧版一致。
        - 全程持 self._exit_lock：Client 跨线程共享，串行防并发换 session 互踩(单账号本也不该并发查)。
        - deadline 卡总时长：所有重试+换出口暖场都算进调用方 budget，绝不超预算(治 deep research×K)。
        - 每次尝试用较小超时(min(剩余, ATTEMPT_TIMEOUT))，坏出口快弃、好出口够答；命中即粘住当前出口。
        - 判据对齐 run_query：search() 不抛且返回非空=成功；抛异常/空返回=换出口再试。
        - AssertionError（输入/额度类）不换出口、直接抛。全试完仍败 → 抛最后错误（交池级处理/降级）。
        """
        pool_n = len(self._exit_pool)
        # 透传(不轮换)：无池 / stream(生成器不便重试) / 带 files(重试会重复上传+扣额度)。
        if pool_n <= 1 or stream or files:
            return self.search(
                query, mode=mode, model=model, sources=sources, files=files,
                stream=stream, language=language, follow_up=follow_up,
                incognito=incognito, timeout=timeout, file_upload_timeout=file_upload_timeout,
            )

        # 全程持锁：Client 跨线程共享，轮换会换 self.session/_exit_idx，串行防并发踩(见 __init__)。
        with self._exit_lock:
            attempts = min(PERPLEXITY_EXIT_MAX_RETRY, pool_n)
            floor = MIN_TIMEOUT_SECONDS  # 剩余不足一次最小尝试就停，不硬起一发必超时的尝试
            budget = timeout if (timeout and timeout > 0) else get_search_timeout(mode)
            budget = max(budget, floor)  # 调用方给的 < 系统下限时兜底，保证至少能起一次尝试(否则 last_err=None)
            # deadline 卡总时长(soft cap)：K 次重试 + 换出口暖场都算进 budget，不再发起超预算的新尝试
            # (治 deep research×K 灾难；正在跑的 search 不硬 kill，故墙钟可能略超一次 per_attempt)。
            deadline = time.monotonic() + budget
            last_err = None
            for i in range(attempts):
                remaining = deadline - time.monotonic()
                if remaining < floor:
                    break
                # deep research 天生慢→给满剩余；其余按 ATTEMPT_TIMEOUT 卡短(坏出口快弃)，但不超剩余。
                per_attempt = remaining if mode == "deep research" else min(remaining, PERPLEXITY_EXIT_ATTEMPT_TIMEOUT)
                try:
                    res = self.search(
                        query, mode=mode, model=model, sources=sources, files=files,
                        stream=False, language=language, follow_up=follow_up,
                        incognito=incognito, timeout=per_attempt,
                        file_upload_timeout=file_upload_timeout,
                    )
                    if res:
                        if i > 0:
                            logger.info(
                                "perplexity: exit-pool 第 %d 次重试命中 (exit idx=%d/%d)",
                                i, self._exit_idx, pool_n,
                            )
                        return res  # 好出口 → 粘住(下次仍从此出口起)
                    last_err = "empty response"
                except AssertionError:
                    raise
                except Exception as exc:
                    last_err = exc
                # 还有下一发且预算够(暖场也吃时间)才换出口
                if i < attempts - 1 and (deadline - time.monotonic()) >= floor:
                    if not self._rotate_exit():
                        break
                    logger.warning(
                        "perplexity: 换出口 -> idx=%d/%d 重试 (因: %s)",
                        self._exit_idx, pool_n, str(last_err)[:120],
                    )
                else:
                    break

            if isinstance(last_err, Exception):
                raise last_err
            raise RuntimeError(f"perplexity exit-pool 出口池尝试均失败: {last_err}")

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

                if content.startswith("event: message\r\n"):
                    try:
                        content_json = json.loads(content[len("event: message\r\ndata: ") :])

                        # Parse the nested 'text' field if it exists
                        if "text" in content_json and content_json["text"]:
                            try:
                                text_parsed = json.loads(content_json["text"])
                                # Extract answer from FINAL step if available
                                if isinstance(text_parsed, list):
                                    for step in text_parsed:
                                        if step.get("step_type") == "FINAL":
                                            final_content = step.get("content", {})
                                            if "answer" in final_content:
                                                answer_data = json.loads(final_content["answer"])
                                                content_json["answer"] = answer_data.get(
                                                    "answer", ""
                                                )
                                                content_json["chunks"] = answer_data.get(
                                                    "chunks", []
                                                )
                                                break
                                content_json["text"] = text_parsed
                            except (json.JSONDecodeError, TypeError, KeyError):
                                pass

                        chunks.append(content_json)
                        yield chunks[-1]
                    except (json.JSONDecodeError, KeyError):
                        continue

                elif content.startswith("event: end_of_stream\r\n"):
                    return

        if stream:
            return stream_response(resp)

        for chunk in resp.iter_lines(delimiter=b"\r\n\r\n"):
            content = chunk.decode("utf-8")

            if content.startswith("event: message\r\n"):
                try:
                    content_json = json.loads(content[len("event: message\r\ndata: ") :])

                    # Parse the nested 'text' field if it exists
                    if "text" in content_json and content_json["text"]:
                        try:
                            text_parsed = json.loads(content_json["text"])
                            # Extract answer from FINAL step if available
                            if isinstance(text_parsed, list):
                                for step in text_parsed:
                                    if step.get("step_type") == "FINAL":
                                        final_content = step.get("content", {})
                                        if "answer" in final_content:
                                            answer_data = json.loads(final_content["answer"])
                                            content_json["answer"] = answer_data.get("answer", "")
                                            content_json["chunks"] = answer_data.get("chunks", [])
                                            break
                            content_json["text"] = text_parsed
                        except (json.JSONDecodeError, TypeError, KeyError):
                            pass

                    chunks.append(content_json)
                except (json.JSONDecodeError, KeyError):
                    continue

            elif content.startswith("event: end_of_stream\r\n"):
                return chunks[-1] if chunks else {}
