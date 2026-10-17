/**
 * Builds `openapi/zuse-api.json` for the public API reference.
 *
 * Request and response shapes come from the Effect Schemas in
 * `@zuse/contracts`, and paths come from `ApiPaths`, so the reference cannot
 * drift from the API. This file only adds the prose: descriptions, limits,
 * examples, and error codes. Run with `--check` to fail when the committed
 * document is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	ApiAssetCreated,
	ApiMessageList,
	ApiPaths,
	ApiProjectList,
	ApiSendMessageReceipt,
	ApiSendMessageRequest,
	ApiWebhookCreated,
	ApiWebhookCreateRequest,
	ApiWebhookList,
	ApiWebhookTurnCompletedEvent,
	ApiWorkspaceCreateRequest,
	ApiWorkspaceList,
	ApiWorkspaceStatus,
	CloudAuthProvider,
	CloudProviderList,
} from "@zuse/contracts";
import { Schema } from "effect";
import { ATTACHMENT_MEDIA_TYPES } from "../src/lib/attachment-media-types";

type Json = Record<string, unknown>;

const OUTPUT = fileURLToPath(
	new URL("../openapi/zuse-api.json", import.meta.url),
);
const API_ORIGIN = "https://api.zuse.sh";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const components: Record<string, Json> = {};

/** Fields that exist in a contract but are not part of the public API. */
const internalFields: Record<string, ReadonlyArray<string>> = {
	ApiSendMessageRequest: ["source"],
};

function definitionName(name: string) {
	return name.replace(/JsonEncoding$/u, "");
}

/** Removes JSON-codec artifacts so the reference reads like the wire format. */
function normalize(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(normalize);
	if (!node || typeof node !== "object") return node;
	const schema = node as Json;

	if (typeof schema.$ref === "string") {
		const name = definitionName(schema.$ref.split("/").at(-1) ?? "");
		return { $ref: `#/components/schemas/${name}` };
	}

	if (Array.isArray(schema.anyOf)) {
		const options = (schema.anyOf as Json[]).filter((option) => {
			// Non-finite numbers are a codec detail, and `null` stands in for an
			// omitted optional field.
			const isNonFinite =
				option.type === "string" &&
				Array.isArray(option.enum) &&
				option.enum.includes("Infinity");
			return option.type !== "null" && !isNonFinite;
		});
		if (options.length === 1) {
			const { anyOf: _anyOf, ...rest } = schema;
			return normalize({ ...rest, ...options[0] });
		}
	}

	const result: Json = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "additionalProperties" && value === false) continue;
		result[key] =
			key === "properties"
				? Object.fromEntries(
						Object.entries(value as Json).map(([name, property]) => [
							name,
							normalize(property),
						]),
					)
				: normalize(value);
	}
	return result;
}

function register(schema: Schema.Top) {
	const document = Schema.toJsonSchemaDocument(schema) as unknown as {
		schema: Json;
		definitions: Record<string, Json>;
	};
	for (const [name, definition] of Object.entries(document.definitions)) {
		components[definitionName(name)] = normalize(definition) as Json;
	}
	return normalize(document.schema) as Json;
}

function ref(schema: Schema.Top) {
	return register(schema);
}

type FieldDoc = string | (Json & { description: string });

/** Attaches prose to contract-generated schemas, failing on unknown fields. */
function describe(
	name: string,
	description: string,
	fields: Record<string, FieldDoc>,
) {
	const schema = components[name];
	if (!schema) throw new Error(`Unknown schema ${name}`);
	const properties = (schema.properties ?? {}) as Record<string, Json>;
	for (const field of internalFields[name] ?? []) {
		delete properties[field];
		schema.required = (schema.required as string[] | undefined)?.filter(
			(required) => required !== field,
		);
	}
	for (const [field, doc] of Object.entries(fields)) {
		const property = properties[field];
		if (!property) throw new Error(`${name}.${field} is not in the contract`);
		Object.assign(
			property,
			typeof doc === "string" ? { description: doc } : doc,
		);
	}
	const undocumented = Object.keys(properties).filter(
		(field) => !fields[field],
	);
	if (undocumented.length > 0) {
		throw new Error(
			`${name} has undocumented fields: ${undocumented.join(", ")}`,
		);
	}
	schema.description = description;
}

