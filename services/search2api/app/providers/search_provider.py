import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict

import httpx
from fastapi import HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.config import settings


class SearchProvider:
    BASE_URL = "https://search.sh/api/search"
    MODEL_NAME = "search-sh-ai"
    DEFAULT_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    )

    def __init__(self):
        self.headers = {
            "Accept": "*/*",
            "Accept-Language": "en,zh-CN;q=0.9",
            "Content-Type": "application/json",
            "Origin": "https://search.sh",
            "Referer": "https://search.sh/",
            "User-Agent": settings.SEARCH_SH_USER_AGENT or self.DEFAULT_USER_AGENT,
            "Cookie": settings.SEARCH_SH_COOKIE,
        }

    async def handle_chat_completion(self, request_data: Dict[str, Any]) -> StreamingResponse | JSONResponse:
        if not settings.SEARCH_SH_COOKIE:
            raise HTTPException(
                status_code=503,
                detail="SEARCH_SH_COOKIE is not set. Configure the complete cookie header from search.sh first.",
            )
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

    async def _get_response_stream(self, payload: dict) -> AsyncGenerator[Dict[str, Any], None]:
        request_body = {
            "query": self._extract_query(payload),
            "currentDate": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        last_answer = ""

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", self.BASE_URL, headers=self.headers, json=request_body) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        data_json = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if "progressText" in data_json:
                        yield {"type": "status", "content": data_json["progressText"]}

                    if "summary" in data_json:
                        token = data_json["summary"]
                        if token:
                            yield {"type": "content", "content": token}

                    if "answer" in data_json:
                        answer = data_json["answer"]
                        if isinstance(answer, str) and answer:
                            delta = answer[len(last_answer):] if answer.startswith(last_answer) else answer
                            last_answer = answer
                            if delta:
                                yield {"type": "content", "content": delta}

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
