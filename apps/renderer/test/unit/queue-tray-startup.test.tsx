import { EnvironmentId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	phase: "creating_workspace",
	initialSessionId: "startup-session",
	paused: true,
	runtime: "idle",
	ready: true,
}));

vi.mock("../../src/lib/environment-entity-hooks.ts", () => ({
	useEnvironmentEntities: () => ({
		creationOperationsByProject: {
			project: [
				{ phase: state.phase, initialSessionId: state.initialSessionId },
			],
		},
	}),
}));
vi.mock("../../src/lib/session-timeline-hooks.ts", () => ({
	useRendererSessionTimeline: () => ({
		projection: {
			queue: {
				items: [{ id: "startup-queue", ready: state.ready }],
				paused: state.paused,
			},
		},
		runtime: state.runtime,
		view: { pendingCommands: [], failedCommands: [] },
	}),
}));
vi.mock("../../src/lib/cloud-message-queue.ts", () => ({
	useCloudMessageQueue: () => ({ waiting: [] }),
	useCloudQueueStatus: () => ({ busy: false, label: "Queued" }),
}));
vi.mock("../../src/lib/network-status.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/network-status.ts")>()),
	usePlatformOnline: () => true,
}));
vi.mock("../../src/lib/queue-recovery.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/queue-recovery.ts")>()),
	holdQueueUntilOnline: vi.fn(),
}));
vi.mock("../../src/lib/session-actions.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../src/lib/session-actions.ts")
	>()),
	reorderSessionQueue: vi.fn(),
	resumeSessionQueue: vi.fn(),
}));
vi.mock("../../src/components/composer/queue-chip.tsx", () => ({
	QueueChip: () => <div>@.context/files/paste.md</div>,
}));

import { QueueTray } from "../../src/components/composer/queue-tray.tsx";

const render = () =>
	renderToStaticMarkup(
		<QueueTray
			environmentId={EnvironmentId.make("local")}
			sessionId={SessionId.make("startup-session")}
			creationInProgress={false}
		/>,
	);

describe("startup queue presentation", () => {
	beforeEach(() => {
		state.phase = "creating_workspace";
		state.initialSessionId = "startup-session";
		state.paused = true;
		state.runtime = "idle";
		state.ready = true;
	});

	it.each([
		"persisted",
		"creating_workspace",
		"running_setup",
		"starting_agent",
	])("keeps the startup hold automatic during %s without local creation state", (phase) => {
		state.phase = phase;
		const html = render();
		expect(html).toContain("Starting…");
		expect(html).toContain("@.context/files/paste.md");
		expect(html).not.toContain("you interrupted");
		expect(html).not.toContain("Resume");
	});

	it.each([
		"running",
		"failed",
		"cancelled",
	])("allows recovery after creation is %s without attributing the pause to the user", (phase) => {
		state.phase = phase;
		const html = render();
		expect(html).toContain("Queue paused");
		expect(html).toContain("Resume");
		expect(html).not.toContain("you interrupted");
	});

	it("does not hold a different session for another session's creation", () => {
		state.initialSessionId = "another-session";
		expect(render()).toContain("Resume");
	});

	it("removes the hold once startup releases the queue", () => {
		state.phase = "running";
		state.paused = false;
		expect(render()).not.toContain("Resume");
	});
});

it("explains a first-message upload interrupted by a reload instead of silently queuing it", () => {
	state.phase = "running";
	state.paused = false;
	state.ready = false;
	const html = render();
	expect(html).toContain("Files weren’t attached");
	expect(html).toContain("Remove this message and attach the files again");
	expect(html).not.toContain("Resume");
});

describe("in-chat startup upload recovery", () => {
	it.each([
		"preparing",
		"failed",
	] as const)("shows %s upload state after chat creation has finished", async (status) => {
		const { useStartupQueueStore, startupQueueKey } = await import(
			"../../src/composer/startup-queue.ts"
		);
		state.phase = "running";
		state.paused = false;
		state.ready = false;
		const ref = {
			environmentId: EnvironmentId.make("local"),
			sessionId: SessionId.make("startup-session"),
		};
		useStartupQueueStore.setState({
			jobs: {
				[startupQueueKey(ref, "startup-queue")]: {
					status,
					error: status === "failed" ? "Upload connection closed" : null,
					retry: vi.fn().mockResolvedValue(true),
					cancel: vi.fn(),
				},
			},
		});
		try {
			const html = render();
			if (status === "preparing") {
				expect(html).toContain("Attaching files");
				expect(html).not.toContain("Files weren’t attached");
			} else {
				expect(html).toContain("Files weren’t attached");
				expect(html).toContain("Upload connection closed");
				expect(html).toContain("Retry");
			}
		} finally {
			useStartupQueueStore.setState({ jobs: {} });
		}
	});
});
