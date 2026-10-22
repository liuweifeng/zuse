import type {
	MasterCapabilities,
	MasterSnapshot,
	MasterWorker,
} from "@zuse/contracts";

/**
 * Missing capabilities (older servers) mean everything is off: work stays in
 * the home environment and generated screens never execute.
 */
export const masterCapabilities = (
	snapshot: Pick<MasterSnapshot, "capabilities">,
): MasterCapabilities => ({
	crossEnvironment: snapshot.capabilities?.crossEnvironment === true,
	homeTransfer: snapshot.capabilities?.homeTransfer === true,
	generatedScreens: snapshot.capabilities?.generatedScreens === true,
});

/** Environments whose repositories may be offered for binding to the Master. */
export const repositoryEnvironmentIds = (
	home: string,
	connected: readonly string[],
	capabilities: MasterCapabilities,
): readonly string[] =>
	capabilities.crossEnvironment ? [...new Set([home, ...connected])] : [home];

/**
 * Whether supervision controls (stop, resume, mark done) may act on a slave.
 * Remote slaves stay visible and openable either way; only mutation is gated.
 */
export const canControlWorker = (
	worker: Pick<MasterWorker, "environmentId">,
	home: string,
	capabilities: MasterCapabilities,
): boolean => capabilities.crossEnvironment || worker.environmentId === home;
