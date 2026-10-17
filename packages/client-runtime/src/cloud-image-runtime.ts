import type { CloudAccountImage } from "@zuse/contracts";

/**
 * A managed image whose runtime predates `protocolVersion`. Images never pick
 * up a newer runtime on their own, so every chat they start would be legacy.
 * Builds recorded before runtime tracking count as behind.
 */
export const cloudImageRuntimeBehind = (
	image: CloudAccountImage,
	protocolVersion: number,
): boolean =>
	image.source !== "custom-snapshot" &&
	(image.state === "ready" || image.state === "outdated") &&
	(image.runtime?.wireProtocolVersion ?? 0) < protocolVersion;