const workspaceStatus = ref(ApiWorkspaceStatus);
const workspaceCreateRequest = ref(ApiWorkspaceCreateRequest);
const sendMessageRequest = ref(ApiSendMessageRequest);
const projectList = ref(ApiProjectList);
const providerList = ref(CloudProviderList);
const assetCreated = ref(ApiAssetCreated);
const messageReceipt = ref(ApiSendMessageReceipt);
const messageList = ref(ApiMessageList);
const webhookCreateRequest = ref(ApiWebhookCreateRequest);
const webhookCreated = ref(ApiWebhookCreated);
const webhookList = ref(ApiWebhookList);
const turnCompletedEvent = ref(ApiWebhookTurnCompletedEvent);
const workspaceList = ref(ApiWorkspaceList);
const agentIds = register(CloudAuthProvider);

const timestamp = (what: string) => ({
	description: `${what}, in Unix epoch milliseconds.`,
	examples: [1760697600000],
});

describe(
	"ApiWorkspaceStatus",
	"A cloud workspace and the state of its agent.",
	{
		workspaceId: {
			description: "Workspace ID.",
			examples: ["workspace_Q2x8mN4pR7sT1vWz"],
		},
		providerId: {
			description: "Cloud machine provider the workspace runs on.",
			examples: ["box"],
		},
		projectId: {
			description: "Project the workspace was created from.",
			examples: ["proj_8f2c1a"],
		},
		branch: {
			description: "Git branch the agent works on.",
			examples: ["fix-order-validation"],
		},
		baseRef: {
			description: "Ref the branch was created from.",
			examples: ["main"],
		},
		state: "Lifecycle state of the workspace machine.",
		statusCode: {
			description:
				"Detailed status for display. Treat as opaque; it can change between releases.",
			examples: ["agent-running"],
		},
		startupPhase: "Where the workspace is in its startup sequence.",
		runtimeState: "Whether the workspace runtime is connected.",
		agentStatus:
			"`working` while a message is being handled, `idle` once the agent has replied, otherwise `unknown`.",
		latestSeq: {
			description:
				"Highest message sequence number. Pass it as `afterSeq` to fetch only newer messages.",
			examples: [4],
		},
		lastTurn:
			"The most recent finished agent turn, or `null` if none has finished.",
		createdAt: timestamp("When the workspace was created"),
		updatedAt: timestamp("When the workspace last changed"),
	},
);

describe("ApiWorkspaceLastTurn", "The most recent finished agent turn.", {
	turnId: { description: "Turn ID.", examples: ["turn_7a2c9e"] },
	outcome: "How the turn ended.",
	completedAt: timestamp("When the turn finished"),
});

describe("ApiWorkspaceList", "Workspaces on your account.", {
	workspaces:
		"Every workspace that hasn't been deleted, including ones created from the app or Slack.",
});

describe(
	"ApiWorkspaceCreateRequest",
	"Options for a new cloud workspace. Every field is optional when your account has one ready project and an earlier workspace to copy the agent and model from.",
	{
		prompt: {
			description:
				"First message for the agent, up to 65,536 characters. Omit it to create an idle workspace, for example to upload attachments first.",
			maxLength: 65536,
			examples: [
				"Return a 400 with the validation issues when POST /orders gets an invalid body.",
			],
		},
		projectId: {
			description:
				"Project to work in. Defaults to your only ready project; required when you have more than one.",
			examples: ["proj_8f2c1a"],
		},
		providerId: {
			description:
				"Cloud machine provider, from [List providers](/api-reference/providers/list-providers). Defaults to your connected provider or the Zuse default.",
			examples: ["box"],
		},
		agent: {
			description:
				"Agent to run, from [List agents](/api-reference/providers/list-agents). Defaults to the agent of your most recent workspace.",
			examples: ["codex"],
		},
		model: {
			description:
				"Model ID for the agent. Defaults to the model of your most recent workspace.",
			examples: ["gpt-5.6-sol"],
		},
		runtimeMode: {
			description:
				"Permission mode for the agent. API-created workspaces default to `full-access`.",
			default: "full-access",
		},
		baseRef: {
			description:
				"Branch, tag, or commit to start from. Defaults to the project's default branch. Allowed characters: letters, digits, `.`, `_`, `/`, `#`, `-`.",
			examples: ["main"],
		},
		branch: {
			description:
				"Name of the branch to create. Defaults to a generated name. Allowed characters: letters, digits, `.`, `_`, `/`, `-`.",
			examples: ["fix-order-validation"],
		},
		idempotencyKey: {
			description:
				"Makes retries safe, up to 200 characters. You can send the `Idempotency-Key` header instead; if you send both they must match.",
			maxLength: 200,
		},
	},
);

