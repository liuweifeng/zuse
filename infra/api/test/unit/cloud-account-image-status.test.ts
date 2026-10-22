import { describe, expect, test } from "vitest";

import {
	accountImageBuildsForHosting,
	cloudAccountImageConfiguration,
	codexAuthModeForAccountBuild,
	isCloudAccountImageOutdated,
	providerAuthModeForAccountBuild,
	selectActiveAccountImageBuild,
} from "../../src/cloud-workspace-routes.ts";
import type { CloudProjectBuildRecord } from "../../src/cloud-workspace-store.ts";

const imageStatus = (overrides: {
	readonly imagePromotedAtMs?: number;
	readonly configurationChanged?: boolean;
	readonly imageTemplateVersion?: string;
	readonly currentTemplateVersion?: string;
	readonly projects?: ReadonlyArray<{
		readonly state: string;
		readonly updatedAtMs: number;
	}>;
	readonly providers?: ReadonlyArray<{
		readonly providerId?: string;
		readonly verifiedAt?: number;
	}>;
}) =>
	isCloudAccountImageOutdated({
		imagePromotedAtMs: 200,
		imageTemplateVersion: "runtime-v2",
		currentTemplateVersion: "runtime-v2",
		projects: [{ state: "ready", updatedAtMs: 200 }],
		providers: [{ verifiedAt: 100 }],
		...overrides,
	});

describe("cloud account image status", () => {
	test("is ready after projects are marked ready during promotion", () => {
		expect(imageStatus({})).toBe(false);
	});

	test("is outdated when a repository changes after promotion", () => {
		expect(
			imageStatus({ projects: [{ state: "ready", updatedAtMs: 201 }] }),
		).toBe(true);
	});

	test("is outdated when provider auth changes after promotion", () => {
		expect(imageStatus({ providers: [{ verifiedAt: 201 }] })).toBe(true);
	});

	test("does not rebuild a broker image when account-level Codex auth rotates", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [
					{ providerId: "codex", verifiedAt: 201 },
					{ providerId: "claude", verifiedAt: 100 },
				],
				codexAuthDeliveryVersion: 1,
			}),
		).toBe(false);
	});

	test("marks a pre-broker image outdated when broker enrollment is required", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [],
				requiredCodexAuthDeliveryVersion: 1,
			}),
		).toBe(true);
	});

	test("does not rebuild provider-broker images when account auth changes", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [
					{ providerId: "claude", verifiedAt: 201 },
					{ providerId: "grok", verifiedAt: 202 },
				],
				providerAuthDeliveryVersion: 1,
			}),
		).toBe(false);
	});

	test("requires explicit provider-broker image capability", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [],
				requiredProviderAuthDeliveryVersion: 1,
			}),
		).toBe(true);
	});

	test("enrolls only subscription-backed Codex images in the broker", () => {
		const build = (method: "subscription" | "api-key") =>
			({
				buildId: "build-1",
				projectId: "project-1",
				accountId: "account-1",
				provider: "e2b",
				templateVersion: "runtime-v2",
				configurationDigest: "digest",
				settings: {
					codexAuthDeliveryVersion: 1,
					providers: [{ providerId: "codex", method }],
				},
				state: "ready" as const,
				idempotencyKey: "build-1",
				nextActionAtMs: 0,
				revision: 0,
				createdAtMs: 0,
				updatedAtMs: 0,
			}) satisfies CloudProjectBuildRecord;
		expect(codexAuthModeForAccountBuild(build("subscription"), true)).toBe(
			"broker-v1",
		);
		expect(codexAuthModeForAccountBuild(build("api-key"), true)).toBe(
			"legacy-image",
		);
		expect(codexAuthModeForAccountBuild(build("subscription"), false)).toBe(
			"legacy-image",
		);
		expect(providerAuthModeForAccountBuild(build("subscription"), true)).toBe(
			"legacy-image",
		);
		expect(
			providerAuthModeForAccountBuild(
				{
					...build("subscription"),
					settings: { providerAuthDeliveryVersion: 1 },
				},
				true,
			),
		).toBe("broker-v1");
	});

	test("is outdated when the runtime template changes", () => {
		expect(imageStatus({ currentTemplateVersion: "runtime-v3" })).toBe(true);
	});

	test("selects the newest active snapshot from newest-first builds", () => {
		const build = (buildId: string, updatedAtMs: number) =>
			({
				buildId,
				state: "ready",
				snapshotId: `snapshot-${buildId}`,
				templateVersion: "runtime-v2",
				updatedAtMs,
			}) as CloudProjectBuildRecord;
		expect(
			selectActiveAccountImageBuild(
				[build("newest", 200), build("oldest", 100)],
				"runtime-v2",
			)?.buildId,
		).toBe("newest");
	});
});

