#!/usr/bin/env python3
import concurrent.futures
import datetime
import glob
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
CACHE_PATH = os.path.join(HOME, ".cache", "herdr-quota", "status-quota.json")
OMP_DB = os.path.join(HOME, ".omp", "agent", "agent.db")
TTL_SEC = 120


def iso_to_ms(val):
    if not val:
        return None
    if isinstance(val, (int, float)):
        return int(val * 1000) if val < 1e12 else int(val)
    try:
        s = str(val).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None


def fmt_countdown(resets_ms, now_ms):
    if not resets_ms or resets_ms <= now_ms:
        return "已重置"
    sec = int((resets_ms - now_ms) / 1000)
    d, rem = divmod(sec, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    dt = datetime.datetime.fromtimestamp(resets_ms / 1000)
    clock = dt.strftime("%m/%d %H:%M") if d > 0 else dt.strftime("%H:%M")
    if d > 0:
        return f"{d}d {h}h ({clock})"
    if h > 0:
        return f"{h}h {m}m ({clock})"
    return f"{max(1, m)}m ({clock})"


def query_omp_db():
    if not os.path.exists(OMP_DB):
        return {}
    try:
        conn = sqlite3.connect(f"file:{OMP_DB}?mode=ro", uri=True, timeout=2)
        cur = conn.cursor()
        cur.execute(
            """
            SELECT u.provider, u.email, u.label, u.window_label, u.used_fraction, u.resets_at, u.recorded_at
            FROM usage_history u
            JOIN (
                SELECT provider, COALESCE(email, '') AS em, MAX(recorded_at) AS max_rec
                FROM usage_history
                GROUP BY provider, COALESCE(email, '')
            ) latest
              ON u.provider = latest.provider
             AND COALESCE(u.email, '') = latest.em
             AND u.recorded_at = latest.max_rec
            """
        )
        out = {}
        for prov, email, label, win, used_frac, resets_at, rec_at in cur.fetchall():
            out.setdefault((prov, email or ""), []).append(
                {
                    "label": label,
                    "window": win,
                    "used_fraction": float(used_frac or 0.0),
                    "resets_at": int(resets_at) if resets_at else None,
                    "recorded_at": int(rec_at) if rec_at else 0,
                }
            )
        conn.close()
        return out
    except Exception:
        return {}


def fetch_claude(now_ms, omp_rows):
    token = None
    plan = None
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).decode("utf-8")
        oauth = json.loads(raw).get("claudeAiOauth") or {}
        token = oauth.get("accessToken")
        plan = oauth.get("subscriptionType")
    except Exception:
        pass

    if not token:
        try:
            with open(os.path.join(HOME, ".claude", ".credentials.json"), "r", encoding="utf-8") as f:
                oauth = json.load(f).get("claudeAiOauth") or {}
                token = oauth.get("accessToken")
                plan = oauth.get("subscriptionType")
        except Exception:
            pass

    if token:
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/api/oauth/usage",
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": "oauth-2025-04-20",
                    "User-Agent": "herdr-status-quota/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = []
            for label, full_label, key in [("5h", "Claude 5h", "five_hour"), ("7d", "Claude 7d", "seven_day")]:
                w = data.get(key)
                if not w:
                    continue
                used = float(w.get("utilization") or 0.0)
                resets_ms = iso_to_ms(w.get("resets_at"))
                if resets_ms and resets_ms <= now_ms:
                    used = 0.0
                rem = max(0, min(100, round(100.0 - used)))
                items.append(
                    {
                        "label": label,
                        "fullLabel": full_label,
                        "remaining": rem,
                        "used": round(used),
                        "resetsAt": resets_ms,
                        "resetText": fmt_countdown(resets_ms, now_ms),
                    }
                )
            if items:
                acct = next((em.split("@")[0] for (p, em) in omp_rows if p == "anthropic" and em), "")
                return {
                    "id": "claude",
                    "name": f"Claude ({plan})" if plan else "Claude",
                    "account": acct,
                    "icon": "icons/claude.svg",
                    "items": items,
                }
        except Exception:
            pass

    # Fallback to omp agent.db anthropic rows
    for (prov, email), rows in omp_rows.items():
        if prov != "anthropic":
            continue
        items = []
        for r in rows:
            if "Fable" in (r["label"] or ""):
                continue
            lbl = "5h" if "5" in (r["window"] or r["label"] or "") else "7d"
            resets_ms = r["resets_at"]
            used = r["used_fraction"] * 100.0
            if resets_ms and resets_ms <= now_ms:
                used = 0.0
            rem = max(0, min(100, round(100.0 - used)))
            items.append(
                {
                    "label": lbl,
                    "fullLabel": r["label"],
                    "remaining": rem,
                    "used": round(used),
                    "resetsAt": resets_ms,
                    "resetText": fmt_countdown(resets_ms, now_ms),
                }
            )
        items.sort(key=lambda x: 0 if x["label"] == "5h" else 1)
        return {
            "id": "claude",
            "name": f"Claude ({plan})" if plan else "Claude",
            "account": email.split("@")[0] if email else "",
            "icon": "icons/claude.svg",
            "items": items,
        }

    return {"id": "claude", "name": "Claude", "icon": "icons/claude.svg", "error": "未登入", "items": []}


