import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type {
	FolderId,
	SessionId,
	SettingsFile,
	SettingsPatch,
	Skill,
} from "@zuse/contracts";
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codex = vi.hoisted(() => ({
	available: true,
	skills: [] as Array<{
		name: string;
		description: string;
		path: string;
		scope: "user" | "repo" | "system" | "admin";
		enabled: boolean;
	}>,
	listCalls: [] as Array<{ cwds: ReadonlyArray<string>; forceReload: boolean }>,
	writes: [] as Array<unknown>,
}));

vi.mock("@zuse/agents/drivers/codex-control-client", () => ({
	withCodexControlClient: async (
		_codexPath: string | null,
		run: (client: unknown) => Promise<unknown>,
	) => {
		if (!codex.available) throw new Error("codex unavailable");
		return run({
			request: async (
				_method: string,
				params: { cwds: ReadonlyArray<string>; forceReload: boolean },
			) => {
				codex.listCalls.push(params);
				return {
					data: params.cwds.map((cwd) => ({ cwd, skills: codex.skills })),
				};
			},
		});
	},
}));

vi.mock("../../src/skill/codex-app.ts", async () => {
	const { Effect } = await import("effect");
	return {
		withCodexApp: (
			_codexPath: string | null,
			run: (app: unknown) => Promise<unknown>,
		) =>
			Effect.promise(() =>
				run({
					request: async (method: string, params: unknown) => {
						codex.writes.push({ method, params });
						return { effectiveEnabled: false };
					},
				}),
			),
	};
});

import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { SessionService } from "../../src/conversation/services/conversation-services.ts";
import { ensureBundledZuseSkillInstalled } from "../../src/skill/bundled-zuse-skill.ts";
import { SkillBridgeLive } from "../../src/skill/layers/skill-bridge.ts";
import { SkillDiscoveryServiceLive } from "../../src/skill/layers/skill-discovery.ts";
import { SkillBridge } from "../../src/skill/services/skill-bridge.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

