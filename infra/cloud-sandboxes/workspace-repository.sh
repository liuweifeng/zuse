#!/usr/bin/env bash
set -euo pipefail

workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
branch="${ZUSE_BRANCH:?}"
base_ref="${ZUSE_BASE_REF:?}"

if [[ -n "${ZUSE_GITHUB_STARTUP_CONTEXT:-}" && "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then
  export ZUSE_GITHUB_CONTEXT_DIR="${ZUSE_USER_DATA:?}/github-executions/repository-setup"
  (umask 077; mkdir -p "$ZUSE_GITHUB_CONTEXT_DIR"; printf '%s\n' "$ZUSE_GITHUB_STARTUP_CONTEXT" >"$ZUSE_GITHUB_CONTEXT_DIR/request.json")

  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=''
  export GIT_CONFIG_KEY_1=credential.https://github.com.helper
  printf -v GIT_CONFIG_VALUE_1 '/bin/bash %q credential' "${ZUSE_GITHUB_AUTH_BIN:?}"
  export GIT_CONFIG_VALUE_1
fi
progress() {
  local progress_dir="${ZUSE_WORKSPACE_RUNTIME_STATUS_DIR:-/var/lib/zuse/workspace}"
  if [[ -d "$progress_dir" ]]; then
    printf '%s\n' "$1" >"$progress_dir/repository-progress"
  fi
}
progress checking-repository

if [[ "${ZUSE_FORK_CHECKOUT:-}" == 1 ]]; then
  base_ref=HEAD
fi

git -C "$workspace" rev-parse --git-dir >/dev/null
git check-ref-format --branch "$branch" >/dev/null
if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then
  git -C "$workspace" remote set-url origin "${ZUSE_REPOSITORY_URL:?}"
else
  [[ -r "$workspace" && -w "$workspace" && -x "$workspace" ]]

  actual="$(git -C "$workspace" remote get-url origin)"
  "${ZUSE_RUNTIME_NODE:-node}" - "$actual" "${ZUSE_REPOSITORY_URL:?}" <<'JS'
const identity = value => { const url = new URL(value.replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')); return (url.hostname + url.pathname).replace(/\.git$/, '').toLowerCase(); };
if (identity(process.argv[2]) !== identity(process.argv[3])) process.exit(1);
JS
fi
if [[ "$(git -C "$workspace" branch --show-current)" != "$branch" ]]; then
  progress switching-branch
  if git -C "$workspace" show-ref --verify --quiet "refs/heads/$branch"; then

    if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]] && git -C "$workspace" diff --cached --quiet; then
      git -C "$workspace" switch --merge "$branch"
    else
      git -C "$workspace" switch "$branch"
    fi
  else
    if [[ "$base_ref" =~ ^refs/pull/([1-9][0-9]*)/head$ ]]; then

      progress fetching-repository
      git -C "$workspace" fetch --no-tags origin "$base_ref"
      progress switching-branch
      base_ref=FETCH_HEAD
    elif [[ "${ZUSE_FORK_CHECKOUT:-}" != 1 && "${ZUSE_SNAPSHOT_NATIVE:-}" != 1 ]]; then

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
