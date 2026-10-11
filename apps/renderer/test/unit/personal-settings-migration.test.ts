import { type EnvironmentId, SettingsFile } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { getLocalEnvironmentId } from "../../src/lib/rpc-client.ts";
import {
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";
import {
	readPersonalSettingsForMigration,
	useSettingsStore,
} from "../../src/lib/settings-client-bus.ts";

afterEach(() => {
	resetSessionTimelineClientBusForTest();
	vi.unstubAllGlobals();
});

it("reads acknowledged local settings through ClientBus rather than uploading a stale projection", async () => {
	observeRendererAccount(null);
	vi.stubGlobal("location", new URL("http://localhost"));
	const base = SettingsFile.make({
		...useSettingsStore.getState(),
		schemaVersion: 1,
		subagents: { enableForNewSessions: false, presets: {} },
		branchNamingPrefix: "old-stream",
		providerBinaryPaths: { codex: "/private/bin" },
		appearanceMode: "dark",
	});
	const read = vi
		.fn()
		.mockReturnValueOnce(Effect.succeed(base))
		.mockReturnValueOnce(
			Effect.succeed(
				SettingsFile.make({
					...base,
					branchNamingPrefix: "acknowledged",
				}),
			),
		);
	const requested: EnvironmentId[] = [];
	setSessionTimelineRpcClientForTest(async (environmentId) => {
		requested.push(environmentId);
		return {
			"settings.get": read,
			"settings.stream": () =>
				Stream.concat(Stream.succeed(base), Stream.never),
		} as never;
	});
	const values = await readPersonalSettingsForMigration();
	expect(read).toHaveBeenCalledTimes(2);
	expect(
		requested.every(
			(environmentId) => environmentId === getLocalEnvironmentId(),
		),
	).toBe(true);
	expect(values.branchNamingPrefix).toBe("acknowledged");
	expect(values).not.toHaveProperty("appearanceMode");
	expect(values).not.toHaveProperty("providerBinaryPaths");
	expect(values.defaultModelByProvider?.codex).toBeTruthy();
});
