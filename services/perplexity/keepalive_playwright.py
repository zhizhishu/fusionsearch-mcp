#!/usr/bin/env python3
"""Perplexity session keep-alive via headless Playwright (Chromium).

Periodically loads the stored cookie into a real Chromium and visits perplexity.ai
through the HighPurity clean egress, to keep the NextAuth session warm and capture
the rotated cookie, then pushes the refreshed token to the sync-token endpoint
(writes HF Secret + hot-reloads the pool).

Egress note: Chromium's SOCKS5 proxy has no auth support, but resin also serves an
authenticated HTTP forward proxy on the SAME port (2260). So any authenticated
socks5:// proxy URL is rewritten to http:// here (resin: socks5/socks5h/http all
hit the same exits). Chromium DOES support HTTP-proxy auth (Proxy-Authorization).

Runs on a timer from start.sh; any failure is isolated and never touches the core
five sources. Disable with PERPLEXITY_KEEPALIVE=false.
"""
import json
import os
import re
import sys
import urllib.request

TOKEN_CONFIG = os.environ.get("PPLX_TOKEN_POOL_OUT", "/app/services/perplexity/token_pool_config.json")
SESSION_COOKIE = "__Secure-next-auth.session-token"
CSRF_COOKIE = "next-auth.csrf-token"
PPLX_URL = "https://www.perplexity.ai/"


def load_tokens():
    try:
        with open(TOKEN_CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return None, None, None, {}
    toks = cfg.get("tokens") or []
    if not toks:
        return None, None, None, cfg
    t = toks[0]
    return t.get("id", "primary"), t.get("session_token"), t.get("csrf_token"), cfg


def to_playwright_proxy(raw):
    """Parse an http/socks5/socks5h proxy URL into a Playwright proxy dict.
    Authenticated proxies are forced to HTTP (chromium socks5 has no auth; resin
    serves an authenticated HTTP forward proxy on the same 2260 port)."""
    if not raw:
        return None
    m = re.match(r'^(?P<scheme>\w+)://(?:(?P<user>[^:@/]+):(?P<pw>[^@/]+)@)?(?P<host>[^:/]+):(?P<port>\d+)', raw.strip())
    if not m:
        return None
    user, pw, host, port = m.group("user"), m.group("pw"), m.group("host"), m.group("port")
    if user:  # authenticated -> HTTP forward proxy (chromium supports http-proxy auth)
        return {"server": f"http://{host}:{port}", "username": user, "password": pw}
    return {"server": f"{m.group('scheme')}://{host}:{port}"}


def push_update(cfg, tid, session_token, csrf_token):
    admin_token = os.environ.get("PPLX_ADMIN_TOKEN")
    if admin_token:  # hot-reload the running python pool (instant)
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:8001/pool/import",
                data=json.dumps(cfg).encode(),
                headers={"Content-Type": "application/json", "X-Admin-Token": admin_token},
                method="POST")
            urllib.request.urlopen(req, timeout=10)
            print("[keepalive] hot-reloaded perplexity pool")
        except Exception as e:
            print(f"[keepalive] hot-reload failed: {e}")
    sync_token = os.environ.get("PERPLEXITY_SYNC_TOKEN")
    if sync_token:  # persist to HF Secret via the node sync-token endpoint
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:1666/api/perplexity/sync-token",
                data=json.dumps({"id": tid, "session_token": session_token, "csrf_token": csrf_token}).encode(),
                headers={"Content-Type": "application/json", "X-Sync-Token": sync_token},
                method="POST")
            urllib.request.urlopen(req, timeout=15)
            print("[keepalive] pushed to sync-token (HF Secret persisted)")
        except Exception as e:
            print(f"[keepalive] sync-token push failed: {e}")


def main():
    tid, session_token, csrf_token, cfg = load_tokens()
    if not session_token or not csrf_token:
        print("[keepalive] no stored token, skip")
        return 0

    raw_proxy = (os.environ.get("PERPLEXITY_KEEPALIVE_PROXY")
                 or os.environ.get("PERPLEXITY_SOCKS_PROXY")
                 or os.environ.get("SOCKS_PROXY"))
    proxy = to_playwright_proxy(raw_proxy)

    from playwright.sync_api import sync_playwright
    new_session = new_csrf = None
    logged_in = False
    with sync_playwright() as p:
        launch = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]}
        if proxy:
            launch["proxy"] = proxy
        browser = p.chromium.launch(**launch)
        try:
            ctx = browser.new_context(user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"))
            ctx.add_cookies([
                {"name": SESSION_COOKIE, "value": session_token, "domain": ".perplexity.ai",
                 "path": "/", "httpOnly": True, "secure": True, "sameSite": "Lax"},
                {"name": CSRF_COOKIE, "value": csrf_token, "domain": ".perplexity.ai",
                 "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"},
            ])
            page = ctx.new_page()
            page.goto(PPLX_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)  # let Cloudflare settle + session refresh
            logged_in = "signin" not in page.url.lower() and "login" not in page.url.lower()
            cookies = ctx.cookies("https://www.perplexity.ai")
            new_session = next((c["value"] for c in cookies if c["name"] == SESSION_COOKIE), None)
            new_csrf = next((c["value"] for c in cookies if c["name"] == CSRF_COOKIE), None)
        finally:
            browser.close()

    print(f"[keepalive] visited perplexity.ai (logged_in={logged_in}, proxy={'yes' if proxy else 'direct'})")
    if new_session and (new_session != session_token or (new_csrf and new_csrf != csrf_token)):
        toks = cfg.get("tokens") or [{}]
        toks[0]["session_token"] = new_session
        if new_csrf:
            toks[0]["csrf_token"] = new_csrf
        cfg["tokens"] = toks
        with open(TOKEN_CONFIG, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
        print("[keepalive] cookie rotated -> updated token pool config")
        push_update(cfg, tid, new_session, new_csrf or csrf_token)
    else:
        print("[keepalive] cookie unchanged, session kept warm")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[keepalive] error: {e}")
        sys.exit(1)
