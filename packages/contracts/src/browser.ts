import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { AgentSessionId } from "./ids.ts";

export {
	BrowserOverlayShape,
	BrowserViewportMode,
} from "./browser-shared.ts";

import { BrowserOverlayShape, BrowserViewportMode } from "./browser-shared.ts";

export const BrowserTarget = Schema.Union([
	Schema.TaggedStruct("Ref", { ref: Schema.String }),
	Schema.TaggedStruct("Role", {
		role: Schema.String,
		name: Schema.optional(Schema.String),
		exact: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("Text", {
		text: Schema.String,
		exact: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("Css", { selector: Schema.String }),
	Schema.TaggedStruct("Point", { x: Schema.Number, y: Schema.Number }),
]);
export type BrowserTarget = typeof BrowserTarget.Type;

export const BrowserReadiness = Schema.Literals([
	"immediate",
	"dom-ready",
	"load",
]);
export type BrowserReadiness = typeof BrowserReadiness.Type;

/**
 * In-app agent browser bridge.
 *
 * MCP tools run in the server process; the `<webview>` lives in the renderer.
 * So every agent browser action round-trips server → renderer → server,
 * mirroring `permission.ts`: the server broadcasts a `BrowserCommandRequest`
 * on `browser.commands`, the renderer drives the webview, and posts the
 * outcome back via `browser.respond`, which resolves a server-side Deferred.
 *
 * Every capability is a union member here — a wire change, never a
 * stringly-typed addition. v2 members (FillForm/Network/Dialog + the Wait and
 * Screenshot extensions) ride the same request/respond round-trip as v1.
 */
export const BrowserCommand = Schema.Union([
	Schema.TaggedStruct("Navigate", {
		url: Schema.String,
		readiness: Schema.optional(BrowserReadiness),
		environmentPort: Schema.optional(Schema.Number),
		environmentProtocol: Schema.optional(Schema.Literals(["http", "https"])),
	}),
	Schema.TaggedStruct("Status", {}),
	Schema.TaggedStruct("Resize", {
		mode: BrowserViewportMode,
		width: Schema.optional(Schema.Number),
		height: Schema.optional(Schema.Number),
		orientation: Schema.optional(Schema.Literals(["portrait", "landscape"])),
		lockAspectRatio: Schema.optional(Schema.Boolean),
	}),

	Schema.TaggedStruct("Screenshot", {
		fullPage: Schema.optional(Schema.Boolean),
	}),

	Schema.TaggedStruct("Snapshot", {
		screenshot: Schema.optional(Schema.Literals(["viewport", "full-page"])),
	}),

	Schema.TaggedStruct("Click", {
		ref: Schema.optional(Schema.String),
		target: Schema.optional(BrowserTarget),
	}),

	Schema.TaggedStruct("Type", {
		ref: Schema.optional(Schema.String),
		target: Schema.optional(BrowserTarget),
		text: Schema.String,
		submit: Schema.optional(Schema.Boolean),
	}),

	Schema.TaggedStruct("Wait", {
		ms: Schema.optional(Schema.Number),
		selector: Schema.optional(Schema.String),
		text: Schema.optional(Schema.String),
		timeoutMs: Schema.optional(Schema.Number),
	}),
	Schema.TaggedStruct("WaitFor", {
		target: Schema.optional(BrowserTarget),
		selector: Schema.optional(Schema.String),
		text: Schema.optional(Schema.String),
		urlIncludes: Schema.optional(Schema.String),
		loadingComplete: Schema.optional(Schema.Boolean),
		ms: Schema.optional(Schema.Number),
		timeoutMs: Schema.optional(Schema.Number),
	}),

	Schema.TaggedStruct("Scroll", {
		direction: Schema.optional(
			Schema.Literals(["up", "down", "top", "bottom"]),
		),
		ref: Schema.optional(Schema.String),
	}),

	Schema.TaggedStruct("Hover", { ref: Schema.String }),

	Schema.TaggedStruct("Select", { ref: Schema.String, value: Schema.String }),

	Schema.TaggedStruct("Press", {
		key: Schema.String,
		ref: Schema.optional(Schema.String),
	}),

	Schema.TaggedStruct("Read", { ref: Schema.optional(Schema.String) }),

	Schema.TaggedStruct("History", {
		action: Schema.Literals(["back", "forward", "reload"]),
	}),

	Schema.TaggedStruct("Console", {}),

	Schema.TaggedStruct("FillForm", {
		fields: Schema.Array(
			Schema.Struct({
				ref: Schema.String,
				value: Schema.String,
			}),
		),
		submit: Schema.optional(Schema.Boolean),
	}),

	Schema.TaggedStruct("Network", {
		filter: Schema.optional(Schema.String),
		id: Schema.optional(Schema.String),
	}),

	Schema.TaggedStruct("Dialog", {
		action: Schema.Literals(["accept", "dismiss"]),
		promptText: Schema.optional(Schema.String),
	}),

	Schema.TaggedStruct("Login", { origin: Schema.String }),
	Schema.TaggedStruct("Inspect", { target: BrowserTarget }),
	Schema.TaggedStruct("Evaluate", {
		expression: Schema.String,
		awaitPromise: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("RecordingStart", {}),
	Schema.TaggedStruct("RecordingStop", {}),
	Schema.TaggedStruct("Overlay", {
		action: Schema.Literals(["add", "remove", "undo", "redo", "clear"]),
		shape: Schema.optional(BrowserOverlayShape),
		id: Schema.optional(Schema.String),
	}),
]);
export type BrowserCommand = typeof BrowserCommand.Type;

/**
 * Renderer-visible summary of a saved browser credential. Deliberately omits
 * the password — the settings UI only ever sees the origin + username, mirroring
 * the `hasApiKey` boolean exposure for provider API keys.
 */
export class BrowserCredentialSummary extends Schema.Class<BrowserCredentialSummary>(
	"BrowserCredentialSummary",
)({
	origin: Schema.String,
	username: Schema.String,
}) {}

/**
 * One outstanding command. `id` is the server-minted handle the renderer
 * echoes back on `browser.respond`. `sessionId` is the agent session that
 * issued it — the renderer uses it only for display/attribution today.
 */
export class BrowserCommandRequest extends Schema.Class<BrowserCommandRequest>(
	"BrowserCommandRequest",
)({
	id: Schema.String,
	sessionId: AgentSessionId,
	command: BrowserCommand,
}) {}

/**
 * Renderer's reply for one command. `ok=false` carries a human-readable
 * `error` the tool surfaces to the agent. Successful results fill the
 * command-specific optional fields:
 *   - Navigate   → `url`, `title`
 *   - Screenshot → `screenshot` (base64 PNG, no data-URL prefix)
 */
export class BrowserCommandResult extends Schema.Class<BrowserCommandResult>(
	"BrowserCommandResult",
)({
	id: Schema.String,
	ok: Schema.Boolean,
	error: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	screenshot: Schema.optional(Schema.String),
	/**
	 * Snapshot → a11y-tree text (CDP path) or JSON array of
	 * `{ ref, role, name, value }` (v1 DOM fallback).
	 */
	snapshot: Schema.optional(Schema.String),
	/** Click/Type/Scroll/… → short human-readable note for the agent. */
	detail: Schema.optional(Schema.String),
	/**
	 * Read → page/element text; Console → console + error log;
	 * Network → request list or one request's detail.
	 */
	text: Schema.optional(Schema.String),
	/** Command-tagged structured response. New commands use this field. */
	payload: Schema.optional(Schema.Unknown),
}) {}

export class BrowserCommandNotFoundError extends Schema.TaggedErrorClass<BrowserCommandNotFoundError>()(
	"BrowserCommandNotFoundError",
	{ id: Schema.String },
) {}

/**
 * Live stream of pending browser commands. The renderer's BrowserPane
 * subscribes once (independent of which right-pane tab is active) and
 * executes each against the webview. Broadcasting once and filtering on the
 * client mirrors `permission.requests`.
 */
export const BrowserCommandsRpc = Rpc.make("browser.commands", {
	payload: Schema.Struct({}),
	success: BrowserCommandRequest,
	stream: true,
});

/**
 * Renderer posts the outcome of a command back here; the server resolves the
 * Deferred the MCP tool handler is awaiting. Fails if the id is unknown
 * (already resolved, timed out, or from a previous server run).
 */
export const BrowserRespondRpc = Rpc.make("browser.respond", {
	payload: Schema.Struct({ result: BrowserCommandResult }),
	success: Schema.Void,
	error: BrowserCommandNotFoundError,
});

/** Save (or overwrite) the dummy credential for an origin. */
export const BrowserSetCredentialRpc = Rpc.make("browser.setCredential", {
	payload: Schema.Struct({
		origin: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
	success: Schema.Void,
});

/** List saved credentials (origin + username only — never the password). */
export const BrowserListCredentialsRpc = Rpc.make("browser.listCredentials", {
	payload: Schema.Struct({}),
	success: Schema.Array(BrowserCredentialSummary),
});

export const BrowserRemoveCredentialRpc = Rpc.make("browser.removeCredential", {
	payload: Schema.Struct({ origin: Schema.String }),
	success: Schema.Void,
});