describe("ApiProject", "A repository connected to Zuse Cloud.", {
	projectId: { description: "Project ID.", examples: ["proj_8f2c1a"] },
	repository: {
		description: "Repository the project tracks.",
		examples: ["acme/api"],
	},
	displayName: { description: "Name shown in Zuse.", examples: ["acme-api"] },
	defaultBranch: {
		description: "Default branch of the repository.",
		examples: ["main"],
	},
	state: "Workspaces can only be created from `ready` projects.",
});

describe("ApiProjectList", "Projects on your account.", {
	projects: "Connected repositories.",
});

describe(
	"CloudProviderList",
	"Cloud machine providers available to your account.",
	{
		providers:
			"Providers you can pass as `providerId` when creating a workspace.",
		entitled: "Whether your account can create cloud workspaces.",
	},
);

describe("CloudProviderOption", "A cloud machine provider.", {
	providerId: { description: "Provider ID.", examples: ["box"] },
	displayName: { description: "Name shown in Zuse.", examples: ["Boat"] },
	sizes: "Machine sizes the provider offers.",
	billingSource:
		"`zuse` when Zuse bills for usage, `provider` when it runs on your own provider account.",
});

describe("CloudProviderSize", "A machine size.", {
	sizeId: { description: "Size ID.", examples: ["standard"] },
	displayName: { description: "Name shown in Zuse.", examples: ["Standard"] },
	vcpuCount: { description: "Virtual CPUs.", examples: [4] },
	memoryMib: { description: "Memory in MiB.", examples: [8192] },
});

describe("ApiAsset", "A file uploaded to a workspace.", {
	assetId: {
		description: "Pass this in a message's `attachments` array.",
		examples: ["asset_4kQ9mZr2Lp8vTx1nWc6bYs0d"],
	},
	mimeType: { description: "Media type of the file.", examples: ["image/png"] },
	originalName: {
		description: "File name from `X-Zuse-File-Name`.",
		examples: ["error.png"],
	},
	sizeBytes: { description: "Size in bytes.", examples: [48213] },
});

describe("ApiAssetCreated", "The uploaded file.", {
	asset: "The new attachment.",
});

describe("ApiSendMessageRequest", "A message for the workspace's agent.", {
	text: {
		description:
			"Message text, up to 65,536 characters. Can be empty only when `attachments` is set.",
		maxLength: 65536,
		examples: ["Also add a test for the 400 response."],
	},
	attachments: {
		description: "Up to 8 asset IDs uploaded to this workspace.",
		maxItems: 8,
		examples: [["asset_4kQ9mZr2Lp8vTx1nWc6bYs0d"]],
	},
	idempotencyKey: {
		description:
			"Makes retries safe, up to 200 characters. You can send the `Idempotency-Key` header instead; if you send both they must match.",
		maxLength: 200,
	},
});

describe("ApiSendMessageReceipt", "Confirms the message was accepted.", {
	messageId: {
		description: "Message ID.",
		examples: ["msg_k3Jd9sLq2Pz8xVb1Nm4Tr7"],
	},
	seq: {
		description: "Sequence number of the message in the conversation.",
		examples: [5],
	},
	status: "`queued` until the workspace runtime picks it up, then `delivered`.",
	resumeTriggered: "`true` when this message woke a paused workspace.",
});

describe("ApiMessage", "A message in a workspace conversation.", {
	messageId: {
		description: "Message ID.",
		examples: ["msg_k3Jd9sLq2Pz8xVb1Nm4Tr7"],
	},
	seq: {
		description: "Increases by one for each message in the workspace.",
		examples: [5],
	},
	role: "Who wrote the message.",
	text: "Message text. Agent replies are capped at 16,384 characters.",
	status:
		"Your messages go `pending` → `delivered` → `settled` once the agent replies. A message that isn't delivered within 24 hours becomes `expired`; one that's delivered but never answered becomes `failed`. Agent messages are always `settled`.",
	turnId: {
		description: "Agent turn the message belongs to.",
		examples: ["turn_7a2c9e"],
	},
	outcome: "How the agent turn ended. Set on agent messages.",
	createdAt: timestamp("When the message was created"),
	deliveredAt: timestamp("When the workspace acknowledged the message"),
	attachments: "Files attached to your message.",
});

