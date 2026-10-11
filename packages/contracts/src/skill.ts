import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ProviderId } from "./agent.ts";
import { FolderId } from "./ids.ts";
import { SessionId, SessionNotFoundError } from "./session.ts";

/**
 * One skill discovered by a provider driver. Memoize owns no skill format;
 * the driver normalises the underlying agent's parsed metadata into this
 * shape so the renderer is provider-agnostic.
 */
export class Skill extends Schema.Class<Skill>("Skill")({
	name: Schema.String,
	scope: Schema.Literals(["global", "project"]),
	description: Schema.String,
	arguments: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			description: Schema.String,
			optional: Schema.Boolean,
		}),
	),
	filePath: Schema.NullOr(Schema.String),
	providerId: ProviderId,
	/**
	 * Effective enablement. Claude/Zuse skills are disabled through the
	 * global `disabledSkills` setting; Codex skills report Codex's native
	 * `enabled` flag. Disabled skills are still listed so settings can show
	 * them, and composers should filter them out.
	 */
	enabled: Schema.Boolean.pipe(
		Schema.withConstructorDefault(Effect.succeed(true)),
		Schema.withDecodingDefaultType(Effect.succeed(true)),
	),
	/**
	 * Whether `skill.setEnabled` can enforce a toggle for this skill. False
	 * when the provider exposes no enforcement seam (the switch should be
	 * disabled).
	 */
	toggleSupported: Schema.Boolean.pipe(
		Schema.withConstructorDefault(Effect.succeed(false)),
		Schema.withDecodingDefaultType(Effect.succeed(false)),
	),
}) {}

export class SkillConfigError extends Schema.TaggedErrorClass<SkillConfigError>()(
	"SkillConfigError",
	{
		providerId: ProviderId,
		name: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * One-shot fetch of the active session's skill list (initial hydrate). For
 * live updates use `skill.stream`.
 */
export const SkillListRpc = Rpc.make("skill.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(Skill),
	error: SessionNotFoundError,
});

/**
 * One-shot fetch for a draft composer before a real session row exists.
 * Skill discovery only needs the provider and project checkout, so the
 * landing composer can hydrate slash-command skills without creating a
 * temporary server session.
 */
export const SkillListForProjectRpc = Rpc.make("skill.listForProject", {
	payload: Schema.Struct({
		projectId: FolderId,
		providerId: ProviderId,
	}),
	success: Schema.Array(Skill),
});

/**
 * Live skill list for a session — emits the full new list on every provider
 * change notification. Same pattern as `messages.stream`.
 */
export const SkillStreamRpc = Rpc.make("skill.stream", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(Skill),
	error: SessionNotFoundError,
	stream: true,
});

/**
 * Every user-level (global) skill for every skill-capable provider, with
 * effective `enabled` / `toggleSupported`. Needs no session or project.
 */
export const SkillListGlobalRpc = Rpc.make("skill.listGlobal", {
	payload: Schema.Struct({}),
	success: Schema.Array(Skill),
});

/**
 * Enable or disable a skill for its provider. Claude/Zuse toggles persist in
 * Zuse's global `disabledSkills` setting; Codex toggles write Codex's native
 * skill config (affecting Codex outside Zuse too, like Codex MCP toggles).
 * Open skill streams republish. `enabled` in the result is the effective
 * state after the write.
 */
export const SkillSetEnabledRpc = Rpc.make("skill.setEnabled", {
	payload: Schema.Struct({
		providerId: ProviderId,
		name: Schema.String,
		scope: Schema.Literals(["global", "project"]),
		enabled: Schema.Boolean,
	}),
	success: Schema.Struct({
		providerId: ProviderId,
		name: Schema.String,
		enabled: Schema.Boolean,
	}),
	error: SkillConfigError,
});
