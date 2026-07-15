#!/usr/bin/env python3
"""Deploy ClawEmail source to the HuggingFace Docker Space.

The HF write token is read ONLY from the HF_TOKEN environment variable and is
never written to disk or printed. HF builds the image from source (Dockerfile
runs `npm run build`), so we upload the source tree minus build/secret dirs.

Usage (PowerShell):
    $env:HF_TOKEN = "hf_xxx"; python scripts/hf_deploy.py
"""
import os
import sys

REPO_ID = "alphaeee/clawemail"
REPO_TYPE = "space"

IGNORE = [
    ".git/*", ".github/*", ".codex-run/*", ".claude/*", ".spec-workflow/*",
    "node_modules/*", "*/node_modules/*",
    # reference/ = local reference copy (openclaw SDK + .tgz) the user keeps on
    # disk for later; keep it local, never deploy it to the Space.
    "reference/*",
    "dist/*", "data/*", "*.log",
    ".env", ".env.*",
    # project memory / local notes / archives — local only, never deploy
    "LOG.md", "TASK.md", "TASK_LOG.md", "PROJECT_ID.md", "PROJECT_CONTEXT.md",
    "PROJECT_MAP.md", "AGENTS.md", "_archive/*", ".project/*",
    # local-only secrets / backups — NEVER deploy to the public Space
    "archive/*", "*.secret.md", "*/*.secret.md",
]


def _token_from_env_file() -> str | None:
    # Fallback: read HF_TOKEN from the local .env (gitignored, never deployed)
    # so iterative deploys don't need the env var set each time.
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.exists(path):
        return None
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("HF_TOKEN") and "=" in line:
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def main() -> int:
    token = os.environ.get("HF_TOKEN") or _token_from_env_file()
    if not token:
        print("ERROR: set HF_TOKEN env var or add HF_TOKEN to .env first.", file=sys.stderr)
        return 2

    from huggingface_hub import HfApi
    api = HfApi(token=token)

    who = api.whoami()
    print(f"auth ok as: {who.get('name')}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    print(f"uploading {root} -> {REPO_ID}")
    commit = api.upload_folder(
        repo_id=REPO_ID,
        repo_type=REPO_TYPE,
        folder_path=root,
        ignore_patterns=IGNORE,
        commit_message="fix(cf): real server-side delete via canonical /admin/delete_address/:id + stop minting healthcheck probe in cfStatus (use read-only /admin/address)",
    )
    print(f"uploaded: {getattr(commit, 'oid', commit)}")

    api.restart_space(repo_id=REPO_ID)
    print("restart triggered -> BUILDING")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
