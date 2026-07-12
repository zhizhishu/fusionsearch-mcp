#!/usr/bin/env python3
"""Perplexity session keepalive — curl_cffi based, zero new dependencies.

Reads the first token from token_pool_config.json, hits /api/auth/session to
keep the cookie warm, and persists any rotated cookies back through:
  - token_pool_config.json  (local file)
  - POST /pool/import        (hot-reload Python pool, needs PPLX_ADMIN_TOKEN)
  - POST /api/perplexity/sync-token (persist to HF Secret, needs PERPLEXITY_SYNC_TOKEN)

Proxy env priority: PERPLEXITY_KEEPALIVE_PROXY > PERPLEXITY_SOCKS_PROXY > SOCKS_PROXY.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error


def _tail8(val: str | None) -> str:
    """Return last 8 chars as a safe fingerprint, never exposing full token."""
    if not val:
        return "None"
    return "..." + val[-8:]


def _http_post(url: str, body: bytes, headers: dict, timeout: int) -> int:
    """Best-effort POST via stdlib; returns HTTP status, raises on network error."""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


def main() -> None:
    # ── 1. 读 token 池 ──────────────────────────────────────────────────────
    pool_path = os.environ.get(
        "PPLX_TOKEN_POOL_OUT",
        "/app/services/perplexity/token_pool_config.json",
    )
    try:
        with open(pool_path, encoding="utf-8") as f:
            pool_cfg = json.load(f)
    except FileNotFoundError:
        print(f"[keepalive] token pool file not found: {pool_path}; skip")
        return
    except Exception as exc:
        print(f"[keepalive] failed to read token pool: {exc}; skip")
        return

    tokens = pool_cfg.get("tokens") if isinstance(pool_cfg.get("tokens"), list) else []
    if not tokens:
        print("[keepalive] no tokens in pool; skip")
        return

    tok = tokens[0]
    token_id = tok.get("id", "")
    session_token = tok.get("session_token", "")
    csrf_token = tok.get("csrf_token", "")

    if not session_token or not csrf_token:
        print(
            f"[keepalive] token id={token_id!r} missing session_token or csrf_token; skip"
        )
        return

    print(
        f"[keepalive] token id={token_id!r} "
        f"session={_tail8(session_token)} csrf={_tail8(csrf_token)}"
    )

    # ── 2. 代理 env（优先级: KEEPALIVE > SOCKS > 通用 SOCKS）───────────────
    proxy_url = (
        os.environ.get("PERPLEXITY_KEEPALIVE_PROXY")
        or os.environ.get("PERPLEXITY_SOCKS_PROXY")
        or os.environ.get("SOCKS_PROXY")
        or ""
    ).strip()
    if proxy_url:
        print(f"[keepalive] proxy=enabled ({proxy_url.split('@')[-1]})")
    else:
        print("[keepalive] proxy=disabled")

    # ── 3. curl_cffi 请求 session 端点 ──────────────────────────────────────
    from curl_cffi import requests as cffi  # noqa: PLC0415

    cookies = {
        "__Secure-next-auth.session-token": session_token,
        "next-auth.csrf-token": csrf_token,
    }
    kwargs: dict = {}
    if proxy_url:
        kwargs["proxies"] = {"http": proxy_url, "https": proxy_url}

    try:
        r = cffi.get(
            "https://www.perplexity.ai/api/auth/session",
            cookies=cookies,
            impersonate="chrome",
            timeout=30,
            **kwargs,
        )
    except Exception as exc:
        print(f"[keepalive] request failed: {exc}")
        sys.exit(1)

    print(f"[keepalive] session endpoint status={r.status_code}")

    # 判断登录态：200 且 JSON 含 "user" 或 "expires" 字段
    logged_in = False
    if r.status_code == 200:
        try:
            data = r.json()
            logged_in = bool(data.get("user") or data.get("expires"))
        except Exception:
            pass
    print(f"[keepalive] logged_in={logged_in}")

    # 抓 rotation 后的新 cookie：r.cookies 是 Cookies 对象，支持 .get(name)
    # 无 Set-Cookie 则 .get() 返回 None，退回旧值
    new_session_token = r.cookies.get("__Secure-next-auth.session-token") or session_token
    new_csrf_token = r.cookies.get("next-auth.csrf-token") or csrf_token

    rotated = (new_session_token != session_token) or (new_csrf_token != csrf_token)

    if not rotated:
        print("[keepalive] session kept warm (no rotation)")
        return

    # ── 4. 发生了 rotation，更新本地文件 ─────────────────────────────────────
    print(
        f"[keepalive] rotation detected: "
        f"session {_tail8(session_token)} → {_tail8(new_session_token)}, "
        f"csrf {_tail8(csrf_token)} → {_tail8(new_csrf_token)}"
    )

    # 在原 dict 上原地改（保留 heart_beat 等其它字段）
    tok["session_token"] = new_session_token
    tok["csrf_token"] = new_csrf_token

    try:
        with open(pool_path, "w", encoding="utf-8") as f:
            json.dump(pool_cfg, f, ensure_ascii=False)
        print(f"[keepalive] token pool file updated: {pool_path}")
    except Exception as exc:
        print(f"[keepalive] WARN: failed to write token pool file: {exc}")

    # ── 5a. 热更 Python 池（/pool/import）────────────────────────────────────
    admin_token = os.environ.get("PPLX_ADMIN_TOKEN", "")
    if admin_token:
        try:
            body = json.dumps(pool_cfg).encode()
            status = _http_post(
                "http://127.0.0.1:8001/pool/import",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Admin-Token": admin_token,
                },
                timeout=10,
            )
            print(f"[keepalive] /pool/import -> {status}")
        except Exception as exc:
            print(f"[keepalive] WARN: /pool/import failed: {exc}")
    else:
        print("[keepalive] PPLX_ADMIN_TOKEN not set; skip /pool/import")

    # ── 5b. 持久化到 HF Secret（sync-token）──────────────────────────────────
    sync_token = os.environ.get("PERPLEXITY_SYNC_TOKEN", "")
    if sync_token:
        try:
            payload = json.dumps(
                {
                    "id": token_id,
                    "session_token": new_session_token,
                    "csrf_token": new_csrf_token,
                }
            ).encode()
            status2 = _http_post(
                "http://127.0.0.1:1666/api/perplexity/sync-token",
                body=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Sync-Token": sync_token,
                },
                timeout=15,
            )
            print(f"[keepalive] /api/perplexity/sync-token -> {status2}")
        except Exception as exc:
            print(f"[keepalive] WARN: sync-token failed: {exc}")
    else:
        print("[keepalive] PERPLEXITY_SYNC_TOKEN not set; skip sync-token")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[keepalive] unhandled exception: {exc}")
        sys.exit(1)