describe("ApiMessageList", "A page of messages.", {
	messages: "Messages after `afterSeq`, oldest first.",
	latestSeq:
		"Sequence number of the last message on this page. Pass it as `afterSeq` on the next request.",
});

describe("ApiWebhookCreateRequest", "A webhook endpoint to register.", {
	url: {
		description:
			"Public `https` URL, up to 2,048 characters. Local, private-network, and IP-literal hosts are rejected.",
		maxLength: 2048,
		examples: ["https://example.com/zuse/webhooks"],
	},
	description: {
		description: "Label for the endpoint, up to 200 characters.",
		maxLength: 200,
		examples: ["Production notifier"],
	},
});

describe("ApiWebhookEndpoint", "A registered webhook endpoint.", {
	webhookId: { description: "Webhook ID.", examples: ["wh_7Hn2kQ9xLm4"] },
	url: {
		description: "Where deliveries are sent.",
		examples: ["https://example.com/zuse/webhooks"],
	},
	description: {
		description: "Label for the endpoint.",
		examples: ["Production notifier"],
	},
	createdAt: timestamp("When the endpoint was registered"),
});

describe("ApiWebhookCreated", "The new endpoint and its signing secret.", {
	webhook: "The registered endpoint.",
	secret: {
		description:
			"Signing secret for verifying deliveries. It's shown only once, so store it now.",
		examples: ["whsec_9a8b7c6d5e4f3g2h1i0jKLMNOPQRSTUVWXYZabcdefg"],
	},
});

describe("ApiWebhookList", "Your webhook endpoints.", {
	webhooks:
		"Endpoints in the order they were registered. Secrets are never returned.",
});

describe(
	"ApiWebhookTurnCompletedEvent",
	"Sent when an agent finishes a turn in any workspace on your account.",
	{
		eventId: {
			description:
				"Event ID. It's the same for every retry, so use it to ignore duplicates.",
			examples: ["evt_3f1c9a7e5b2d8046c1e9f7a3b5d2c8e0f4a6b1c3"],
		},
		type: "Event type.",
		createdAt: timestamp("When the turn finished"),
		workspaceId: {
			description: "Workspace ID.",
			examples: ["workspace_Q2x8mN4pR7sT1vWz"],
		},
		branch: {
			description: "Branch the agent works on.",
			examples: ["fix-order-validation"],
		},
		turnId: { description: "Turn ID.", examples: ["turn_7a2c9e"] },
		outcome: "How the turn ended.",
		reply: "The agent's reply, capped at 16,384 characters.",
		messageId: {
			description: "ID of the agent's message in the workspace conversation.",
			examples: ["msg_turn_5d0b8c1e9f2a7b3c6d4e1f0a9b8c7d6e5f4a3b2c"],
		},
	},
);

components.ApiTurnFailure = {
	type: "object",
	description: "Why the latest agent turn on this page failed.",
	properties: {
		turnId: { type: "string", description: "Turn ID." },
		agent: { ...agentIds, description: "Agent that failed." },
		code: {
			type: "string",
			enum: ["agent_not_installed", "agent_error"],
			description:
				"`agent_not_installed` when the agent isn't set up in the workspace image.",
		},
		message: {
			type: "string",
			description: "Error from the agent, up to 1,200 characters.",
		},
	},
	required: ["turnId", "agent", "code", "message"],
};
const messageListSchema = components.ApiMessageList as Json;
(messageListSchema.properties as Json).turnFailure = {
	$ref: "#/components/schemas/ApiTurnFailure",
	description: "Present when the latest turn on this page failed.",
};

components.ApiAgentList = {
	type: "object",
	description: "Agents connected for cloud use.",
	properties: {
		agents: {
			type: "array",
			items: agentIds,
			description: "Agents you can pass as `agent` when creating a workspace.",
			examples: [["claude", "codex"]],
		},
	},
	required: ["agents"],
};

components.Error = {
	type: "object",
	description: "Every error response has this shape.",
	properties: {
		error: {
			type: "string",
			description: "Machine-readable error code.",
			examples: ["invalid_api_key"],
		},
		detail: { type: "string", description: "Extra context, when available." },
	},
	required: ["error"],
};

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

function apiPath(path: string) {
	return decodeURIComponent(path);
}

