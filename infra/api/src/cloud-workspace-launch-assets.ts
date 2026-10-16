import GITHUB_AUTH_SOURCE from "../../cloud-sandboxes/github-auth.sh";
import WORKSPACE_BOOTSTRAP_SOURCE from "../../cloud-sandboxes/workspace-bootstrap.sh";
import WORKSPACE_REPOSITORY_SOURCE from "../../cloud-sandboxes/workspace-repository.sh";
import WORKSPACE_RUNTIME_SOURCE from "../../cloud-sandboxes/workspace-runtime.sh";
import type { CloudProjectBuildRecord } from "./cloud-workspace-store.ts";
import { sha256Hex } from "./crypto.ts";
import type { SandboxOfferConfig } from "./sandbox-provider-module.ts";

/**
 * Launch scripts the API ships with every workspace. The managed image build
 * writes the same list, so a fresh restore of that image already holds them
 * when the recorded build digest matches the current sources.
 */
export const WORKSPACE_BOOTSTRAP_FILE =
	"/var/lib/zuse/project-build/workspace-bootstrap.sh";
export const WORKSPACE_RUNTIME_FILE =
	"/var/lib/zuse/project-build/workspace-runtime.sh";

export const GITHUB_AUTH_FILE = "/var/lib/zuse/project-build/github-auth.sh";
export const WORKSPACE_REPOSITORY_FILE =
	"/var/lib/zuse/project-build/workspace-repository.sh";

export const runtimeSigningKeyPath = (snapshot = false) =>
	snapshot
		? "/var/lib/zuse/runtime-signing-public.jwk"
		: "/home/zuse/.zuse-runtime-signing-public.jwk";

export interface LaunchAssetFile {
	readonly path: string;
	readonly contents: string;
}

/** One list for image writes, workspace writes, and the digest that compares them. */
export const launchAssetFiles = (
	config: Pick<SandboxOfferConfig, "runtimeSigningPublicJwk">,
	snapshot = false,
): ReadonlyArray<LaunchAssetFile> => [
	{ path: WORKSPACE_REPOSITORY_FILE, contents: WORKSPACE_REPOSITORY_SOURCE },
	{ path: GITHUB_AUTH_FILE, contents: GITHUB_AUTH_SOURCE },
	{ path: WORKSPACE_BOOTSTRAP_FILE, contents: WORKSPACE_BOOTSTRAP_SOURCE },
	{ path: WORKSPACE_RUNTIME_FILE, contents: WORKSPACE_RUNTIME_SOURCE },
	...(config.runtimeSigningPublicJwk === undefined
		? []
		: [
				{
					path: runtimeSigningKeyPath(snapshot),
					contents: config.runtimeSigningPublicJwk,
				},
			]),
];

export const launchAssetsDigest = (files: ReadonlyArray<LaunchAssetFile>) =>
	sha256Hex(
		JSON.stringify(files.map(({ path, contents }) => [path, contents])),
	);

const LAUNCH_ASSETS_DIGEST = "launchAssetsDigest";
const LAUNCH_ASSETS_DIGEST_PENDING = "launchAssetsDigestPending";

type BuildSettings = CloudProjectBuildRecord["settings"];

/** Recorded when the image sandbox receives the files; not yet evidence of an image. */
export const withPendingLaunchAssetsDigest = (
	settings: BuildSettings,
	digest: string,
): NonNullable<BuildSettings> => ({
	...settings,
	[LAUNCH_ASSETS_DIGEST]: undefined,
	[LAUNCH_ASSETS_DIGEST_PENDING]: digest,
});

/**
 * Promote the pending digest once preparation succeeded and before the
 * snapshot is captured. Sources that changed during the build leave the image
 * without a digest, so workspaces fall back to writing the files.
 */
export const promoteLaunchAssetsDigest = (
	settings: BuildSettings,
	currentDigest: string,
): NonNullable<BuildSettings> => {
	const { [LAUNCH_ASSETS_DIGEST_PENDING]: pending, ...rest } = settings ?? {};
	return {
		...rest,
		[LAUNCH_ASSETS_DIGEST]: pending === currentDigest ? pending : undefined,
	};
};

/** A fresh restore of this image already contains the current launch files. */
export const imageLaunchAssetsMatch = (
	build: Pick<CloudProjectBuildRecord, "settings">,
	currentDigest: string,
): boolean => build.settings?.[LAUNCH_ASSETS_DIGEST] === currentDigest;
