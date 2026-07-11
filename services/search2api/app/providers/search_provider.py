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
#
# resin 出口池是异质的：同一 token 下不同 X-Resin-Account 落到不同出口 IP(Oracle/印度/台湾住宅…)，
# 有的快(~9s)、有的慢(~25s)、有的坏(proxy upstream failed / 502)。串行盲选 r1..rN 很容易整批撞坏
# 导致失败或超时。这里改用【并发竞速】：每批同时打 _RACE_WIDTH 个出口，用第一个成功返回答案的、
# 取消其余——只要一批里有一个好出口就成，且延迟取最快，把慢/坏节点对冲掉。
_NODE_FAIL_COOLDOWN = 300.0   # 坏出口(502/proxy-error/连接失败)冷却，避免短期反复撞同一个
_RACE_WIDTH = 3               # 维持在飞的出口并发数：同时试 N 个，用最先成功的一个
_MAX_ATTEMPTS = 12            # 单次请求最多动用几个出口(滚动补位，兜配额用尽/坏出口)
_PROXY_ERROR_MARKERS = ("upstream request failed", "proxy authentication failed", "bad gateway")
# 出口超时：connect 8s 连不上快切；read 28s 容忍 search.sh 深搜(正常 8~25s 出答案)；
# TOTAL 44s 全局封顶(配合 node 45s admin / 60s smart_research 硬超时留余量)。
_HTTP_TIMEOUT = httpx.Timeout(connect=8.0, read=28.0, write=10.0, pool=8.0)
_TOTAL_DEADLINE = 44.0


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


class _ExitError(Exception):
    """单个出口尝试失败（可切换/竞速到下一个）。"""


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

    async def _fetch_one(self, idx: int, request_body: dict) -> str:
        """向单个出口发一次完整请求，成功返回答案文本；失败(429/5xx/proxy-error/超时/空)抛 _ExitError。

        竞速用：读到完整答案才算成功，中途被 cancel 时 async with 会关连接、不留悬挂。
        """
        value = self.rotate_values[idx]
        headers = dict(self.base_headers)
        if self.rotate_header and value:
            headers[self.rotate_header] = value

        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                async with client.stream("POST", self.base_url, headers=headers, json=request_body) as response:
                    status = response.status_code
                    if status == 429:  # 免费层当天 5 次用完 -> 冷却到次日重置
                        self._cooldown(value, _seconds_to_utc_reset())
                        raise _ExitError(f"exit {value or 'direct'}: 429 free-tier daily limit")
                    if status in (403, 502, 503, 504):  # 坏出口 / 被拦 / 代理 upstream 挂
                        self._cooldown(value, _NODE_FAIL_COOLDOWN)
                        raise _ExitError(f"exit {value or 'direct'}: HTTP {status}")
                    response.raise_for_status()

                    parts: List[str] = []
                    last_answer = ""
                    checked_first = False
                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        if not checked_first:
                            checked_first = True
                            if any(mark in line.strip().lower() for mark in _PROXY_ERROR_MARKERS):
                                self._cooldown(value, _NODE_FAIL_COOLDOWN)
                                raise _ExitError(f"exit {value or 'direct'}: proxy upstream failed")
                        try:
                            data_json = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        summary = data_json.get("summary")
                        if summary:
                            parts.append(summary)

                        answer = data_json.get("answer")
                        if isinstance(answer, str) and answer:
                            delta = answer[len(last_answer):] if answer.startswith(last_answer) else answer
                            last_answer = answer
                            if delta:
                                parts.append(delta)

                    text = "".join(parts).strip()
                    if not text:
                        self._cooldown(value, _NODE_FAIL_COOLDOWN)
                        raise _ExitError(f"exit {value or 'direct'}: empty response")
                    return text

        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            self._cooldown(value, _seconds_to_utc_reset() if code == 429 else _NODE_FAIL_COOLDOWN)
            raise _ExitError(f"exit {value or 'direct'}: HTTP {code}")
        except httpx.RequestError as exc:  # 连不上 resin / 出口读超时
            self._cooldown(value, _NODE_FAIL_COOLDOWN)
            raise _ExitError(f"exit {value or 'direct'}: {type(exc).__name__}")

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

        candidates = candidates[:_MAX_ATTEMPTS]
        req_start = time.monotonic()
        last_err = "unknown"

        # 滚动补位竞速：维持 _RACE_WIDTH 个出口在飞，任一失败(429/502 都是 1-7s 快速返回)就
        # 立即补一个新出口进来，用第一个成功返回答案的、取消其余。比"整批等完再换批"更快摸到
        # 好出口——坏出口秒换、慢出口不阻塞后来者。全局 _TOTAL_DEADLINE 严格封顶。
        in_flight: Dict[Any, int] = {}   # task -> 出口 idx
        next_pos = 0

        def _launch():
            nonlocal next_pos
            while len(in_flight) < _RACE_WIDTH and next_pos < len(candidates):
                idx = candidates[next_pos]
                next_pos += 1
                in_flight[asyncio.create_task(self._fetch_one(idx, request_body))] = idx

        _launch()
        winner: Optional[str] = None
        try:
            while in_flight:
                remaining = _TOTAL_DEADLINE - (time.monotonic() - req_start)
                if remaining <= 0:
                    break
                done, _pending = await asyncio.wait(
                    set(in_flight), timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                )
                if not done:  # 撞到全局时间预算
                    break
                for finished in done:
                    in_flight.pop(finished, None)
                    try:
                        winner = finished.result()
                        break
                    except _ExitError as exc:
                        last_err = str(exc)
                    except Exception as exc:  # 兜底：非预期错误也别让整轮崩
                        last_err = f"unexpected: {exc}"
                if winner:
                    break
                _launch()  # 失败的已移除，补新出口维持 _RACE_WIDTH 个在飞

        finally:
            for pending in in_flight:
                pending.cancel()
            if in_flight:
                await asyncio.gather(*in_flight, return_exceptions=True)

        if winner:
            yield {"type": "content", "content": winner}
            return

        raise RuntimeError(
            f"All raced search.sh exits failed (rate-limited or unavailable). Last: {last_err}"
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