describe("image configuration freshness across providers", () => {
	const configuration = (
		projects: readonly { projectId: string; configurationDigest: string }[],
	) =>
		JSON.stringify(
			cloudAccountImageConfiguration({
				mode: "rebuild",
				templateVersion: "runtime-v2",
				codexAuthDeliveryVersion: 1,
				providerAuthDeliveryVersion: 1,
				projects,
			}),
		);
	test("another provider finishing does not invalidate an unchanged image", () => {
		const original = {
			projectId: "repo",
			configurationDigest: "unchanged",
			state: "ready",
			updatedAtMs: 100,
		};
		const afterOtherBuild = { ...original, updatedAtMs: 300 };
		expect(
			imageStatus({
				projects: [afterOtherBuild],
				configurationChanged:
					configuration([original]) !== configuration([afterOtherBuild]),
			}),
		).toBe(false);
	});
	test("configuration edits and repository removal invalidate the image even without a newer timestamp", () => {
		const projects = [{ projectId: "repo", configurationDigest: "original" }];
		for (const next of [
			[],
			[{ projectId: "repo", configurationDigest: "changed" }],
		]) {
			expect(
				imageStatus({
					configurationChanged: configuration(projects) !== configuration(next),
				}),
			).toBe(true);
		}
	});
	test("repository ordering does not invalidate a build", () => {
		const projects = [
			{ projectId: "b", configurationDigest: "b" },
			{ projectId: "a", configurationDigest: "a" },
		];
		expect(configuration(projects)).toBe(
			configuration([...projects].reverse()),
		);
	});
});

describe("account image status after switching hosting", () => {
	const managed: CloudProjectBuildRecord = {
		buildId: "managed",
		projectId: null,
		accountId: "account",
		provider: "boxd",
		configurationDigest: "config",
		idempotencyKey: "managed",
		nextActionAtMs: 0,
		revision: 1,
		updatedAtMs: 100,
		state: "ready",
		createdAtMs: 100,
		snapshotId: "managed-snapshot",
		templateVersion: "runtime",
	};
	const imported = (
		state: CloudProjectBuildRecord["state"],
	): CloudProjectBuildRecord => ({
		...managed,
		buildId: "import",
		state,
		createdAtMs: 200,
		snapshotId: "private-snapshot",
		templateVersion: "runtime:connection:key-old",
		settings: { source: "custom-snapshot", providerConnectionId: "key-old" },
	});

	test.each([
		"ready",
		"failed",
		"building",
	] as const)("ignores a disconnected %s import in managed hosting status", (state) => {
		expect(
			accountImageBuildsForHosting([managed, imported(state)], "runtime"),
		).toEqual([managed]);
		expect(accountImageBuildsForHosting([imported(state)], "runtime")).toEqual(
			[],
		);
	});
	test("retains imports only for their active credential version", () => {
		const build = imported("ready");
		expect(
			accountImageBuildsForHosting([build], "new-runtime:connection:key-old"),
		).toEqual([build]);
		expect(
			accountImageBuildsForHosting([build], "runtime:connection:key-new"),
		).toEqual([]);
	});
	test("retains outdated managed images for rebuild status", () => {
		expect(accountImageBuildsForHosting([managed], "runtime-new")).toEqual([
			managed,
		]);
	});
});
