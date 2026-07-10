import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.config import settings

DEFAULT_BASE_URL = "https://search.sh/api/search"

# search.sh 免费层是 5 次/天/IP：某出口撞 429 就冷却到当天配额重置（约到次日 UTC 0 点）。
_NODE_FAIL_COOLDOWN = 300.0   # 死/坏出口(502/连接失败)短冷却，节点可能自愈
_RETRY_BACKOFF = 0.4          # 失败切换之间的小退避
_MAX_ATTEMPTS = 6             # 单次请求最多切几个出口，兜住延迟
_PROXY_ERROR_MARKERS = ("upstream request failed", "proxy authentication failed", "bad gateway")
# 出口超时调优：连接 8s / 读 20s 快速判死；连上但 18s 不出内容当慢节点切走。
_HTTP_TIMEOUT = httpx.Timeout(connect=8.0, read=20.0, write=10.0, pool=8.0)
_FIRST_TOKEN_DEADLINE = 18.0


def _parse_multivalue(raw: str) -> List[str]:
    """按换行和 ||| 分隔，strip 并丢空。"""
    parts: List[str] = []
    for line in (raw or "").split("\n"):
        for part in line.split("|||"):
            stripped = part.strip()
            if stripped:
                parts.append(stripped)
    return parts


def _seconds_to_utc_reset() -> float:
    """距下一个 UTC 0 点的秒数（免费层按天重置的保守冷却时长）。"""
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(60.0, (tomorrow - now).total_seconds())


