#!/usr/bin/env bash
# Run against a newly built base before publishing it for other accounts.
set -euo pipefail
node --version
claude --version
codex --version
command -v zuse
node --experimental-sqlite -e "require('node:sqlite'); console.log('sqlite: available')"
test -x /usr/local/bin/zuse-project-builder
test -f /usr/local/lib/zuse/runtime-updater.mjs
for directory in /home/repos /home/zuse/.zuse-data; do
  test -d "$directory"
  test -z "$(find "$directory" -mindepth 1 -print -quit)"
done
# /run is ephemeral on VM providers; it may be absent after snapshot restore.
if test -d /run/zuse-secrets; then
  test -z "$(find /run/zuse-secrets -mindepth 1 -print -quit)"
fi
for file in /home/zuse/.claude/.credentials.json /home/zuse/.codex/auth.json \
  /home/zuse/.config/gh/hosts.yml /home/zuse/.ssh/id_ed25519 \
  /home/zuse/.ssh/id_rsa /root/.npmrc /home/zuse/.npmrc; do
  test ! -e "$file"
done
printf 'CLEAN_BASE_OK\n'
