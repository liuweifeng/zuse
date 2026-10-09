import { tool } from "@anthropic-ai/claude-agent-sdk";
import type {
	ScheduledTaskCreate,
	ScheduledTaskUpdate,
	SecretRequestCreate,
} from "@zuse/contracts";
import { z } from "zod";

const schedule = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("once"), at: z.number().int().nonnegative() }),
	z.object({
		kind: z.literal("interval"),
		everyMs: z.number().int().min(60_000),
		startAt: z.number().int().nonnegative().optional(),
	}),
	z.object({ kind: z.literal("webhook") }),
]);
const text = z.string().min(1).max(200);
export interface AutomationToolDependencies {
	readonly create: (
		input: Omit<ScheduledTaskCreate, "sessionId">,
	) => Promise<unknown>;
	readonly list: () => Promise<unknown>;
	readonly update: (
		input: Omit<ScheduledTaskUpdate, "sessionId">,
	) => Promise<unknown>;
	readonly remove: (taskId: string) => Promise<unknown>;
	readonly trigger: (taskId: string, eventId: string) => Promise<unknown>;
	readonly requestSecret: (
		input: Omit<SecretRequestCreate, "sessionId">,
	) => Promise<unknown>;
	readonly listSecrets: () => Promise<unknown>;
}
export const AUTOMATION_TOOL_DEFINITIONS = [
	{
		name: "schedule_task",
		description:
			"Persist a future prompt in your current session. once uses Unix milliseconds; interval runs at most once per wake and skips missed intervals. Minimum interval is one minute. webhook waits for an authenticated schedule.trigger RPC event. Runs use the session's existing permissions and durable queue. They require this machine/runtime to be awake; scheduling does not provision or keep cloud machines awake. Reuse clientRequestId for retries.",
		schema: z.object({
			clientRequestId: text,
			title: text,
			prompt: z.string().min(1).max(100_000),
			schedule,
		}),
	},
	{
		name: "list_scheduled_tasks",
		description:
			"Read scheduled tasks belonging to your current session, including last delivery failures.",
		schema: z.object({}),
	},
	{
		name: "update_scheduled_task",
		description:
			"Update or pause a scheduled task belonging to your current session. Disabling prevents future timer runs; already delivered queued prompts remain visible in the queue.",
		schema: z.object({
			taskId: z.string().min(1),
			title: text.optional(),
			prompt: z.string().min(1).max(100_000).optional(),
			schedule: schedule.optional(),
			enabled: z.boolean().optional(),
		}),
	},
	{
		name: "delete_scheduled_task",
		description:
			"Delete a scheduled task and any pending undelivered events. Does not interrupt a turn or remove an already delivered queue item.",
		schema: z.object({ taskId: z.string().min(1) }),
	},
	{
		name: "trigger_scheduled_task",
		description:
			"Deliver an authenticated webhook event to a current-session webhook task. Stable eventId prevents duplicate delivery.",
		schema: z.object({ taskId: z.string().min(1), eventId: text }),
	},
	{
		name: "request_secret",
		description:
			"Ask the user for a private secret using a separate password input. Never ask for its value in chat. Returns request metadata and an opaque reference when provided, never the value. environmentVariable binds the secret only to this session's provider environment. Follow the UI's availability guidance; never print the environment value. Reuse clientRequestId to check the same request safely.",
		schema: z.object({
			clientRequestId: text,
			label: text,
			reason: z.string().max(2000),
			environmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
		}),
	},
	{
		name: "list_secret_requests",
		description:
			"Read private request metadata and completion status for your current session. Never returns secret values.",
		schema: z.object({}),
	},
] as const;
export type AutomationToolName =
	(typeof AUTOMATION_TOOL_DEFINITIONS)[number]["name"];
export const callAutomationTool = async (
	deps: AutomationToolDependencies | undefined,
	name: string,
	args: unknown,
) => {
	if (!deps)
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "Automation tools are unavailable in this runtime.",
				},
			],
		};
	try {
		let value: unknown;
		switch (name) {
			case "schedule_task":
				value = await deps.create(
					AUTOMATION_TOOL_DEFINITIONS[0].schema.parse(args),
				);
				break;
			case "list_scheduled_tasks":
				AUTOMATION_TOOL_DEFINITIONS[1].schema.parse(args);
				value = await deps.list();
				break;
			case "update_scheduled_task":
				value = await deps.update(
					AUTOMATION_TOOL_DEFINITIONS[2].schema.parse(args),
				);
				break;
			case "delete_scheduled_task":
				value = await deps.remove(
					AUTOMATION_TOOL_DEFINITIONS[3].schema.parse(args).taskId,
				);
				break;
			case "trigger_scheduled_task": {
				const input = AUTOMATION_TOOL_DEFINITIONS[4].schema.parse(args);
				value = await deps.trigger(input.taskId, input.eventId);
				break;
			}
			case "request_secret":
				value = await deps.requestSecret(
					AUTOMATION_TOOL_DEFINITIONS[5].schema.parse(args),
				);
				break;
			case "list_secret_requests":
				AUTOMATION_TOOL_DEFINITIONS[6].schema.parse(args);
				value = await deps.listSecrets();
				break;
			default:
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "Unknown automation tool." },
					],
				};
		}
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(value ?? { ok: true }) },
			],
		};
	} catch {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "The automation request failed. Check its arguments and runtime availability before retrying with the same request ID.",
				},
			],
		};
	}
};
export const buildAutomationTools = (
	deps: AutomationToolDependencies | undefined,
) =>
	AUTOMATION_TOOL_DEFINITIONS.map(({ name, description, schema }) =>
		tool(name, description, schema.shape, (args) =>
			callAutomationTool(deps, name, args),
		),
	);
