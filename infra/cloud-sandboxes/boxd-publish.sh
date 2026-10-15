#!/usr/bin/env bash

set -euo pipefail

version="${1:?usage: boxd-publish.sh <version>}"
: "${BOXD_API_KEY:?BOXD_API_KEY is required}"
snapshot_name="zuse-base-v$version"
snapshot_wait_attempts="${BOXD_SNAPSHOT_WAIT_ATTEMPTS:-180}"
runtime_port=47837

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
provision_dir=/tmp/zuse-provision

sharing_args=()
org_args=()
if [ -n "${BOXD_ORG:-}" ]; then
	org_args=(--org "$BOXD_ORG")
	sharing_args=(--shared)
fi

case "${BOXD_MACHINE_SIZE:-default}" in
small) size_args=(--vcpu 1) ;;
default) size_args=(--vcpu 2) ;;
large) size_args=(--vcpu 4) ;;
*)
	echo "BOXD_MACHINE_SIZE must be small, default, or large" >&2
	exit 1
	;;
esac

machine_exec() {
	local timeout="$1"
	shift
	boxd machine exec ${org_args[@]+"${org_args[@]}"} "$machine_id" --timeout "$timeout" -- "$@"
}

echo "==> building runtime artifacts"
"$script_dir/prepare-artifacts.sh"

echo "==> authenticating publisher"
BOXD_TOKEN="$(jq -n '{api_key: env.BOXD_API_KEY}' | curl --proto '=https' --proto-redir '=https' -fsS --max-time 60 \
	-H 'Content-Type: application/json' --data-binary @- https://app.boxd.sh/api/v1/auth/token | jq -er '.token | select(type == "string" and length > 0)')"
export BOXD_TOKEN

echo "==> creating builder machine"

machine_id="$(boxd machine new ${org_args[@]+"${org_args[@]}"} "zuse-template-builder-$(date +%s)" --isolated ${sharing_args[@]+"${sharing_args[@]}"} ${size_args[@]+"${size_args[@]}"} --auto-hibernate-timeout 0 --json | jq -r '.id')"
if [[ -z "$machine_id" || "$machine_id" == "null" ]]; then
	echo "error: boxd machine new returned no machine id" >&2
	exit 1
fi
echo "    machine: $machine_id"
trap 'boxd machine remove ${org_args[@]+"${org_args[@]}"} "$machine_id" --confirm --json >/dev/null 2>&1 || true' EXIT

echo "==> waiting for the machine to become usable"

ready=""
for _ in $(seq 1 60); do
	if boxd machine exec ${org_args[@]+"${org_args[@]}"} "$machine_id" --timeout 15 -- true >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 2
done
[ -n "$ready" ] || {
	echo "builder machine did not become usable in time" >&2
	exit 1
}

echo "==> uploading provisioning payload"
machine_exec 60 "mkdir -p $provision_dir/artifacts $provision_dir/boxd"
for file in provision.sh install-grok.sh project-builder.sh workspace-bootstrap.sh workspace-runtime.sh git-askpass.sh github-auth.sh repository-script.ts sshd_config; do
	boxd machine cp ${org_args[@]+"${org_args[@]}"} "$script_dir/$file" "$machine_id:$provision_dir/$file"
done
for file in "$script_dir"/boxd/*; do
	boxd machine cp ${org_args[@]+"${org_args[@]}"} "$file" "$machine_id:$provision_dir/boxd/$(basename "$file")"
done
for file in "$script_dir"/artifacts/*; do
	boxd machine cp ${org_args[@]+"${org_args[@]}"} "$file" "$machine_id:$provision_dir/artifacts/$(basename "$file")"
done
machine_exec 60 "chmod +x $provision_dir/provision.sh $provision_dir/boxd/install.sh"

echo "==> installing the template (this takes several minutes)"
machine_exec 1800 "sudo -n ZUSE_PROVISION_DIR=$provision_dir bash $provision_dir/boxd/install.sh && sudo -n rm -rf $provision_dir"

echo "==> registering the runtime route"

boxd machine proxy add ${org_args[@]+"${org_args[@]}"} "p$runtime_port" --vm "$machine_id" --port "$runtime_port" >/dev/null

echo "==> saving snapshot $snapshot_name"
boxd snapshots save ${org_args[@]+"${org_args[@]}"} "$machine_id" "$snapshot_name" --json >/dev/null
status=""
for _ in $(seq 1 "$snapshot_wait_attempts"); do
	status="$(boxd snapshots list ${org_args[@]+"${org_args[@]}"} --json | jq -r --arg name "$snapshot_name" '.[] | select(.name == $name) | .status')"
	case "$status" in
	ready) break ;;
	failed)
		echo "snapshot save failed" >&2
		exit 1
		;;
	esac
	sleep 5
done
[ "$status" = "ready" ] || {
	echo "snapshot did not become ready in time" >&2
	exit 1
}

echo "==> done. Configure the API with:"
echo "    BOXD_TEMPLATE_SNAPSHOT=$snapshot_name"
echo "    BOXD_TEMPLATE_VERSION=$version"
