import type { UpdateStatus } from "@zuse/contracts";

export function shouldAutoInstallUpdateOnQuit(
	_platform: NodeJS.Platform,
): boolean {
	return false;
}

export function shouldInstallPendingUpdateOnQuit(options: {
	platform: NodeJS.Platform;
	status: UpdateStatus;
	installing: boolean;
}): boolean {
	return options.status.kind === "ready" && !options.installing;
}
