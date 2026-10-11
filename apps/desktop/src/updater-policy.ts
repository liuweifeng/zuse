import type { UpdateStatus } from "@zuse/contracts";

export function shouldAutoInstallUpdateOnQuit(
	_platform: NodeJS.Platform,
): boolean {
	// Every platform must first drain the independent engine through our install path.
	return false;
}

export function shouldInstallPendingUpdateOnQuit(options: {
	platform: NodeJS.Platform;
	status: UpdateStatus;
	installing: boolean;
}): boolean {
	return options.status.kind === "ready" && !options.installing;
}
