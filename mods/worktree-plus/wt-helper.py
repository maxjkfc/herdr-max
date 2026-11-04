#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
WT_ROOT = os.path.join(HOME, ".herdr", "worktrees")
KEPT_FILE = os.path.join(HOME, ".cache", "herdr-quota", "kept-worktrees.json")


def load_kept():
    try:
        with open(KEPT_FILE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()


def mark_kept(path, kept=True):
    s = load_kept()
    if kept:
        s.add(path)
    else:
        s.discard(path)
    try:
        os.makedirs(os.path.dirname(KEPT_FILE), exist_ok=True)
        with open(KEPT_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(s), f)
    except Exception:
        pass


def git_out(cwd, args):
    try:
        out = subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.DEVNULL, timeout=4).decode("utf-8", "ignore").strip()
        return True, out
    except Exception:
        return False, ""


def repo_of(folder):
    if not folder or not os.path.isdir(folder):
        return None
    ok1, top = git_out(folder, ["rev-parse", "--show-toplevel"])
    ok2, common = git_out(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if not ok1 or not ok2:
        return None
    main_dir = common[:-5] if common.endswith("/.git") else common
    ok3, branch = git_out(folder, ["symbolic-ref", "--short", "HEAD"])
    if not ok3:
        _, branch = git_out(folder, ["rev-parse", "--abbrev-ref", "HEAD"])
    return {
        "top": top,
        "main": main_dir,
        "name": os.path.basename(main_dir),
        "linked": main_dir != top,
        "branch": branch or None,
    }


def child_repos(folder):
    if not folder or not os.path.isdir(folder):
        return []
    out = []
    for entry in sorted(os.listdir(folder)):
        if entry.startswith("."):
            continue
        sub = os.path.join(folder, entry)
        if not os.path.isdir(sub):
            continue
        if os.path.exists(os.path.join(sub, ".git")):
            r = repo_of(sub)
            if r:
                out.append(r)
    return out


def issue_branch_name(num, title):
    lower = title.lower()
    prefix = "fix" if re.search(r"\b(fix|bug|hotfix)\b|修復|修正|錯誤|失敗", lower) else "feat"
    words = re.findall(r"[a-z0-9]+", lower)
    stop = {"the", "and", "for", "with", "from", "into", "fix", "feat", "bug"}
    kept = [w for w in words if w not in stop][:5]
    slug = "-".join(kept)
    return f"{prefix}/issue-{num}-{slug}" if slug else f"{prefix}/issue-{num}"


def find_envrc_dir(start_path):
    cur = os.path.abspath(start_path)
    while cur and cur != "/":
        if os.path.isfile(os.path.join(cur, ".envrc")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def fetch_issues(repo_path):
    env = os.environ.copy()
    gh_bin = "/opt/homebrew/bin/gh" if os.path.exists("/opt/homebrew/bin/gh") else "gh"
    direnv_bin = "/opt/homebrew/bin/direnv" if os.path.exists("/opt/homebrew/bin/direnv") else "direnv"
    envrc_dir = find_envrc_dir(repo_path)
    cmd = [gh_bin, "issue", "list", "--state", "open", "--limit", "25", "--json", "number,title"]
    if envrc_dir:
        cmd = [direnv_bin, "exec", envrc_dir, *cmd]
    try:
        raw = subprocess.check_output(
            cmd,
            cwd=repo_path,
            env=env,
            stderr=subprocess.DEVNULL,
            timeout=8,
        ).decode("utf-8", "ignore")
        items = json.loads(raw)
        return [
            {
                "number": it["number"],
                "title": it["title"],
                "branch": issue_branch_name(it["number"], it["title"]),
            }
            for it in items
        ]
    except Exception:
        return []


def check_wt(folder):
    r = repo_of(folder)
    if not r or not r["linked"]:
        return {"linked": False}
    _, st = git_out(r["top"], ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"])
    dirty_lines = [line for line in st.splitlines() if line.strip()]
    _, unpushed_out = git_out(r["top"], ["rev-list", "--count", "HEAD", "--not", "--remotes"])
    try:
        unpushed = int(unpushed_out)
    except Exception:
        unpushed = 0
    return {
        "linked": True,
        "repo": r,
        "dirty": len(dirty_lines) > 0,
        "dirtyCount": len(dirty_lines),
        "unpushed": unpushed,
    }


def remove_wt(folder, delete_branch=False):
    r = repo_of(folder)
    if not r or not r["linked"]:
        return {"ok": False, "error": "Not a linked worktree"}
    main_dir = r["main"]
    top_dir = r["top"]
    branch = r.get("branch")
    try:
        subprocess.check_call(["git", "-C", main_dir, "worktree", "remove", "--force", top_dir], stderr=subprocess.STDOUT, timeout=8)
    except subprocess.CalledProcessError as e:
        return {"ok": False, "error": e.output.decode("utf-8", "ignore").strip()}
    if delete_branch and branch and branch not in ("main", "master", "HEAD"):
        try:
            subprocess.call(["git", "-C", main_dir, "branch", "-D", branch], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
        except Exception:
            pass
    parent = os.path.dirname(top_dir)
    try:
        if os.path.isdir(parent) and not os.listdir(parent):
            os.rmdir(parent)
    except Exception:
        pass
    mark_kept(top_dir, False)
    return {"ok": True}


def auto_clean_wt(folder):
    st = check_wt(folder)
    if not st.get("linked"):
        return {"action": "none"}
    if st.get("dirty") or st.get("unpushed", 0) > 0:
        return {"action": "prompt", "status": st}
    r = st["repo"]
    main_dir = r["main"]
    branch = r.get("branch")
    res = remove_wt(folder, delete_branch=False)
    if res.get("ok") and branch and branch not in ("main", "master", "HEAD"):
        subprocess.call(["git", "-C", main_dir, "branch", "-d", branch], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
    return {"action": "cleaned", "repo": r["name"], "branch": branch}


def scan_orphans(open_paths_json):
    try:
        open_paths = [p.rstrip("/") for p in json.loads(open_paths_json) if p]
    except Exception:
        open_paths = []
    if not os.path.isdir(WT_ROOT):
        return {"prompt": None, "cleaned": []}
    kept = load_kept()
    cleaned = []
    prompt_folder = None
    for repo_name in sorted(os.listdir(WT_ROOT)):
        repo_dir = os.path.join(WT_ROOT, repo_name)
        if not os.path.isdir(repo_dir) or repo_name.startswith("."):
            continue
        for wt_name in sorted(os.listdir(repo_dir)):
            wt_dir = os.path.join(repo_dir, wt_name).rstrip("/")
            if not os.path.isdir(wt_dir) or wt_name.startswith("."):
                continue
            in_use = any(p == wt_dir or p.startswith(wt_dir + "/") for p in open_paths)
            if in_use:
                if wt_dir in kept:
                    mark_kept(wt_dir, False)
                continue
            if wt_dir in kept:
                continue
            res = auto_clean_wt(wt_dir)
            if res.get("action") == "cleaned":
                cleaned.append(wt_dir)
            elif res.get("action") == "prompt" and not prompt_folder:
                prompt_folder = wt_dir
        try:
            if os.path.isdir(repo_dir) and not os.listdir(repo_dir):
                os.rmdir(repo_dir)
        except Exception:
            pass
    return {"prompt": prompt_folder, "cleaned": cleaned}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    folder = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()

    if cmd == "inspect":
        r = repo_of(folder)
        if r:
            print(json.dumps({"repo": r, "children": [], "issues": fetch_issues(r["top"])}, ensure_ascii=False))
        else:
            print(json.dumps({"repo": None, "children": child_repos(folder), "issues": []}, ensure_ascii=False))
    elif cmd == "issues":
        print(json.dumps({"issues": fetch_issues(folder)}, ensure_ascii=False))
    elif cmd == "check-wt":
        print(json.dumps(check_wt(folder), ensure_ascii=False))
    elif cmd == "remove-wt":
        del_br = "--delete-branch" in sys.argv
        print(json.dumps(remove_wt(folder, del_br), ensure_ascii=False))
    elif cmd == "auto-clean-wt":
        print(json.dumps(auto_clean_wt(folder), ensure_ascii=False))
    elif cmd == "scan-orphans":
        print(json.dumps(scan_orphans(sys.argv[2] if len(sys.argv) > 2 else "[]"), ensure_ascii=False))
    elif cmd == "keep-wt":
        mark_kept(folder.rstrip("/"), True)
        print(json.dumps({"ok": True}))


if __name__ == "__main__":
    main()
