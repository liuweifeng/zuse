import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
		snapshot(),
}));

const fakes = vi.hoisted(() => ({
	list: undefined as (() => Promise<unknown>) | undefined,
	run: vi.fn(async () => []),
}));
vi.mock("@zuse/client-runtime/device-bridge-catalog", () => ({
	EMPTY_BRIDGE_CATALOG: { devices: [], selected: "", error: null, busy: false },
	DeviceBridgeCatalogController: class {
		constructor(deps: { list: () => Promise<unknown> }) {
			fakes.list = deps.list;
		}
	},
}));
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runCloudControl: fakes.run,
}));
vi.mock("@zuse/i18n/react", () => ({
	useMessages: () => ({ message: (key: string) => key }),
}));

import { CloudDeviceSelector } from "../../src/components/cloud-device-selector.tsx";

it("discovers personal bridge devices independently of the cloud workspace scope", async () => {
	renderToStaticMarkup(<CloudDeviceSelector workspaceId="workspace-one" />);
	await fakes.list?.();
	expect(fakes.run).toHaveBeenCalledWith(expect.any(Function), {
		scope: "account",
	});
});
