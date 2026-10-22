import { bundledResolvedModelCatalog, EnvironmentId } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ active: "local", dispatch: vi.fn() }));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: fixture.dispatch,
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: fixture.active }),
	},
}));
vi.mock("../../src/lib/format-error.ts", () => ({
	formatError: (error: unknown) => String(error),
}));

import {
	resetModelCatalogForEnvironment,
	useModelCatalogStore,
} from "../../src/store/model-catalog.ts";

beforeEach(() => {
	fixture.active = "local";
	fixture.dispatch.mockReset();
	resetModelCatalogForEnvironment();
});
it("fetches and deduplicates each environment without replacing the active catalog", async () => {
	const local = bundledResolvedModelCatalog();
	const remote = {
		...bundledResolvedModelCatalog(),
		version: "remote-catalog",
	};
	fixture.dispatch.mockImplementation(async ({ environmentId }) => ({
		result: environmentId === "cloud" ? remote : local,
	}));
	await useModelCatalogStore.getState().ensureLoaded();
	await Promise.all([
		useModelCatalogStore
			.getState()
			.ensureLoaded({ environmentId: EnvironmentId.make("cloud") }),
		useModelCatalogStore
			.getState()
			.ensureLoaded({ environmentId: EnvironmentId.make("cloud") }),
	]);
	expect(fixture.dispatch).toHaveBeenCalledTimes(2);
	expect(useModelCatalogStore.getState().catalog).toEqual(local);
	expect(useModelCatalogStore.getState().byEnvironment.cloud?.catalog).toEqual(
		remote,
	);
});
it("ignores an old response after catalog reset", async () => {
	let finish: (value: unknown) => void = () => {};
	fixture.dispatch.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const request = useModelCatalogStore
		.getState()
		.ensureLoaded({ environmentId: EnvironmentId.make("cloud") });
	resetModelCatalogForEnvironment();
	finish({ result: bundledResolvedModelCatalog() });
	await request;
	expect(useModelCatalogStore.getState().byEnvironment.cloud).toBeUndefined();
});