const workspaceIdParameter = {
	name: "workspaceId",
	in: "path",
	required: true,
	description: "Workspace ID.",
	schema: { type: "string", examples: ["workspace_Q2x8mN4pR7sT1vWz"] },
};

const idempotencyHeader = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	description:
		"Retrying with the same key returns the original result instead of repeating the action. Up to 200 characters.",
	schema: { type: "string", maxLength: 200 },
};

function json(schema: Json, description: string) {
	return { description, content: { "application/json": { schema } } };
}

function errors(codes: Record<number, ReadonlyArray<string>>) {
	const common: Record<number, ReadonlyArray<string>> = {
		401: ["missing_api_key", "invalid_api_key"],
		403: ["cloud_entitlement_required"],
	};
	const merged: Record<number, Set<string>> = {};
	for (const source of [common, codes]) {
		for (const [status, list] of Object.entries(source)) {
			merged[Number(status)] ??= new Set();
			for (const code of list) merged[Number(status)]?.add(code);
		}
	}
	return Object.fromEntries(
		Object.entries(merged).map(([status, list]) => [
			status,
			json(
				{ $ref: "#/components/schemas/Error" },
				[...list].map((code) => `\`${code}\``).join(", "),
			),
		]),
	);
}

const invalidBody = ["invalid_json", "invalid_request"];
const unavailable = [
	"api_content_encryption_not_configured",
	"api_content_seal_failed",
];

