import type { Folder } from "@zuse/contracts";
import { EnvironmentId, FolderId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitPrState } from "../../src/lib/use-git-pr-state.ts";

const fixture = vi.hoisted(() => ({
	folders: [] as Pick<Folder, "id" | "kind">[],
	workspace: vi.fn(),
	details: vi.fn(),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	useEnvironmentShellResource: () => ({ data: { folders: fixture.folders } }),
}));
vi.mock("../../src/store/workspace.ts", () => ({
	useWorkspaceStore: (
		select: (state: { folders: typeof fixture.folders }) => unknown,
	) => select({ folders: [] }),
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getActiveEnvironment: () => "local",
}));
vi.mock("../../src/lib/git-workspace-client-bus.ts", () => ({
	useGitWorkspaceResource: (...args: unknown[]) => {
		fixture.workspace(...args);
		return { data: null };
	},
	useGitPrDetailsResource: (...args: unknown[]) => {
		fixture.details(...args);
		return { data: null };
	},
}));
const ref = {
	environmentId: EnvironmentId.make("remote"),
	folderId: FolderId.make("folder"),
	worktreeId: null,
	rootPath: "/thread",
};
function Probe() {
	useGitPrState(ref);
	return null;
}
beforeEach(() => {
	fixture.folders = [];
	vi.clearAllMocks();
});
describe("projectless Git subscriptions", () => {
	it("prevents Git and PR connections for projectless threads on another computer", () => {
		fixture.folders = [{ id: ref.folderId, kind: "scratch" }];
		renderToStaticMarkup(<Probe />);
		expect(fixture.workspace).toHaveBeenCalledWith(null, "connect");
		expect(fixture.details).toHaveBeenCalledWith(null, "cache-only");
	});
	it("preserves Git connections for ordinary projects", () => {
		fixture.folders = [{ id: ref.folderId, kind: "project" }];
		renderToStaticMarkup(<Probe />);
		expect(fixture.workspace).toHaveBeenCalledWith(ref, "connect");
	});
});