class SearchProvider:
    MODEL_NAME = "search-sh-ai"
    DEFAULT_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    )

    # 跨实例共享的轮询状态（asyncio 单线程，无需锁）
    _next_index: int = 0
    _cooldowns: Dict[str, float] = {}  # 轮换值 -> monotonic 冷却截止

    def __init__(self):
        self.base_url = (settings.SEARCH_SH_BASE_URL or "").strip() or DEFAULT_BASE_URL
        self.rotate_header = (settings.SEARCH_SH_ROTATE_HEADER or "").strip()

        values = _parse_multivalue(settings.SEARCH_SH_ROTATE_VALUES or "")
        if not values and self.rotate_header:
            try:
                count = int(settings.SEARCH_SH_ROTATE_COUNT or 0)
            except (TypeError, ValueError):
                count = 0
            if count > 0:
                values = [f"r{i}" for i in range(1, count + 1)]
        # [""] 表示不轮换（单次直连），仍复用同一套失败处理逻辑
        self.rotate_values: List[str] = values or [""]

        ua_parts = _parse_multivalue(settings.SEARCH_SH_USER_AGENT or "")
        self.user_agent = ua_parts[0] if ua_parts else self.DEFAULT_USER_AGENT

        self.base_headers = {
            "Accept": "*/*",
            "Accept-Language": "en,zh-CN;q=0.9",
            "Content-Type": "application/json",
            "Origin": "https://search.sh",
            "Referer": "https://search.sh/",
            "User-Agent": self.user_agent,
        }
        cookie = (settings.SEARCH_SH_COOKIE or "").strip()
        if cookie:
            self.base_headers["Cookie"] = cookie

    async def handle_chat_completion(self, request_data: Dict[str, Any]) -> StreamingResponse | JSONResponse:
        if request_data.get("stream", False):
            return StreamingResponse(self._stream_generator(request_data), media_type="text/event-stream")
        return await self._non_stream_generator(request_data)

    async def handle_list_models(self) -> JSONResponse:
        return JSONResponse(
            content={
                "object": "list",
                "data": [
                    {
                        "id": self.MODEL_NAME,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "search.sh",
                    }
                ],
            }
        )

    async def _stream_generator(self, payload: dict) -> AsyncGenerator[str, None]:
        chat_id = f"chatcmpl-{uuid.uuid4().hex}"
        role_sent = False
        try:
            async for data_piece in self._get_response_stream(payload):
                if data_piece["type"] == "status":
                    chunk = self._create_openai_chunk(chat_id, f"**`{data_piece['content']}`**\n\n")
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    continue

                if data_piece["type"] == "content":
                    if not role_sent:
                        yield f"data: {json.dumps(self._create_openai_chunk(chat_id, None, role='assistant'), ensure_ascii=False)}\n\n"
                        role_sent = True
                    chunk = self._create_openai_chunk(chat_id, data_piece["content"])
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        except Exception as exc:
            error_chunk = self._create_error_chunk(chat_id, str(exc))
            yield f"data: {json.dumps(error_chunk, ensure_ascii=False)}\n\n"
        finally:
            final_chunk = self._create_openai_chunk(chat_id, None, finish_reason="stop")
            yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
            yield "data:\n\n"

    async def _non_stream_generator(self, payload: dict) -> JSONResponse:
        full_response = ""
        try:
            async for data_piece in self._get_response_stream(payload):
                if data_piece["type"] == "content":
                    full_response += data_piece["content"]
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Error processing non-streamed request: {exc}") from exc

        return JSONResponse(
            content={
                "id": f"chatcmpl-{uuid.uuid4().hex}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": self.MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": full_response},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": len(full_response),
                    "total_tokens": len(full_response),
                },
            }
        )

    def _candidate_indices(self) -> List[int]:
        """轮询起点 + 跳过冷却中的出口，返回本次可试的顺序索引。"""
        n = len(self.rotate_values)
        now = time.monotonic()
        start = SearchProvider._next_index % n
        SearchProvider._next_index = (start + 1) % n
        return [
            (start + offset) % n
            for offset in range(n)
            if SearchProvider._cooldowns.get(self.rotate_values[(start + offset) % n], 0.0) <= now
        ]

    def _cooldown(self, value: str, seconds: float) -> None:
        SearchProvider._cooldowns[value] = time.monotonic() + seconds

    async def _get_response_stream(self, payload: dict) -> AsyncGenerator[Dict[str, Any], None]:
        request_body = {
            "query": self._extract_query(payload),
            "currentDate": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

        candidates = self._candidate_indices()
        if not candidates:
            soonest = min(SearchProvider._cooldowns.values(), default=time.monotonic()) - time.monotonic()
            raise RuntimeError(
                f"All {len(self.rotate_values)} search.sh exit(s) are cooling down "
                f"(rate-limited or unavailable). Retry in ~{max(0.0, soonest):.0f}s."
            )

        last_err: Optional[str] = None
        for idx in candidates[:_MAX_ATTEMPTS]:
            value = self.rotate_values[idx]
            headers = dict(self.base_headers)
            if self.rotate_header and value:
                headers[self.rotate_header] = value

            yielded = False  # 该出口一旦吐过内容就不再中途切换，避免与下个出口内容串味
            try:
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                    async with client.stream("POST", self.base_url, headers=headers, json=request_body) as response:
                        status = response.status_code

                        if status == 429:  # search.sh 免费层当天 5 次用完 -> 冷却到次日重置
                            self._cooldown(value, _seconds_to_utc_reset())
                            last_err = f"exit {value or 'direct'}: 429 free-tier daily limit"
                            await asyncio.sleep(_RETRY_BACKOFF)
                            continue

                        if status in (403, 502, 503, 504):  # 坏出口 / 被拦 / 代理 upstream 挂
                            self._cooldown(value, _NODE_FAIL_COOLDOWN)
                            last_err = f"exit {value or 'direct'}: HTTP {status}"
                            await asyncio.sleep(_RETRY_BACKOFF)
                            continue

                        response.raise_for_status()  # 其它非 2xx 直接冒泡

                        # 2xx：先看首行是否是 resin 明文错误，再进正常 SSE 解析
                        node_failed = False
                        checked_first = False
                        last_answer = ""
                        started = time.monotonic()
                        async for line in response.aiter_lines():
                            if not yielded and (time.monotonic() - started) > _FIRST_TOKEN_DEADLINE:
                                node_failed = True
                                break
                            if not line:
                                continue
                            if not checked_first:
                                checked_first = True
                                low = line.strip().lower()
                                if any(mark in low for mark in _PROXY_ERROR_MARKERS):
                                    node_failed = True
                                    break
                            try:
                                data_json = json.loads(line)
                            except json.JSONDecodeError:
                                continue

                            if "progressText" in data_json:
                                yield {"type": "status", "content": data_json["progressText"]}

                            if "summary" in data_json:
                                token = data_json["summary"]
                                if token:
                                    yielded = True
                                    yield {"type": "content", "content": token}

                            if "answer" in data_json:
                                answer = data_json["answer"]
                                if isinstance(answer, str) and answer:
                                    delta = answer[len(last_answer):] if answer.startswith(last_answer) else answer
                                    last_answer = answer
                                    if delta:
                                        yielded = True
                                        yield {"type": "content", "content": delta}

                        if node_failed:
                            self._cooldown(value, _NODE_FAIL_COOLDOWN)
                            last_err = f"exit {value or 'direct'}: proxy upstream failed"
                            await asyncio.sleep(_RETRY_BACKOFF)
                            continue
                        return  # 成功读完

            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                self._cooldown(value, _seconds_to_utc_reset() if code == 429 else _NODE_FAIL_COOLDOWN)
                last_err = f"exit {value or 'direct'}: HTTP {code}"
                await asyncio.sleep(_RETRY_BACKOFF)
                continue
            except httpx.RequestError as exc:  # 连不上 resin / 出口超时
                if yielded:  # 已吐过内容，再切会串味 -> 就此收尾，交上游用已得内容
                    return
                self._cooldown(value, _NODE_FAIL_COOLDOWN)
                last_err = f"exit {value or 'direct'}: {type(exc).__name__}"
                await asyncio.sleep(_RETRY_BACKOFF)
                continue

        raise RuntimeError(
            f"All tried search.sh exits failed (rate-limited or unavailable). Last: {last_err}"
        )

    def _extract_query(self, payload: dict) -> str:
        messages = payload.get("messages", [])
        if not messages:
            raise HTTPException(status_code=400, detail="No messages found in payload")
        last_user_message = next((msg["content"] for msg in reversed(messages) if msg.get("role") == "user"), None)
        if not last_user_message:
            raise HTTPException(status_code=400, detail="No user message found in payload")
        return last_user_message

    def _create_openai_chunk(self, chat_id: str, content: str = None, role: str = None, finish_reason: str = None) -> dict:
        delta = {}
        if role:
            delta["role"] = role
        if content:
            delta["content"] = content
        return {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": self.MODEL_NAME,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }

    def _create_error_chunk(self, chat_id: str, message: str) -> dict:
        return {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": self.MODEL_NAME,
            "choices": [{"index": 0, "delta": {"content": f"An error occurred: {message}"}, "finish_reason": "error"}],
        }