const writeSkill = (root: string, dir: string, name = dir): void => {
	mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(
		join(root, dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} skill\n---\n`,
	);
};

let home: string;
let project: string;
let previousHome: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "zuse-skill-home-"));
	project = mkdtempSync(join(tmpdir(), "zuse-skill-project-"));
	previousHome = process.env.HOME;
	process.env.HOME = home;
	codex.available = true;
	codex.skills = [];
	codex.listCalls = [];
	codex.writes = [];
	// Codex discovery installs the bundled skill into ~/.codex/skills, which
	// Zuse discovery also reads; install it up front so results are stable.
	ensureBundledZuseSkillInstalled("codex", home);

	const claudeSkills = join(home, ".claude", "skills");
	writeSkill(claudeSkills, "pdf");
	writeSkill(claudeSkills, "docx");
	writeSkill(join(project, ".claude", "skills"), "project-only");
	writeSkill(join(home, ".zuse", "skills"), "notes");

	// A marketplace plugin installed through Claude Code, plus one the user
	// switched off in Claude's settings.
	const installPath = join(home, ".claude", "plugins", "cache", "mkt", "acme");
	writeSkill(join(installPath, "skills"), "deploy");
	const offPath = join(home, ".claude", "plugins", "cache", "mkt", "off");
	writeSkill(join(offPath, "skills"), "hidden");
	writeFileSync(
		join(home, ".claude", "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: {
				"acme@mkt": [{ scope: "user", installPath }],
				"off@mkt": [{ scope: "user", installPath: offPath }],
			},
		}),
	);
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({ enabledPlugins: { "acme@mkt": true, "off@mkt": false } }),
	);
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const makeLayer = (initialDisabled: ReadonlyArray<string> = []) => {
	let settings = {
		disabledSkills: [...initialDisabled],
	} as unknown as SettingsFile;
	const ConfigStoreTest = Layer.effect(
		ConfigStoreService,
		Effect.gen(function* () {
			const hub = yield* PubSub.unbounded<SettingsFile>();
			return {
				getSettings: () => Effect.sync(() => settings),
				updateSettings: (patch: SettingsPatch) =>
					Effect.gen(function* () {
						settings = { ...settings, ...patch } as SettingsFile;
						yield* PubSub.publish(hub, settings);
						return settings;
					}),
				settingsChanges: () =>
					Stream.concat(
						Stream.sync(() => settings),
						Stream.fromPubSub(hub),
					),
				migrateLocalStorage: () => Effect.die("unused"),
				getKeybindings: () => Effect.die("unused"),
				replaceKeybindings: () => Effect.die("unused"),
				keybindingsChanges: () => Stream.die("unused"),
			};
		}),
	);
	const SessionTest = Layer.succeed(SessionService, {
		getSession: () =>
			Effect.succeed({ providerId: "claude", projectId: "project-1" }),
	} as unknown as SessionService["Service"]);
	const WorkspaceTest = Layer.succeed(WorkspaceService, {
		findById: () => Effect.succeed({ path: project }),
	} as unknown as WorkspaceService["Service"]);
	const layer = SkillBridgeLive.pipe(
		Layer.provide(SkillDiscoveryServiceLive),
		Layer.provideMerge(ConfigStoreTest),
		Layer.provide(SessionTest),
		Layer.provide(WorkspaceTest),
		Layer.provide(NodeServices.layer),
	);
	return { layer, settings: () => settings };
};

const summary = (skills: ReadonlyArray<Skill>) =>
	skills
		.map(
			(s) =>
				`${s.providerId}:${s.name}:${s.scope}:${s.enabled ? "on" : "off"}:${s.toggleSupported ? "toggle" : "fixed"}`,
		)
		.sort();

describe("SkillBridge enablement", () => {
	it("lists global skills for every skill provider with effective enablement", async () => {
		codex.skills = [
			{
				name: "codex-on",
				description: "",
				path: "/c/on/SKILL.md",
				scope: "user",
				enabled: true,
			},
			{
				name: "codex-off",
				description: "",
				path: "/c/off/SKILL.md",
				scope: "system",
				enabled: false,
			},
			{
				name: "codex-repo",
				description: "",
				path: "/r/SKILL.md",
				scope: "repo",
				enabled: true,
			},
		];
		const { layer } = makeLayer(["claude:pdf", "zuse:notes", "codex:codex-on"]);
		const skills = await Effect.runPromise(
			Effect.flatMap(SkillBridge, (bridge) => bridge.listGlobal()).pipe(
				Effect.provide(layer),
			),
		);
		expect(summary(skills)).toEqual(
			[
				"claude:acme:deploy:global:on:toggle",
				"claude:docx:global:on:toggle",
				"claude:pdf:global:off:toggle",
				"claude:zuse:global:on:toggle",
				// Codex enablement is native; Zuse settings never override it.
				"codex:codex-off:global:off:toggle",
				"codex:codex-on:global:on:toggle",
				"zuse:notes:global:off:toggle",
				"zuse:zuse:global:on:toggle",
			].sort(),
		);
		expect(codex.listCalls[0]?.cwds).toEqual([home]);
	});

	it("marks Codex skills untoggleable when only the disk fallback is available", async () => {
		codex.available = false;
		const { layer } = makeLayer();
		const skills = await Effect.runPromise(
			Effect.flatMap(SkillBridge, (bridge) => bridge.listGlobal()).pipe(
				Effect.provide(layer),
			),
		);
		const codexSkills = skills.filter((s) => s.providerId === "codex");
		expect(codexSkills.length).toBeGreaterThan(0);
		expect(codexSkills.every((s) => s.enabled && !s.toggleSupported)).toBe(
			true,
		);
	});

	it("persists Claude toggles in disabledSkills and republishes open streams", async () => {
		const { layer, settings } = makeLayer();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const bridge = yield* SkillBridge;
				const emissions: Array<ReadonlyArray<Skill>> = [];
				const first = yield* Deferred.make<void>();
				const fiber = yield* bridge.stream("session-1" as SessionId).pipe(
					Stream.tap((skills) =>
						Effect.sync(() => emissions.push(skills)).pipe(
							Effect.andThen(Deferred.succeed(first, undefined)),
						),
					),
					Stream.take(2),
					Stream.runDrain,
					Effect.forkChild,
				);
				// Wait for the initial snapshot before toggling.
				yield* Deferred.await(first);
				const toggled = yield* bridge.setEnabled({
					providerId: "claude",
					name: "project-only",
					enabled: false,
				});
				yield* Fiber.join(fiber);
				const forProject = yield* bridge.listForProject(
					"project-1" as FolderId,
					"claude",
				);
				const global = yield* bridge.listGlobal();
				const reenabled = yield* bridge.setEnabled({
					providerId: "claude",
					name: "project-only",
					enabled: true,
				});
				return { toggled, emissions, forProject, global, reenabled };
			}).pipe(Effect.scoped, Effect.provide(layer)),
		);
		expect(result.toggled).toEqual({
			providerId: "claude",
			name: "project-only",
			enabled: false,
		});
		const projectSkill = (skills: ReadonlyArray<Skill>) =>
			skills.find((s) => s.name === "project-only");
		expect(projectSkill(result.emissions[0] ?? [])?.enabled).toBe(true);
		expect(projectSkill(result.emissions[1] ?? [])?.enabled).toBe(false);
		expect(projectSkill(result.forProject)?.enabled).toBe(false);
		expect(projectSkill(result.global)).toBeUndefined();
		expect(result.reenabled.enabled).toBe(true);
		expect(settings().disabledSkills).toEqual([]);
	});

	it("writes Codex toggles to Codex's native config and force-reloads", async () => {
		codex.skills = [
			{
				name: "codex-on",
				description: "",
				path: "/c/on/SKILL.md",
				scope: "user",
				enabled: true,
			},
		];
		const { layer, settings } = makeLayer();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const bridge = yield* SkillBridge;
				const toggled = yield* bridge.setEnabled({
					providerId: "codex",
					name: "codex-on",
					enabled: false,
				});
				yield* bridge.listGlobal();
				return toggled;
			}).pipe(Effect.provide(layer)),
		);
		expect(codex.writes).toEqual([
			{
				method: "skills/config/write",
				params: { name: "codex-on", enabled: false },
			},
		]);
		expect(result.enabled).toBe(false);
		expect(codex.listCalls.at(-1)?.forceReload).toBe(true);
		expect(settings().disabledSkills).toEqual([]);
	});

	it("rejects toggles for providers without a skill seam", async () => {
		const { layer } = makeLayer();
		const error = await Effect.runPromise(
			Effect.flatMap(SkillBridge, (bridge) =>
				bridge.setEnabled({ providerId: "grok", name: "x", enabled: false }),
			).pipe(Effect.flip, Effect.provide(layer)),
		);
		expect(error._tag).toBe("SkillConfigError");
	});
});
