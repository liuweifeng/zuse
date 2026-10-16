#!/usr/bin/env bash
set -euo pipefail

status_dir="${ZUSE_WORKSPACE_RUNTIME_STATUS_DIR:-/var/lib/zuse/workspace}"
repository_script="${ZUSE_WORKSPACE_REPOSITORY_SCRIPT:-/var/lib/zuse/project-build/workspace-repository.sh}"
runtime_launcher=/var/lib/zuse/project-build/workspace-runtime.sh
[[ -f "$runtime_launcher" ]] || runtime_launcher=/usr/local/lib/zuse/workspace-runtime.sh
source "$runtime_launcher"
if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" == 1 ]]; then source /etc/zuse/snapshot.env; fi
initialize_workspace_runtime_attempt
acquire_workspace_runtime_lock
workspace_runtime_timing runtime.bootstrap-shell-enter
workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
rm -f \
  "$status_dir/ready" \
  "$status_dir/failed" \
  "$status_dir/credentials-ready" \
  "$status_dir/repository-ready" \
  "$status_dir/rekeyed" \
  "$status_dir/failure-phase"
phase=initializing

if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" == 1 ]]; then
  phase=snapshot-runtime-incompatible
  "$ZUSE_RUNTIME_NODE" --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
const manifest = JSON.parse(readFileSync('/etc/zuse/snapshot.json', 'utf8'));
const runtime = JSON.parse(readFileSync('/opt/zuse/current/runtime-metadata.json', 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.runtimeUser !== userInfo().username || runtime.snapshotSupportVersion !== 1 || runtime.wireProtocolVersion !== Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL)) process.exit(1);
JS
  phase=initializing
  owner_file="$status_dir/owner"
  if [[ -f "$owner_file" ]]; then
    [[ "$(cat "$owner_file")" == "$ZUSE_CLOUD_WORKSPACE_ID" ]] || { phase=snapshot-inherited-runtime-state; false; }
  elif [[ -e "$ZUSE_USER_DATA/zuse.sqlite" ]]; then
    phase=snapshot-inherited-runtime-state
    false
  fi
  printf '%s\n' "$ZUSE_CLOUD_WORKSPACE_ID" >"$owner_file"
  mkdir -p "$ZUSE_USER_DATA" "${ZUSE_SSH_DIRECTORY:?}"
  chmod 700 "$ZUSE_USER_DATA" "$ZUSE_SSH_DIRECTORY"
  if [[ ! -f "$ZUSE_SSH_DIRECTORY/host_ed25519_key" ]]; then
    ssh-keygen -q -t ed25519 -N "" -f "$ZUSE_SSH_DIRECTORY/host_ed25519_key"
  fi
  sed -e "s|/home/zuse/.ssh|$ZUSE_SSH_DIRECTORY|g" -e "s/^AllowUsers zuse$/AllowUsers $(id -un)/" /usr/local/share/zuse/sshd_config >"$ZUSE_SSH_DIRECTORY/sshd_config"
  chmod 600 "$ZUSE_SSH_DIRECTORY/sshd_config"
else

rm -rf /home/zuse/.config/gh
mkdir -p "$ZUSE_USER_DATA"
chown zuse:zuse "$ZUSE_USER_DATA"
chmod 700 "$ZUSE_USER_DATA"

github_auth=/var/lib/zuse/project-build/github-auth.sh
[[ -r "$github_auth" ]] || github_auth=/usr/local/bin/zuse-github-auth
if [[ -r "$github_auth" ]]; then

  [[ -x "$github_auth" ]] || chmod u+x "$github_auth"
  export ZUSE_GITHUB_AUTH_BIN="$github_auth"
  mkdir -p /home/zuse/.local/bin
  ln -sf "$github_auth" /home/zuse/.local/bin/gh

  export PATH="/home/zuse/.local/bin:$PATH"

  for rc in /home/zuse/.profile /home/zuse/.bashrc; do
    grep -qs 'zuse-github-auth shim' "$rc" ||
      printf '\n# zuse-github-auth shim: GitHub App credentials, never gh auth login.\nPATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
  done
  "$github_auth" install ||
    printf '%s\n' 'Could not install the GitHub credential helper.' >&2
else
  printf '%s\n' \
    'zuse-github-auth is missing from this sandbox, so GitHub access is unavailable. Rebuild the project image to ship it; gh auth login is never the fix.' >&2
fi

mkdir -p /home/zuse/.ssh
chmod 700 /home/zuse/.ssh
rm -f /home/zuse/.ssh/host_ed25519_key /home/zuse/.ssh/host_ed25519_key.pub \
  /home/zuse/.ssh/authorized_keys
ssh-keygen -q -t ed25519 -N "" -f /home/zuse/.ssh/host_ed25519_key

fi

export ZUSE_RUNTIME_KIND=cloud-workspace
export ZUSE_CLOUD_WORKSPACE_ID
export ZUSE_HOST=127.0.0.1
export ZUSE_PORT=47837
export ZUSE_AUTH_POLICY=protected
export ZUSE_ENABLE_PAIRING=0
export ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment
export ZUSE_SERVER_READY_STDOUT=1

credentials_event="$status_dir/credentials-ready-event"
rm -f "$credentials_event"
mkfifo -m 600 "$credentials_event"
runtime_command=("${ZUSE_RUNTIME_NODE:-node}" /opt/zuse/current/bin.mjs serve)
[[ -f /opt/zuse/current/bin.mjs ]] || runtime_command=(zuse serve --foreground)
phase=starting-runtime
workspace_runtime_timing runtime.exec
(
  exec_workspace_runtime "${runtime_command[@]}" >>"$status_dir/runtime.log" 2>&1
) &
runtime_pid=$!
(IFS= read -r _ <"$credentials_event") &
credentials_wait_pid=$!

phase=preparing-credentials
set +e
wait -n "$runtime_pid" "$credentials_wait_pid"
set -e
if [[ ! -f "$status_dir/credentials-ready" ]]; then
  kill "$credentials_wait_pid" 2>/dev/null || true
  false
fi
[[ ! -f "$status_dir/failed" ]]
rm -f "$credentials_event"

phase=syncing-repository
bash "$repository_script" >>"$status_dir/runtime.log" 2>&1 &
repository_pid=$!
wait "$repository_pid"
phase=ready
touch "$status_dir/ready"
touch "$status_dir/repository-ready"
wait "$runtime_pid"
