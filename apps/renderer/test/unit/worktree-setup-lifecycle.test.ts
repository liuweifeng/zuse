import { FolderId, WorktreeId } from "@zuse/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	effects: [] as Array<() => undefined | (() => void)>,
	state: {
		byProject: { project: [] as Array<{ id: string; setupStatus?: string }> },
		refresh: vi.fn<() => Promise<void>>(),
		subscribeSetup: vi.fn(),
		unsubscribeSetup: vi.fn(),
	},
}));
vi.mock("react", () => ({
	useEffect: (effect: () => undefined | (() => void)) =>
		fixture.effects.push(effect),
}));
vi.mock("../../src/store/worktrees.ts", () => ({
	EMPTY_WORKTREES: [],
	useWorktreesStore: Object.assign(
		<T>(select: (state: typeof fixture.state) => T) => select(fixture.state),
		{ getState: () => fixture.state },
	),
}));
const { useWorktreeSetupLifecycle } = await import(
	"../../src/hooks/use-worktree-setup-lifecycle.ts"
);
beforeEach(() => {
	vi.useFakeTimers();
	fixture.effects = [];
	fixture.state.subscribeSetup.mockClear();
	fixture.state.unsubscribeSetup.mockClear();
	fixture.state.byProject.project = [];
	fixture.state.refresh.mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());
it("retries an empty worktree projection without waiting for another creation phase", async () => {
	useWorktreeSetupLifecycle(
		FolderId.make("project"),
		WorktreeId.make("worktree"),
		"running_setup",
	);
	const cleanup = fixture.effects[0]?.();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(fixture.state.refresh).toHaveBeenCalledTimes(2);
	fixture.state.byProject.project = [{ id: "worktree" }];
	await vi.advanceTimersByTimeAsync(1_000);
	expect(fixture.state.refresh).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(5_000);
	expect(fixture.state.refresh).toHaveBeenCalledTimes(3);
	cleanup?.();
});
it("stops reconciliation when the selected chat unmounts", async () => {
	useWorktreeSetupLifecycle(
		FolderId.make("project"),
		WorktreeId.make("worktree"),
		"creating_workspace",
	);
	const cleanup = fixture.effects[0]?.();
	cleanup?.();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(fixture.state.refresh).toHaveBeenCalledTimes(1);
});

it.each([
	"pending",
	"running",
])("keeps tracking %s setup after the agent starts", (setupStatus) => {
	fixture.state.byProject.project = [{ id: "worktree", setupStatus }];
	useWorktreeSetupLifecycle(
		FolderId.make("project"),
		WorktreeId.make("worktree"),
		"running",
	);
	const cleanup = fixture.effects[1]?.();
	expect(fixture.state.subscribeSetup).toHaveBeenCalledWith(
		"project",
		"worktree",
	);
	cleanup?.();
	expect(fixture.state.unsubscribeSetup).toHaveBeenCalledWith(
		"project",
		"worktree",
	);
});
it.each([
	"succeeded",
	"failed",
	"skipped",
])("does not retain a completed %s setup subscription", (setupStatus) => {
	fixture.state.byProject.project = [{ id: "worktree", setupStatus }];
	useWorktreeSetupLifecycle(
		FolderId.make("project"),
		WorktreeId.make("worktree"),
		"running_setup",
	);
	fixture.effects[1]?.();
	expect(fixture.state.subscribeSetup).not.toHaveBeenCalled();
});