const paths: Record<string, Record<string, Json>> = {
	[apiPath(ApiPaths.apiWorkspaces)]: {
		post: {
			operationId: "create-workspace",
			tags: ["Workspaces"],
			summary: "Create workspace",
			description:
				"Starts a cloud workspace on a fresh branch and, if you pass a `prompt`, sends it to the agent. The machine starts right away; poll [Get workspace](/api-reference/workspaces/get-workspace) or subscribe to [webhooks](/api-reference/webhook-signatures) to follow progress.",
			parameters: [idempotencyHeader],
			requestBody: {
				required: false,
				content: { "application/json": { schema: workspaceCreateRequest } },
			},
			responses: {
				201: json(
					{
						type: "object",
						properties: { workspace: workspaceStatus },
						required: ["workspace"],
					},
					"Workspace created. Replaying a request with the same `Idempotency-Key` returns `200` with the same workspace.",
				),
				...errors({
					400: [
						...invalidBody,
						"invalid_prompt",
						"cloud_project_required",
						"agent_and_model_required",
						"invalid_git_ref",
						"invalid_idempotency_key",
						"idempotency_key_mismatch",
					],
					403: ["cloud_billing_hold", "cloud_billing_period_missing"],
					404: ["cloud_project_not_found"],
					409: [
						"cloud_project_not_ready",
						"cloud_snapshot_unavailable",
						"cloud_branch_in_use:<workspaceId>",
						"idempotency_key_reused_with_different_request",
					],
					503: [
						"cloud_provider_unavailable",
						"cloud_provider_required",
						...unavailable,
					],
				}),
			},
		},
		get: {
			operationId: "list-workspaces",
			tags: ["Workspaces"],
			summary: "List workspaces",
			description:
				"Lists every workspace on your account that hasn't been deleted, including ones started from the app or Slack.",
			responses: {
				200: json(workspaceList, "Your workspaces."),
				...errors({}),
			},
		},
	},
	[apiPath(ApiPaths.apiWorkspace("{workspaceId}"))]: {
		get: {
			operationId: "get-workspace",
			tags: ["Workspaces"],
			summary: "Get workspace",
			description:
				"Returns the state of a workspace and whether its agent is working.",
			parameters: [workspaceIdParameter],
			responses: {
				200: json(
					{
						type: "object",
						properties: { workspace: workspaceStatus },
						required: ["workspace"],
					},
					"The workspace.",
				),
				...errors({ 404: ["cloud_workspace_not_found"] }),
			},
		},
	},
	[apiPath(ApiPaths.apiWorkspaceMessages("{workspaceId}"))]: {
		post: {
			operationId: "send-message",
			tags: ["Messages"],
			summary: "Send message",
			description:
				"Sends a message to the workspace's agent. A paused workspace resumes automatically. Messages are queued while the agent is busy and handled in order.",
			parameters: [workspaceIdParameter, idempotencyHeader],
			requestBody: {
				required: true,
				content: { "application/json": { schema: sendMessageRequest } },
			},
			responses: {
				200: json(messageReceipt, "Message accepted."),
				...errors({
					400: [
						...invalidBody,
						"invalid_message",
						"invalid_asset_id",
						"invalid_idempotency_key",
						"idempotency_key_mismatch",
					],
					403: ["cloud_billing_hold", "cloud_billing_period_missing"],
					404: ["cloud_workspace_not_found", "api_asset_not_found"],
					409: [
						"workspace_not_accepting_messages",
						"message_not_deliverable",
						"idempotency_key_reused_with_different_request",
					],
					503: ["cloud_workspace_state_contended", ...unavailable],
				}),
			},
		},
		get: {
			operationId: "list-messages",
			tags: ["Messages"],
			summary: "List messages",
			description:
				"Returns the conversation, oldest first. To follow a running workspace, keep passing the previous `latestSeq` as `afterSeq`. A page shorter than `limit` means you've caught up.",
			parameters: [
				workspaceIdParameter,
				{
					name: "afterSeq",
					in: "query",
					required: false,
					description:
						"Return messages with a sequence number greater than this.",
					schema: { type: "integer", minimum: 0, default: 0 },
				},
				{
					name: "limit",
					in: "query",
					required: false,
					description:
						"Maximum messages to return. Larger values are capped at 200.",
					schema: { type: "integer", minimum: 1, maximum: 200, default: 200 },
				},
			],
			responses: {
				200: json(messageList, "A page of messages."),
				...errors({
					400: ["invalid_message_query"],
					404: ["cloud_workspace_not_found"],
				}),
			},
		},
	},
	[apiPath(ApiPaths.apiWorkspaceAssets("{workspaceId}"))]: {
		post: {
			operationId: "upload-attachment",
			tags: ["Attachments"],
			summary: "Upload attachment",
			description:
				"Uploads a file to a workspace so you can attach it to a message. Send the raw file as the body with its media type in `Content-Type`. Files can be up to 20 MiB.",
			parameters: [
				workspaceIdParameter,
				{
					name: "X-Zuse-File-Name",
					in: "header",
					required: false,
					description:
						"Original file name, up to 255 characters. Defaults to `attachment`.",
					schema: { type: "string", examples: ["error.png"] },
				},
				idempotencyHeader,
			],
			requestBody: {
				required: true,
				description: "The file's bytes.",
				content: Object.fromEntries(
					ATTACHMENT_MEDIA_TYPES.map((type) => [
						type,
						{ schema: { type: "string", format: "binary" } },
					]),
				),
			},
			responses: {
				201: json(assetCreated, "File uploaded."),
				...errors({
					400: [
						"unsupported_asset_type",
						"invalid_asset_size",
						"invalid_asset_body",
						"invalid_idempotency_key",
					],
					404: ["cloud_workspace_not_found"],
					409: [
						"workspace_not_accepting_messages",
						"idempotency_key_reused_with_different_asset",
					],
					503: ["api_asset_store_unavailable", ...unavailable],
				}),
			},
		},
	},
	[apiPath(ApiPaths.apiProjects)]: {
		get: {
			operationId: "list-projects",
			tags: ["Projects"],
			summary: "List projects",
			description:
				"Lists the repositories connected to Zuse Cloud. Create workspaces from `ready` projects.",
			responses: { 200: json(projectList, "Your projects."), ...errors({}) },
		},
	},
	[apiPath(ApiPaths.apiAgents)]: {
		get: {
			operationId: "list-agents",
			tags: ["Providers"],
			summary: "List agents",
			description:
				"Lists the agents connected for cloud use. Connect agents in the Zuse app under Cloud workspace settings.",
			responses: {
				200: json(
					{ $ref: "#/components/schemas/ApiAgentList" },
					"Connected agents.",
				),
				...errors({}),
			},
		},
	},
	[apiPath(ApiPaths.apiProviders)]: {
		get: {
			operationId: "list-providers",
			tags: ["Providers"],
			summary: "List providers",
			description:
				"Lists the cloud machine providers and sizes available to your account.",
			responses: {
				200: json(providerList, "Available providers."),
				...errors({}),
			},
		},
	},
	[apiPath(ApiPaths.apiWebhooks)]: {
		post: {
			operationId: "create-webhook",
			tags: ["Webhooks"],
			summary: "Create webhook",
			description:
				"Registers an endpoint that receives an event whenever an agent finishes a turn in any of your workspaces. The response includes the signing secret, which is shown only once. You can register up to 20 endpoints.",
			requestBody: {
				required: true,
				content: { "application/json": { schema: webhookCreateRequest } },
			},
			responses: {
				201: json(webhookCreated, "Endpoint registered."),
				...errors({
					400: [
						...invalidBody,
						"invalid_webhook_url",
						"invalid_webhook_description",
					],
					409: ["webhook_limit_reached"],
					503: unavailable,
				}),
			},
		},
		get: {
			operationId: "list-webhooks",
			tags: ["Webhooks"],
			summary: "List webhooks",
			description:
				"Lists your webhook endpoints. Signing secrets aren't returned.",
			responses: { 200: json(webhookList, "Your endpoints."), ...errors({}) },
		},
	},
	[apiPath(ApiPaths.apiWebhook("{webhookId}"))]: {
		delete: {
			operationId: "delete-webhook",
			tags: ["Webhooks"],
			summary: "Delete webhook",
			description: "Removes an endpoint and cancels its pending deliveries.",
			parameters: [
				{
					name: "webhookId",
					in: "path",
					required: true,
					description: "Webhook ID.",
					schema: { type: "string", examples: ["wh_7Hn2kQ9xLm4"] },
				},
			],
			responses: {
				200: json(
					{
						type: "object",
						properties: { ok: { type: "boolean", const: true } },
						required: ["ok"],
					},
					"Endpoint removed.",
				),
				401: json(
					{ $ref: "#/components/schemas/Error" },
					"`missing_api_key`, `invalid_api_key`",
				),
				404: json(
					{ $ref: "#/components/schemas/Error" },
					"`webhook_not_found`",
				),
			},
		},
	},
};

