import { ChatId, EnvironmentId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { chatRowIsUnread } from "../../src/lib/chat-attention-state.ts";
import { useChatAttention } from "../../src/lib/use-chat-attention.ts";

const mocks = vi.hoisted(() => ({
	shell: vi.fn(),
	timelines: vi.fn(),
	permissions: vi.fn(),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	useEnvironmentShellResource: mocks.shell,
}));
vi.mock("../../src/lib/session-timeline-hooks.ts", () => ({
	useRendererSessionTimelines: mocks.timelines,
}));
vi.mock("../../src/lib/environment-permissions-client-bus.ts", () => ({
	useEnvironmentPermissions: mocks.permissions,
}));
vi.mock("../../src/lib/environment-question-attachments-client-bus.ts", () => ({
	useEnvironmentQuestionAttachments: () => ({ data: { attachmentsByKey: {} } }),
}));

const environmentId = EnvironmentId.make("cloud-workspace");
const chatId = ChatId.make("slack-chat");
const idleSession = SessionId.make("original-session");
const runningSession = SessionId.make("new-session");
function Row() {
	const attention = useChatAttention({ id: chatId }, environmentId, false);
	return (
		<span>
			{attention.attentionState}:{String(attention.busy)}
		</span>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.shell.mockReturnValue({
		data: {
			sessionsByProject: {
				runtimeProject: [
					{ id: idleSession, chatId, archivedAt: null },
					{ id: runningSession, chatId, archivedAt: null },
					{ id: "other-chat-session", chatId: "other-chat", archivedAt: null },
					{ id: "archived-session", chatId, archivedAt: new Date(0) },
				],
			},
		},
	});
	mocks.permissions.mockReturnValue({ data: { requestsById: {} } });
	mocks.timelines.mockImplementation((refs) =>
		refs.map((ref: { sessionId: string }) => ({
			ref,
			runtime: ref.sessionId === runningSession ? "running" : "idle",
			messages: [],
			presentation: { health: "healthy", interactions: [] },
		})),
	);
});
it("shows a running second session even when the original Slack session is idle", () => {
	expect(renderToStaticMarkup(<Row />)).toContain("running:true");
	expect(mocks.shell).toHaveBeenCalledWith(environmentId, "cache-only");
	expect(mocks.permissions).toHaveBeenCalledWith(environmentId);
	expect(mocks.timelines).toHaveBeenCalledWith(
		[
			{ environmentId, sessionId: idleSession },
			{ environmentId, sessionId: runningSession },
		],
		"cache-only",
	);
});
it("returns to idle when the live sessions finish", () => {
	mocks.timelines.mockImplementation((refs) =>
		refs.map((ref: { sessionId: string }) => ({
			ref,
			runtime: "idle",
			messages: [],
			presentation: { health: "healthy", interactions: [] },
		})),
	);
	expect(renderToStaticMarkup(<Row />)).toContain("idle:false");
});

function UnreadRow() {
	const attention = useChatAttention({ id: chatId }, environmentId, false);
	return (
		<span>
			{String(
				chatRowIsUnread(
					false,
					true,
					attention.busy,
					attention.permissionAttention === "permission",
				),
			)}
		</span>
	);
}
it("does not show intermediate unseen output as unread while another tab is running", () => {
	expect(renderToStaticMarkup(<UnreadRow />)).toContain("false");
	mocks.timelines.mockImplementation((refs) =>
		refs.map((ref: { sessionId: string }) => ({
			ref,
			runtime: "idle",
			messages: [],
			presentation: { health: "healthy", interactions: [] },
		})),
	);
	expect(renderToStaticMarkup(<UnreadRow />)).toContain("true");
});
