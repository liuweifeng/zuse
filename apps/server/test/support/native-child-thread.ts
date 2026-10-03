import type { Thread } from "@zuse/agents/drivers/codex/generated/v2/Thread";
export const nativeChildThread = (): Thread => ({
	id: "child",
	sessionId: "tree",
	forkedFromId: null,
	preview: "task",
	ephemeral: false,
	modelProvider: "openai",
	createdAt: 1,
	updatedAt: 2,
	status: { type: "notLoaded" },
	path: null,
	cwd: "/tmp",
	cliVersion: "test",
	source: {
		subAgent: {
			thread_spawn: {
				parent_thread_id: "parent",
				depth: 1,
				agent_path: null,
				agent_nickname: null,
				agent_role: null,
			},
		},
	},
	threadSource: null,
	agentNickname: null,
	agentRole: null,
	gitInfo: null,
	name: null,
	turns: [
		{
			id: "native-turn",
			status: "completed",
			itemsView: "full",
			error: null,
			startedAt: 1,
			completedAt: 2,
			durationMs: 1,
			items: [
				{
					type: "userMessage",
					id: "input",
					content: [
						{ type: "text", text: "child assignment", text_elements: [] },
					],
				},
				{
					type: "agentMessage",
					id: "output",
					text: "child actual output",
					phase: "final_answer",
					memoryCitation: null,
				},
			],
		},
	],
});
