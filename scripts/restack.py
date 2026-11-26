#!/usr/bin/env python3
"""Sync the fork's main with upstream, then replay the whole PR stack on top.

Why a script. The PRs here are a chain: each one's base is the previous one's
head, two roots sitting on main. Rebasing each branch onto main INDEPENDENTLY
duplicates every ancestor commit, so the stack has to be replayed in
dependency order with `--onto`. Doing that by hand across 40 branches is how
work gets dropped.

What it refuses to guess:
  * The topology comes from the open PRs (`gh pr list`), never from local
    branches — most local copies drift from what is published, and rebasing a
    stale local copy would overwrite the published one with older work.
  * Every branch is replayed from the ref on the REMOTE, for the same reason.
  * Pushes carry `--force-with-lease` pinned to the sha this run measured, so
    a push that would clobber someone else's concurrent write fails instead.

The one conflict that repeats is the Go server's embedded JS bundle, which is
generated: it is rebuilt rather than merged. Any other conflict stops that
branch and everything under it, and the run reports what it dropped.

Usage:
    python3 scripts/restack.py --dry-run     # plan only, touches nothing
    python3 scripts/restack.py               # sync main, replay, push
    python3 scripts/restack.py --base <ref>  # replay onto <ref> instead of main
                                             # (use to put a branch under the stack)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

BUNDLE = "packages/server/go/internal/jsruntime/blok-server-runtime.js"
GENERATED = {BUNDLE}
FORK = "fork"
UPSTREAM = "origin"
PUSH_BATCH = 4           # a single push of 40 branches times out on GitHub (HTTP 408)
PUSH_ATTEMPTS = 3


def run(*args: str, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(args, capture_output=True, text=True, cwd=cwd)
    if check and r.returncode != 0:
        raise SystemExit(f"$ {' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r


def git(*args: str, repo: str, check: bool = True) -> subprocess.CompletedProcess:
    return run("git", "-C", repo, *args, check=check)


def sha(ref: str, repo: str) -> str:
    return git("rev-parse", ref, repo=repo).stdout.strip()


def topology(slug: str) -> list[tuple[str, str, str]]:
    """Open PRs in dependency order, walking down from `main`."""
    raw = run("gh", "pr", "list", "--repo", slug, "--state", "open", "--limit", "200",
              "--json", "number,headRefName,baseRefName").stdout
    prs = json.loads(raw)
    children: dict[str, list[dict]] = {}
    for pr in prs:
        children.setdefault(pr["baseRefName"], []).append(pr)

    order: list[tuple[str, str, str]] = []
    seen: set[str] = set()

    def walk(base: str) -> None:
        for pr in sorted(children.get(base, []), key=lambda p: p["number"]):
            head = pr["headRefName"]
            if head in seen:
                continue
            seen.add(head)
            order.append((str(pr["number"]), head, base))
            walk(head)

    walk("main")
    orphans = [p["headRefName"] for p in prs if p["headRefName"] not in seen]
    if orphans:
        print(f"! {len(orphans)} PR(s) unreachable from main, left alone: {', '.join(orphans)}")
    return order


def regenerate_bundle(repo: str) -> None:
    r = subprocess.run(["node", "scripts/build-server-runtime.mjs"], cwd=repo,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("build-server-runtime failed:\n" + r.stdout[-2000:] + r.stderr[-2000:])


def replay(branch: str, onto: str, old_base: str, repo: str) -> tuple[str | None, list[str]]:
    """Replay `branch`'s own commits onto `onto`. Returns (new sha, conflicts)."""
    git("checkout", "-B", f"restack/{branch}", f"{FORK}/{branch}", "--quiet", repo=repo)
    env = dict(os.environ, GIT_EDITOR="true")
    proc = subprocess.run(["git", "-C", repo, "rebase", "--onto", onto, old_base],
                          capture_output=True, text=True, env=env)
    while proc.returncode != 0:
        unmerged = set(git("diff", "--name-only", "--diff-filter=U", repo=repo, check=False).stdout.split())
        if not unmerged or not unmerged <= GENERATED:
            git("rebase", "--abort", repo=repo, check=False)
            return None, sorted(unmerged) or ["(rebase failed with no conflicted file)"]
        regenerate_bundle(repo)
        git("add", BUNDLE, repo=repo)
        proc = subprocess.run(["git", "-C", repo, "rebase", "--continue"],
                              capture_output=True, text=True, env=env)
    return sha("HEAD", repo), []


