import { runningBackgroundTasks } from "@zuse/client-runtime/background-agent-presentation";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	AgentTurnId,
	AttemptId,
	CommandId,
	EnvironmentId,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { stopBackgroundTask } from "../../src/lib/session-actions.ts";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ status: "applied" })));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	dispatchSessionCommand: dispatch,
}));

import { BackgroundTasks } from "../../src/components/background-tasks.tsx";

const ref = {
	environmentId: EnvironmentId.make("remote"),
	sessionId: SessionId.make("session"),
};
const turnId = AgentTurnId.make("turn");
const attemptId = AttemptId.make("attempt");
const projection = SessionTimelineProjection.make({
	messages: [],
	status: "running",
	turnCount: 1,
	queue: { items: [], paused: false },
	interactions: [],
	permissionMode: "default",
	runtimeMode: "full-access",
	activeTurn: {
		id: turnId,
		ordinal: 1,
		status: "running",
		phase: "running",
		requestedAt: new Date(0),
		completedAt: null,
		providerThreadId: null,
		attempt: { id: attemptId, ordinal: 1, reason: "initial" },
	},
	executionSteps: [
		{
			id: "task",
			turnId,
			attemptId,
			itemId: "shell",
			parentItemId: null,
			kind: "background",
			label: "Watch build",
			status: "running",
			childSessionId: null,
			nativeChildId: "native-task",
			rootCompletedAt: 1,
			createdAt: 0,
			updatedAt: 1,
			checkpointCapability: "unsupported",
		},
	],
});
const view: ResourceView<SessionTimelineProjection> = {
	data: projection,
	origin: "runtime",
	connection: "connected",
	sync: "live",
	generation: 1,
	cursor: { epoch: "epoch", version: 1 },
	pendingCommands: [],
	failedCommands: [],
};

describe("background task controls", () => {
	it("shows a named process with its own stop control", () => {
		const html = renderToStaticMarkup(
			<BackgroundTasks view={view} sessionRef={ref} providerId="claude" />,
		);
		expect(html).toContain("Watch build");
		expect(html).toContain("Background process");
		expect(html).toContain('aria-label="Stop Watch build"');
		expect(html).not.toContain("Waiting");
	});
	it("dispatches the exact task, environment and execution identity", async () => {
		const task = runningBackgroundTasks(view).at(0);
		if (task === undefined) throw new Error("Missing task");
		await stopBackgroundTask(ref, task);
		expect(dispatch).toHaveBeenLastCalledWith(
			expect.objectContaining({
				ref,
				kind: "messages.background.stop",
				payload: expect.objectContaining({
					sessionId: ref.sessionId,
					turnId,
					attemptId,
					taskId: "native-task",
				}),
			}),
		);
	});
	it("keeps the process visible after a stop request and disables its pending control", () => {
		const pending = {
			...view,
			pendingCommands: [
				{
					commandId: CommandId.make("stop"),
					kind: "messages.background.stop",
					targetId: "native-task",
					submittedAt: 1,
				},
			],
		};
		const html = renderToStaticMarkup(
			<BackgroundTasks view={pending} sessionRef={ref} providerId="claude" />,
		);
		expect(html).toContain("Watch build");
		expect(html).toContain("Stopping");
		expect(html).toContain("disabled");
	});
	it("does not offer a stop control for unsupported providers or a different attempt", () => {
		for (const [data, providerId] of [
			[projection, "codex"],
			[
				{
					...projection,
					activeTurn: {
						...projection.activeTurn,
						attempt: {
							...projection.activeTurn?.attempt,
							id: AttemptId.make("new-attempt"),
						},
					},
				},
				"claude",
			],
		] as const) {
			const html = renderToStaticMarkup(
				<BackgroundTasks
					view={{ ...view, data: data as SessionTimelineProjection }}
					sessionRef={ref}
					providerId={providerId}
				/>,
			);
			expect(html).not.toContain("<button");
		}
	});
	it("shows no running process after its native outcome is persisted", () => {
		const data = {
			...projection,
			executionSteps: projection.executionSteps?.map((step) => ({
				...step,
				status: "cancelled" as const,
			})),
		};
		expect(
			renderToStaticMarkup(
				<BackgroundTasks
					view={{ ...view, data }}
					sessionRef={ref}
					providerId="claude"
				/>,
			),
		).toBe("");
	});
});