const webhooks = {
	"workspace.turn.completed": {
		post: {
			operationId: "workspace-turn-completed",
			tags: ["Webhooks"],
			summary: "Turn completed event",
			description:
				"Zuse sends this `POST` to every registered endpoint when an agent finishes a turn. Verify the `zuse-signature` header before trusting the body, and use `zuse-event-id` to ignore duplicates. See [Verify webhooks](/api-reference/webhook-signatures).",
			parameters: [
				{
					name: "zuse-signature",
					in: "header",
					required: true,
					description:
						"`t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` keyed with your full `whsec_` secret.",
					schema: { type: "string" },
				},
				{
					name: "zuse-event-id",
					in: "header",
					required: true,
					description: "Same as `eventId` in the body.",
					schema: { type: "string" },
				},
				{
					name: "zuse-delivery-attempt",
					in: "header",
					required: true,
					description: "Attempt number, starting at 1.",
					schema: { type: "integer", minimum: 1 },
				},
			],
			requestBody: {
				required: true,
				content: { "application/json": { schema: turnCompletedEvent } },
			},
			responses: {
				200: {
					description:
						"Return any 2xx status to acknowledge the event. Anything else is retried.",
				},
			},
		},
	},
};

const document = {
	openapi: "3.1.0",
	info: {
		title: "Zuse API",
		version: "1",
		description:
			"Create cloud workspaces, talk to their agents, and get notified when they finish.",
	},
	servers: [{ url: API_ORIGIN }],
	security: [{ apiKey: [] }],
	tags: [
		{
			name: "Workspaces",
			description: "Start cloud workspaces and check on them.",
		},
		{ name: "Messages", description: "Talk to a workspace's agent." },
		{ name: "Attachments", description: "Upload files to attach to messages." },
		{
			name: "Projects",
			description: "Repositories you can create workspaces from.",
		},
		{
			name: "Providers",
			description: "Agents and cloud machines available to you.",
		},
		{ name: "Webhooks", description: "Get notified when agents finish." },
	],
	paths,
	webhooks,
	components: {
		securitySchemes: {
			apiKey: {
				type: "http",
				scheme: "bearer",
				description:
					"An API key that starts with `zk_`. Create one in the Zuse app.",
			},
		},
		schemas: Object.fromEntries(
			Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
		),
	},
};

const output = `${JSON.stringify(document, null, "\t")}\n`;

if (process.argv.includes("--check")) {
	if (readFileSync(OUTPUT, "utf8") !== output) {
		console.error(
			"openapi/zuse-api.json is stale. Run `bun run openapi:generate`.",
		);
		process.exit(1);
	}
	console.log("openapi/zuse-api.json is up to date.");
} else {
	writeFileSync(OUTPUT, output);
	console.log(`Wrote ${OUTPUT}`);
}