def fetch_codex_credits():
    pattern = os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl*")
    files = sorted(glob.glob(pattern), reverse=True)
    for path in files[:15]:
        try:
            if path.endswith(".zst"):
                zstd_bin = "/opt/homebrew/bin/zstd" if os.path.exists("/opt/homebrew/bin/zstd") else "zstd"
                raw = subprocess.check_output([zstd_bin, "-d", "-c", path], stderr=subprocess.DEVNULL, timeout=2).decode("utf-8", "ignore")
            else:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    raw = f.read()
        except Exception:
            continue
        for line in reversed(raw.splitlines()):
            if '"rate_limits"' not in line:
                continue
            try:
                rl = (json.loads(line).get("payload") or {}).get("rate_limits") or {}
                plan = rl.get("plan_type")
                bal = (rl.get("credits") or {}).get("balance")
                return plan, float(bal) if bal is not None else None
            except Exception:
                continue
    return None, None


def fetch_codex(now_ms, omp_rows):
    plan, bal = fetch_codex_credits()
    extra = f" · ${bal:.0f}" if bal else ""
    title = f"Codex ({plan}{extra})" if plan else f"Codex{extra}"

    for (prov, email), rows in omp_rows.items():
        if prov != "openai-codex":
            continue
        items = []
        seen = set()
        for r in rows:
            lbl = "5h" if "5" in (r["window"] or r["label"] or "") else "7d"
            if lbl in seen:
                continue
            seen.add(lbl)
            resets_ms = r["resets_at"]
            used = r["used_fraction"] * 100.0
            if resets_ms and resets_ms <= now_ms:
                used = 0.0
            rem = max(0, min(100, round(100.0 - used)))
            items.append(
                {
                    "label": lbl,
                    "fullLabel": f"Codex {lbl}",
                    "remaining": rem,
                    "used": round(used),
                    "resetsAt": resets_ms,
                    "resetText": fmt_countdown(resets_ms, now_ms),
                }
            )
        items.sort(key=lambda x: 0 if x["label"] == "5h" else 1)
        if items:
            return {
                "id": "codex",
                "name": title,
                "account": email.split("@")[0] if email else "",
                "icon": "icons/codex.svg",
                "items": items,
            }

    return {"id": "codex", "name": title, "icon": "icons/codex.svg", "error": "無紀錄", "items": []}


def fetch_gemini_accounts(now_ms, omp_rows):
    accounts = []
    # Collect all google-antigravity accounts from omp agent.db
    agy_entries = [(email, rows) for (prov, email), rows in omp_rows.items() if prov == "google-antigravity"]
    # Sort accounts alphabetically for consistent display order
    agy_entries.sort(key=lambda x: x[0])

    order_map = {
        ("Gemini", "5 Hour"): (1, "5h", "Gemini 5h"),
        ("Gemini", "Weekly"): (2, "7d", "Gemini 7d"),
        ("Gemini (Argon)", "Weekly"): (3, "Argon", "Gemini 4 Argon 7d"),
        ("Claude & GPT (shared)", "5 Hour"): (4, "C/G 5h", "Claude/GPT 5h"),
        ("Claude & GPT (shared)", "Weekly"): (5, "C/G 7d", "Claude/GPT 7d"),
    }

    for email, rows in agy_entries:
        short_acct = email.split("@")[0] if email else "default"
        by_key = {}
        for r in rows:
            key = (r["label"], r["window"])
            if key not in order_map:
                continue
            rank, short_lbl, full_lbl = order_map[key]
            resets_ms = r["resets_at"]
            used = r["used_fraction"] * 100.0
            if resets_ms and resets_ms <= now_ms:
                used = 0.0
            rem = max(0, min(100, round(100.0 - used)))
            # Keep the most constrained if duplicate rows exist
            if short_lbl not in by_key or rem < by_key[short_lbl]["remaining"]:
                by_key[short_lbl] = {
                    "_rank": rank,
                    "label": short_lbl,
                    "fullLabel": full_lbl,
                    "remaining": rem,
                    "used": round(used),
                    "resetsAt": resets_ms,
                    "resetText": fmt_countdown(resets_ms, now_ms),
                }
        items = [ {k: v for k, v in it.items() if k != "_rank"} for it in sorted(by_key.values(), key=lambda x: x["_rank"]) ]
        if items:
            accounts.append(
                {
                    "id": f"agy-{short_acct}",
                    "name": f"Gemini ({short_acct})",
                    "account": email,
                    "icon": "icons/antigravity.svg",
                    "items": items,
                }
            )
    return accounts


def main():
    force = "--force" in sys.argv
    now_ms = int(time.time() * 1000)

    if not force and os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if now_ms - cached.get("updatedAt", 0) < TTL_SEC * 1000:
                print(json.dumps(cached, ensure_ascii=False))
                return
        except Exception:
            pass

    omp_rows = query_omp_db()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f_claude = ex.submit(fetch_claude, now_ms, omp_rows)
        f_codex = ex.submit(fetch_codex, now_ms, omp_rows)
        claude_res = f_claude.result()
        codex_res = f_codex.result()

    gemini_list = fetch_gemini_accounts(now_ms, omp_rows)
    providers = [claude_res, codex_res, *gemini_list]

    out = {
        "updatedAt": now_ms,
        "updatedText": datetime.datetime.now().strftime("%H:%M:%S"),
        "providers": providers,
    }
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
    except Exception:
        pass

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
