#!/usr/bin/env python3
"""Hardened cascade helper for setup-soldr version bumps.

Why this script exists (setup-soldr#350):

The cascade flow (branch -> edit -> commit -> push -> PR -> merge) runs in
repos where concurrent agents may also be operating on HEAD. Without
care, the following bad things happen:

  1. `gh pr merge --auto --squash` (no PR# arg) resolves to "PR for
     current branch". If a concurrent agent shifted HEAD between
     push and merge, the command silently warns + exits. The
     subsequent poll loop then stalls the shell.
  2. Commits land on the wrong branch when an agent runs
     `git checkout <theirs>` between `git add` and `git commit`.
     The push then no-ops, the PR is empty, and recovery requires
     cherry-pick.
  3. Fixed `sleep 30` / `sleep 60` waits block the shell long after
     CI finishes -- multiple minutes wasted per cascade.

This helper makes the cascade idempotent + concurrency-resilient:

  - Take branch name + commit message as args (never trust "current
    branch").
  - Stash unrelated working-tree changes before branching, restore
    after.
  - Assert HEAD didn't shift between `add` and `commit`; if it did,
    retry from a fresh branch off origin/main with cherry-pick.
  - Pass explicit PR number to every subsequent `gh` call.
  - Poll merge with exponential backoff (5s -> 60s, max 5 min) instead
    of fixed sleep.

Usage:

  python scripts/cascade-setup-soldr.py \\
      --consumer-repo zackees/zccache \\
      --local-checkout C:/Users/niteris/dev/zccache \\
      --from-version v0.9.46 \\
      --to-version v0.9.47 \\
      --branch chore/setup-soldr-0.9.47 \\
      --pr-title "ci: bump setup-soldr v0.9.46 -> v0.9.47" \\
      --pr-body-file pr-body.md \\
      --commit-message-file commit-msg.txt

Exit codes:
  0   PR merged successfully.
  1   PR opened but not yet merged (auto-merge enabled or manual).
  2   Cascade failed at some point (look at stderr for the stage).
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def log(msg: str) -> None:
    """Stderr log so stdout stays clean for the PR URL."""
    print(f"[cascade] {msg}", file=sys.stderr, flush=True)


def run(
    cmd: list[str],
    cwd: Path,
    *,
    check: bool = True,
    capture: bool = True,
    timeout: float = 120.0,
) -> subprocess.CompletedProcess[str]:
    """Run a command. Always uses text mode + explicit timeout."""
    log(f"$ {shlex.join(cmd)}  (cwd={cwd})")
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        check=False,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        sys.stderr.write(result.stdout or "")
        sys.stderr.write(result.stderr or "")
        raise SystemExit(
            f"command failed (rc={result.returncode}): {shlex.join(cmd)}"
        )
    return result


def git_head_sha(cwd: Path) -> str:
    return run(["git", "rev-parse", "HEAD"], cwd).stdout.strip()


def git_head_ref(cwd: Path) -> str:
    return run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.strip()


@dataclass
class CascadeArgs:
    consumer_repo: str
    local_checkout: Path
    from_version: str
    to_version: str
    branch: str
    pr_title: str
    pr_body: str
    commit_message: str
    main_branch: str = "main"


def parse_args(argv: list[str]) -> CascadeArgs:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--consumer-repo", required=True, help="e.g. zackees/zccache")
    p.add_argument("--local-checkout", required=True, type=Path)
    p.add_argument("--from-version", required=True, help="e.g. v0.9.46")
    p.add_argument("--to-version", required=True, help="e.g. v0.9.47")
    p.add_argument("--branch", required=True, help="branch name to create")
    p.add_argument("--pr-title", required=True)
    body_grp = p.add_mutually_exclusive_group(required=True)
    body_grp.add_argument("--pr-body", help="PR body text")
    body_grp.add_argument("--pr-body-file", type=Path, help="PR body from file")
    msg_grp = p.add_mutually_exclusive_group(required=True)
    msg_grp.add_argument("--commit-message", help="commit message text")
    msg_grp.add_argument(
        "--commit-message-file",
        type=Path,
        help="commit message from file",
    )
    p.add_argument("--main-branch", default="main")
    args = p.parse_args(argv)
    pr_body = args.pr_body or args.pr_body_file.read_text(encoding="utf-8")
    commit_msg = (
        args.commit_message
        or args.commit_message_file.read_text(encoding="utf-8")
    )
    return CascadeArgs(
        consumer_repo=args.consumer_repo,
        local_checkout=args.local_checkout,
        from_version=args.from_version,
        to_version=args.to_version,
        branch=args.branch,
        pr_title=args.pr_title,
        pr_body=pr_body,
        commit_message=commit_msg,
        main_branch=args.main_branch,
    )


def stash_unrelated_changes(cwd: Path) -> Optional[str]:
    """Stash any working-tree changes; return stash ref or None."""
    status = run(["git", "status", "--porcelain"], cwd).stdout.strip()
    if not status:
        return None
    log(f"stashing {len(status.splitlines())} unrelated working-tree changes")
    run(
        ["git", "stash", "push", "-u", "-m", "cascade-script-pre"],
        cwd,
    )
    return "stash@{0}"


def pop_stash(cwd: Path, stash_ref: Optional[str]) -> None:
    if not stash_ref:
        return
    # Best-effort restore; conflicts go to the working tree.
    log("restoring stashed changes")
    run(["git", "stash", "pop"], cwd, check=False)


def checkout_fresh_branch(args: CascadeArgs) -> None:
    """Sync main + check out a clean branch from origin/main."""
    cwd = args.local_checkout
    log(f"fetching origin/{args.main_branch}")
    run(["git", "fetch", "origin", args.main_branch], cwd)
    # Branch from origin/main directly -- bypasses local main which may be
    # held by another worktree or out of date.
    log(f"creating branch {args.branch} off origin/{args.main_branch}")
    # Delete local branch if exists, recreate clean.
    run(["git", "branch", "-D", args.branch], cwd, check=False)
    run(
        ["git", "checkout", "-b", args.branch, f"origin/{args.main_branch}"],
        cwd,
    )


def edit_workflow_files(args: CascadeArgs) -> int:
    """Sed-replace the version pin. Returns number of files changed."""
    cwd = args.local_checkout
    grep_pattern = f"zackees/setup-soldr.*{args.from_version}"
    # List files first (idempotent).
    grep = run(
        ["grep", "-rl", grep_pattern, ".github/"],
        cwd,
        check=False,
    )
    files = [
        f.strip()
        for f in grep.stdout.splitlines()
        if f.strip() and not f.startswith("Binary file")
    ]
    if not files:
        log(f"no files match {grep_pattern} -- nothing to bump")
        return 0
    log(f"editing {len(files)} workflow files: {', '.join(files)}")
    for f in files:
        # sed in-place. Use platform-portable replace via Python instead.
        path = cwd / f
        text = path.read_text(encoding="utf-8")
        new_text = text.replace(
            f"zackees/setup-soldr@{args.from_version}",
            f"zackees/setup-soldr@{args.to_version}",
        )
        new_text = new_text.replace(
            f"zackees/setup-soldr/cleanup@{args.from_version}",
            f"zackees/setup-soldr/cleanup@{args.to_version}",
        )
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
    # Verify no stragglers.
    leftover = run(
        ["grep", "-rl", grep_pattern, ".github/"],
        cwd,
        check=False,
    )
    if leftover.stdout.strip():
        raise SystemExit(
            f"sed-replace incomplete; still matching: {leftover.stdout}"
        )
    return len(files)


def stage_and_commit_safe(args: CascadeArgs) -> str:
    """Stage workflow changes + commit. Aborts + retries if HEAD shifted."""
    cwd = args.local_checkout
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        head_before = git_head_sha(cwd)
        ref_before = git_head_ref(cwd)
        log(f"commit attempt {attempt}/{max_attempts} on {ref_before} @ {head_before[:7]}")
        # Stage ONLY .github/workflows changes.
        run(["git", "add", ".github/"], cwd)
        # Re-check HEAD before commit.
        head_after_add = git_head_sha(cwd)
        if head_after_add != head_before:
            log(
                f"WARNING: HEAD shifted during git add ({head_before[:7]} -> {head_after_add[:7]})"
                " -- concurrent-agent activity. Retrying."
            )
            continue
        # Use --only flag to commit exactly what's staged.
        result = run(
            ["git", "commit", "-m", args.commit_message],
            cwd,
            check=False,
        )
        if result.returncode != 0:
            log(f"git commit failed: {result.stderr.strip()}")
            if "nothing to commit" in (result.stdout + result.stderr):
                # Already at target; treat as success no-op.
                log("nothing to commit -- branch already at target")
                return git_head_sha(cwd)
            raise SystemExit(f"git commit failed: {result.stderr}")
        # Verify the commit landed on our branch.
        ref_after = git_head_ref(cwd)
        if ref_after != args.branch:
            log(
                f"WARNING: commit landed on {ref_after} instead of {args.branch}"
                " (concurrent-agent branch switch). Cherry-picking to recover."
            )
            new_commit = git_head_sha(cwd)
            # Switch back to our branch and cherry-pick.
            run(["git", "checkout", args.branch], cwd)
            run(["git", "cherry-pick", new_commit], cwd)
            return git_head_sha(cwd)
        return git_head_sha(cwd)
    raise SystemExit(
        f"cascade aborted after {max_attempts} attempts (HEAD kept shifting)"
    )


def push_branch(args: CascadeArgs) -> None:
    cwd = args.local_checkout
    run(["git", "push", "-u", "origin", args.branch], cwd)


def create_pr(args: CascadeArgs) -> int:
    """Open PR. Returns PR number."""
    cwd = args.local_checkout
    result = run(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            args.consumer_repo,
            "--head",
            args.branch,
            "--title",
            args.pr_title,
            "--body",
            args.pr_body,
        ],
        cwd,
    )
    # gh pr create prints the PR URL. Capture the number.
    url = result.stdout.strip().splitlines()[-1]
    pr_num = int(url.rstrip("/").split("/")[-1])
    log(f"PR opened: {url}")
    return pr_num


def enable_auto_merge_and_poll(
    args: CascadeArgs,
    pr_number: int,
    max_wait_s: float = 300.0,
) -> tuple[bool, str]:
    """Enable auto-merge, poll until merged or timeout. Returns (merged, state)."""
    cwd = args.local_checkout
    # Try to enable auto-merge first. May fail if disabled on repo.
    auto = run(
        [
            "gh",
            "pr",
            "merge",
            str(pr_number),
            "--repo",
            args.consumer_repo,
            "--auto",
            "--squash",
        ],
        cwd,
        check=False,
    )
    if auto.returncode != 0:
        log(
            f"auto-merge enable failed (likely repo policy): {auto.stderr.strip()}"
            " -- leaving PR open for manual merge"
        )

    # Poll with exponential backoff.
    elapsed = 0.0
    wait = 5.0
    deadline = max_wait_s
    while elapsed < deadline:
        view = run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--repo",
                args.consumer_repo,
                "--json",
                "state,mergedAt,mergeStateStatus",
            ],
            cwd,
            check=False,
        )
        if view.returncode != 0:
            log(f"pr view failed: {view.stderr.strip()}")
            return False, "view-failed"
        data = json.loads(view.stdout)
        state = data.get("state")
        merged_at = data.get("mergedAt")
        if state == "MERGED" or merged_at:
            log(f"PR #{pr_number} MERGED at {merged_at}")
            return True, "merged"
        if state == "CLOSED":
            log(f"PR #{pr_number} CLOSED without merge")
            return False, "closed"
        log(
            f"PR #{pr_number} state={state} mergeStateStatus={data.get('mergeStateStatus')} "
            f"-- sleeping {wait:.0f}s (elapsed {elapsed:.0f}s/{deadline:.0f}s)"
        )
        time.sleep(wait)
        elapsed += wait
        wait = min(wait * 2, 60.0)

    log(f"PR #{pr_number} not merged within {deadline}s -- exiting with status 1")
    return False, "timeout"


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.local_checkout.exists():
        raise SystemExit(f"local checkout not found: {args.local_checkout}")
    stash_ref = None
    try:
        stash_ref = stash_unrelated_changes(args.local_checkout)
        checkout_fresh_branch(args)
        changed = edit_workflow_files(args)
        if changed == 0:
            log("no version bump needed -- nothing to do")
            return 0
        stage_and_commit_safe(args)
        push_branch(args)
        pr_num = create_pr(args)
        # Print PR URL on stdout for the caller.
        print(f"https://github.com/{args.consumer_repo}/pull/{pr_num}")
        merged, state = enable_auto_merge_and_poll(args, pr_num)
        return 0 if merged else 1
    finally:
        pop_stash(args.local_checkout, stash_ref)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
