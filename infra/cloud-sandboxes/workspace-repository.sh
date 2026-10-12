#!/usr/bin/env bash
set -euo pipefail

workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
branch="${ZUSE_BRANCH:?}"
base_ref="${ZUSE_BASE_REF:?}"
# Repository setup runs outside the agent's per-turn Git environment. Give
# only this process the initiating member/Slack identity; never install it as
# a workspace-wide fallback for later users' commands.
if [[ -n "${ZUSE_GITHUB_STARTUP_CONTEXT:-}" && "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then
  export ZUSE_GITHUB_CONTEXT_DIR="${ZUSE_USER_DATA:?}/github-executions/repository-setup"
  (umask 077; mkdir -p "$ZUSE_GITHUB_CONTEXT_DIR"; printf '%s\n' "$ZUSE_GITHUB_STARTUP_CONTEXT" >"$ZUSE_GITHUB_CONTEXT_DIR/request.json")
fi
progress() {
  local progress_dir="${ZUSE_WORKSPACE_RUNTIME_STATUS_DIR:-/var/lib/zuse/workspace}"
  if [[ -d "$progress_dir" ]]; then
    printf '%s\n' "$1" >"$progress_dir/repository-progress"
  fi
}
progress checking-repository
# A machine fork already contains the source checkout, including local commits,
# staged edits and untracked files. Branch directly from that captured HEAD.
if [[ "${ZUSE_FORK_CHECKOUT:-}" == 1 ]]; then
  base_ref=HEAD
fi
# Never reset a recovered checkout: it may already contain the user's edits.
git -C "$workspace" rev-parse --git-dir >/dev/null
git check-ref-format --branch "$branch" >/dev/null
if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then
  git -C "$workspace" remote set-url origin "${ZUSE_REPOSITORY_URL:?}"
else
  [[ -r "$workspace" && -w "$workspace" && -x "$workspace" ]]
  # A custom checkout's remote/credential helper belongs to its owner.
  actual="$(git -C "$workspace" remote get-url origin)"
  "${ZUSE_RUNTIME_NODE:-node}" - "$actual" "${ZUSE_REPOSITORY_URL:?}" <<'JS'
const identity = value => { const url = new URL(value.replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')); return (url.hostname + url.pathname).replace(/\.git$/, '').toLowerCase(); };
if (identity(process.argv[2]) !== identity(process.argv[3])) process.exit(1);
JS
fi
if [[ "$(git -C "$workspace" branch --show-current)" != "$branch" ]]; then
  progress switching-branch
  if git -C "$workspace" show-ref --verify --quiet "refs/heads/$branch"; then
    # --merge preserves overlapping unstaged edits as conflicts, but can lose
    # staged changes. Keep Git's normal safety checks when the index is dirty.
    if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]] && git -C "$workspace" diff --cached --quiet; then
      git -C "$workspace" switch --merge "$branch"
    else
      git -C "$workspace" switch "$branch"
    fi
  else
    if [[ "$base_ref" =~ ^refs/pull/([1-9][0-9]*)/head$ ]]; then
      # GitHub does not include fork heads in a normal clone. Fetch the PR ref
      # from the connected base repository only when creating the branch.
      # FETCH_HEAD does not make the new branch track GitHub's read-only PR ref.
      progress fetching-repository
      git -C "$workspace" fetch --no-tags origin "$base_ref"
      progress switching-branch
      base_ref=FETCH_HEAD
    elif [[ "${ZUSE_FORK_CHECKOUT:-}" != 1 && "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then
      # The image checkout is a cache of unknown age. A fresh managed branch
      # starts from the latest requested base; the updated remote-tracking ref
      # keeps the same upstream relationship as before. A failed fetch fails
      # preparation visibly; retry recreates the branch from a fresh fetch.
      progress fetching-repository
      remote_base="${base_ref#origin/}"
      git -C "$workspace" fetch --no-tags origin "$remote_base"
      if git -C "$workspace" rev-parse --verify "refs/remotes/origin/$remote_base^{commit}" >/dev/null 2>&1; then
        base_ref="origin/$remote_base"
      else
        base_ref=FETCH_HEAD
      fi
      progress switching-branch
    fi
    git -C "$workspace" rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || \
      base_ref="origin/${base_ref#origin/}"
    git -C "$workspace" switch -c "$branch" "$base_ref"
  fi
fi
