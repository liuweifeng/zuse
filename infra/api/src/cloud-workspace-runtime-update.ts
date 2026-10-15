import type { CloudAccountImageRuntime } from "@zuse/contracts";
import type { CloudProjectBuildRecord } from "./cloud-workspace-store.ts";

/** Startup validates the pinned installation; channel changes belong to explicit update operations. */
// The gateway can carry old runtime RPCs without decoding them. This is independent
// of the app/client minimum; old desktops must retain access to their runtimes.
export const MIN_RETAINED_RUNTIME_WIRE_PROTOCOL = 5;

export const WORKSPACE_RUNTIME_UPDATE_SCRIPT = `
ensure_workspace_runtime() {
  local status_dir="\${ZUSE_WORKSPACE_RUNTIME_STATUS_DIR:-/var/lib/zuse/workspace}"
  local metadata="\${ZUSE_CURRENT_LINK:-/opt/zuse/current}/runtime-metadata.json"
  # Legacy images without a configured protocol retain their installed launcher.
  [[ -n "\${ZUSE_RUNTIME_WIRE_PROTOCOL:-}" ]] || return 0
  if "\${ZUSE_RUNTIME_NODE:-node}" -e '
    try {
      const metadata = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const expected = Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL);
      process.exit(Number.isInteger(expected) && expected > 0 &&
        metadata.schemaVersion === 1 && Number.isInteger(metadata.wireProtocolVersion) &&
        metadata.wireProtocolVersion >= ${MIN_RETAINED_RUNTIME_WIRE_PROTOCOL} &&
        metadata.wireProtocolVersion <= expected &&
        (process.env.ZUSE_SNAPSHOT_NATIVE !== "1" || metadata.snapshotSupportVersion === 1) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$metadata"; then return 0; fi
  phase=runtime-update-required
  mkdir -p "$status_dir"
  printf 'runtime-update-required\\n' >"$status_dir/failure-phase"
  touch "$status_dir/failed"
  return 1
}
`;

/** Installed release metadata written by the runtime build into every image. */
export const INSTALLED_RUNTIME_METADATA_FILE =
	"/opt/zuse/current/runtime-metadata.json";

const installedRuntime = (
	metadata: unknown,
): CloudAccountImageRuntime | undefined => {
	if (typeof metadata !== "object" || metadata === null) return undefined;
	const { appVersion, wireProtocolVersion } = metadata as Record<
		string,
		unknown
	>;
	return typeof appVersion === "string" &&
		typeof wireProtocolVersion === "number" &&
		Number.isInteger(wireProtocolVersion)
		? { appVersion, wireProtocolVersion }
		: undefined;
};

/** Absent when the image predates recording or its metadata is unreadable. */
export const parseInstalledRuntime = (
	text: string,
): CloudAccountImageRuntime | undefined => {
	try {
		return installedRuntime(JSON.parse(text));
	} catch {
		return undefined;
	}
};

export const imageBuildRuntime = (
	build: Pick<CloudProjectBuildRecord, "settings">,
): CloudAccountImageRuntime | undefined =>
	installedRuntime(build.settings?.runtime);
