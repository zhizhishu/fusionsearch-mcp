#!/usr/bin/env python3
"""Write token_pool_config.json at container start, optionally injecting a heart_beat block.

The heartbeat periodically pings Perplexity with each pooled cookie to keep the session
warm. It is DISABLED by default: forensics showed the session cookie lives ~1 year, so
failures come from token rotation / datacenter-IP anomaly detection, not inactivity --
in those cases a server-side heartbeat is useless and can even draw more anomaly scrutiny.
Set PERPLEXITY_HEARTBEAT_ENABLE=true to turn it on. Reads PERPLEXITY_TOKEN_CONFIG from env,
merges the heart_beat settings, writes the pool config file. start.sh falls back to a plain
copy if this exits non-zero, so a bad env never blocks startup.
"""
from __future__ import annotations

import json
import os
import sys

raw = os.environ.get("PERPLEXITY_TOKEN_CONFIG", "").strip()
cfg: dict = {}
if raw:
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            cfg = loaded
    except Exception as exc:  # bad JSON -> let start.sh fall back to plain copy
        print(f"[inject_heartbeat] bad PERPLEXITY_TOKEN_CONFIG JSON: {exc}", file=sys.stderr)
        sys.exit(1)

if os.environ.get("PERPLEXITY_HEARTBEAT_ENABLE", "false").strip().lower() == "true":
    hb = cfg.get("heart_beat")
    if not isinstance(hb, dict):
        hb = {}
    hb["enable"] = True
    hb.setdefault("interval", float(os.environ.get("PERPLEXITY_HEARTBEAT_INTERVAL", "6")))
    # Optional Telegram alert (user currently not using it; env hook kept for later).
    if os.environ.get("PERPLEXITY_TG_BOT_TOKEN"):
        hb["tg_bot_token"] = os.environ["PERPLEXITY_TG_BOT_TOKEN"]
    if os.environ.get("PERPLEXITY_TG_CHAT_ID"):
        hb["tg_chat_id"] = os.environ["PERPLEXITY_TG_CHAT_ID"]
    cfg["heart_beat"] = hb

out_path = os.environ.get("PPLX_TOKEN_POOL_OUT", "/app/services/perplexity/token_pool_config.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False)

hb_state = cfg.get("heart_beat", {}).get("enable", False)
n_tokens = len(cfg.get("tokens", []) if isinstance(cfg.get("tokens"), list) else [])
print(f"[inject_heartbeat] wrote token_pool_config.json (tokens={n_tokens}, heart_beat.enable={hb_state})")