def push(pairs: list[tuple[str, str, str]], repo: str) -> tuple[int, list[str]]:
    """Push (branch, new sha, expected old sha) in small atomic batches."""
    pushed, failed = 0, []
    for start in range(0, len(pairs), PUSH_BATCH):
        batch = pairs[start:start + PUSH_BATCH]
        args: list[str] = []
        for branch, new, old in batch:
            args += [f"--force-with-lease=refs/heads/{branch}:{old}", f"{new}:refs/heads/{branch}"]
        for attempt in range(1, PUSH_ATTEMPTS + 1):
            r = git("push", "--atomic", FORK, *args, repo=repo, check=False)
            if r.returncode == 0:
                pushed += len(batch)
                print(f"  pushed {', '.join(b for b, _, _ in batch)}")
                break
            print(f"  attempt {attempt} failed: {(r.stderr or '').strip().splitlines()[-1:][:1]}")
            time.sleep(5)
        else:
            failed += [b for b, _, _ in batch]
            break   # everything below depends on this batch
    return pushed, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".", help="worktree to replay in (default: cwd)")
    ap.add_argument("--slug", default="joceqo/blok", help="fork the PRs live on")
    ap.add_argument("--base", default=None,
                    help="replay the roots onto this ref instead of the synced main")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    repo = os.path.abspath(args.repo)

    # Untracked files are irrelevant to a rebase; a tracked modification is not.
    if git("status", "--porcelain", "--untracked-files=no", repo=repo).stdout.strip():
        raise SystemExit("worktree has uncommitted changes — commit or stash before restacking")

    git("fetch", UPSTREAM, "main", "--quiet", repo=repo)
    git("fetch", FORK, "--quiet", "--prune", repo=repo)
    old_main, upstream_main = sha(f"{FORK}/main", repo), sha(f"{UPSTREAM}/main", repo)
    behind = len(git("rev-list", f"{old_main}..{upstream_main}", repo=repo).stdout.split())
    print(f"main: {behind} commit(s) behind upstream")

    order = topology(args.slug)
    print(f"stack: {len(order)} PR(s)")
    if args.dry_run:
        for num, head, base in order:
            print(f"  #{num:>3} {head}  (on {base})")
        return 0

    if old_main != upstream_main:
        if git("merge-base", "--is-ancestor", old_main, upstream_main, repo=repo, check=False).returncode != 0:
            raise SystemExit("fork/main has commits upstream does not — resolve by hand")
        git("push", FORK, f"{upstream_main}:refs/heads/main", repo=repo)
        git("fetch", FORK, "main", "--quiet", repo=repo)
        print("main fast-forwarded")

    # The sha each branch is published at right now: the backup, and the lease.
    before = {head: sha(f"{FORK}/{head}", repo) for _, head, _ in order}
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for head, old in before.items():
        git("update-ref", f"refs/backups/restack-{stamp}/{head}", old, repo=repo)
    print(f"backups at refs/backups/restack-{stamp}/*")

    root_base = sha(args.base, repo) if args.base else upstream_main
    new: dict[str, str] = {}
    blocked: dict[str, str] = {}
    for num, head, base in order:
        if base == "main":
            old_base, onto = old_main, root_base
        elif base in blocked or base not in new:
            blocked[head] = base
            print(f"skipped #{num} {head} (blocked by {base})")
            continue
        else:
            old_base, onto = before[base], new[base]
        result, conflicts = replay(head, onto, old_base, repo)
        if result is None:
            blocked[head] = head
            print(f"CONFLICT #{num} {head}: {', '.join(conflicts)}")
            continue
        new[head] = result
        print(f"ok #{num} {head} -> {result[:9]}")

    # A replay that drops or rewrites a commit is the failure that matters.
    for num, head, base in order:
        if head not in new:
            continue
        onto = root_base if base == "main" else new[base]
        was = git("log", "--format=%s", f"{before[base] if base != 'main' else old_main}..{before[head]}", repo=repo).stdout
        now = git("log", "--format=%s", f"{onto}..{new[head]}", repo=repo).stdout
        if was != now:
            raise SystemExit(f"#{num} {head}: commit list changed — refusing to push")
    print(f"replayed {len(new)}/{len(order)}, commit lists unchanged")

    pushed, failed = push([(h, new[h], before[h]) for _, h, _ in order if h in new], repo)
    print(f"pushed {pushed}, failed {failed or 'none'}, blocked {sorted(blocked) or 'none'}")
    return 1 if failed or blocked else 0


if __name__ == "__main__":
    sys.exit(main())
