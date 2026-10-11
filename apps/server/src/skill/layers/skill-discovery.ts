import * as os from "node:os";
import * as path from "node:path";
import type { SkillsConfigWriteResponse } from "@zuse/agents/codex-generated/v2/SkillsConfigWriteResponse";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import {
	PROVIDER_CAPABILITIES,
	type ProviderId,
	Skill,
	SkillConfigError,
} from "@zuse/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { toggleDisabledKey } from "../../config-store/disabled-keys.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { ensureBundledZuseSkillInstalled } from "../bundled-zuse-skill.ts";
import { withCodexApp } from "../codex-app.ts";
import { createCodexSkillBatcher } from "../codex-skill-batcher.ts";
import { SkillDiscoveryService } from "../services/skill-discovery.ts";
import {
	applySkillEnablement,
	isZuseSkillOverrideProvider,
	skillEnablementKey,
} from "../skill-enablement.ts";

interface RawSkill {
	readonly name: string;
	readonly description: string;
	readonly argumentHint: string;
	readonly filePath: string;
}

interface CodexSkillMetadata {
	readonly name: string;
	readonly description: string;
	readonly shortDescription?: string;
	readonly path: string;
	readonly scope: "user" | "repo" | "system" | "admin";
	readonly enabled: boolean;
}

/**
 * Parse YAML-like frontmatter at the top of a SKILL.md / prompt file.
 * Memoize only needs `name`, `description`, and `argument-hint`; we
 * deliberately keep the parser minimal — full YAML support belongs in
 * the provider, not here. Anything we don't recognise is ignored.
 */
const parseFrontmatter = (
	content: string,
): { name?: string; description?: string; argumentHint?: string } => {
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end < 0) return {};
	const block = content.slice(3, end);
	const out: { name?: string; description?: string; argumentHint?: string } =
		{};
	for (const line of block.split("\n")) {
		const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (!m || m[1] === undefined || m[2] === undefined) continue;
		const key = m[1].toLowerCase();
		let val = m[2].trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key === "name") out.name = val;
		else if (key === "description") out.description = val;
		else if (key === "argument-hint" || key === "argumenthint")
			out.argumentHint = val;
	}
	return out;
};

const fileStem = (p: string): string => {
	const base = path.basename(p);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
};

/**
 * Read a single file safely; returns null on any error so the walker can
 * keep going. Skill discovery is best-effort — one malformed file should
 * not blank the whole popover.
 */
const readSafe = (
	fs: FileSystem.FileSystem,
	abs: string,
): Effect.Effect<string | null> =>
	fs.readFileString(abs).pipe(Effect.orElseSucceed(() => null));

const readDirSafe = (
	fs: FileSystem.FileSystem,
	abs: string,
): Effect.Effect<ReadonlyArray<string>> =>
	fs
		.readDirectory(abs)
		.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

const isDirSafe = (
	fs: FileSystem.FileSystem,
	abs: string,
): Effect.Effect<boolean> =>
	fs.stat(abs).pipe(
		Effect.map((s) => s.type === "Directory"),
		Effect.orElseSucceed(() => false),
	);

/**
 * Project a parsed file into the wire `Skill` shape. The folder containing
 * the file becomes the canonical name when frontmatter omits it, mirroring
 * Claude Code's `~/.claude/skills/<name>/SKILL.md` convention.
 */
const toSkill = (
	raw: RawSkill,
	scope: "global" | "project",
	providerId: ProviderId,
): Skill =>
	Skill.make({
		name: raw.name,
		scope,
		description: raw.description,
		arguments: raw.argumentHint
			? [{ name: raw.argumentHint, description: "", optional: true }]
			: [],
		filePath: raw.filePath,
		providerId,
	});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const dedupeProjectFirst = (skills: ReadonlyArray<Skill>): Skill[] => {
	const seen = new Set<string>();
	const out: Skill[] = [];
	for (const s of skills) {
		if (seen.has(s.name)) continue;
		seen.add(s.name);
		out.push(s);
	}
	return out;
};

export const SkillDiscoveryServiceLive = Layer.effect(
	SkillDiscoveryService,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const configStore = yield* ConfigStoreService;
		const home = os.homedir();
		// Set after a native Codex skill toggle so the next `skills/list`
		// bypasses the app-server's cached skill set.
		let codexForceReload = false;
		const codexSkills = createCodexSkillBatcher<CodexSkillMetadata>((cwds) => {
			const forceReload = codexForceReload;
			codexForceReload = false;
			return withCodexControlClient(null, (client) =>
				client
					.request<{
						data: ReadonlyArray<{
							cwd: string;
							skills: ReadonlyArray<CodexSkillMetadata>;
						}>;
					}>("skills/list", { cwds, forceReload })
					.then((response) => response.data),
			);
		}, 25);

		const readJsonSafe = (abs: string): Effect.Effect<unknown> =>
			readSafe(fs, abs).pipe(
				Effect.map((content) => {
					if (content === null) return null;
					try {
						return JSON.parse(content) as unknown;
					} catch {
						return null;
					}
				}),
			);

		/**
		 * Walk a Claude skills root. Skills can be either:
		 *   <root>/<name>/SKILL.md
		 *   <root>/<name>.md
		 * Both forms appear in the wild; we accept either.
		 */
		const readClaudeSkillsRoot = (
			root: string,
		): Effect.Effect<ReadonlyArray<RawSkill>> =>
			Effect.gen(function* () {
				const entries = yield* readDirSafe(fs, root);
				const out: RawSkill[] = [];
				for (const entry of entries) {
					if (entry.startsWith(".")) continue;
					const abs = path.join(root, entry);
					const isDir = yield* isDirSafe(fs, abs);
					let filePath: string | null = null;
					if (isDir) {
						const candidates = ["SKILL.md", "skill.md", `${entry}.md`];
						for (const c of candidates) {
							const candidate = path.join(abs, c);
							const exists = yield* fs
								.exists(candidate)
								.pipe(Effect.orElseSucceed(() => false));
							if (exists) {
								filePath = candidate;
								break;
							}
						}
					} else if (entry.endsWith(".md")) {
						filePath = abs;
					}
					if (filePath === null) continue;
					const content = yield* readSafe(fs, filePath);
					if (content === null) continue;
					const fm = parseFrontmatter(content);
					out.push({
						name: fm.name ?? (isDir ? entry : fileStem(entry)),
						description: fm.description ?? "",
						argumentHint: fm.argumentHint ?? "",
						filePath,
					});
				}
				return out;
			});

		/**
		 * Plugins lay out as `~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md`.
		 * Surface them with `<plugin>:<skill>` so they don't collide with
		 * top-level user skills, matching Claude Code's plugin namespacing.
		 */
		const readClaudePluginsRoot = (
			root: string,
		): Effect.Effect<ReadonlyArray<RawSkill>> =>
			Effect.gen(function* () {
				const entries = yield* readDirSafe(fs, root);
				const out: RawSkill[] = [];
				for (const plugin of entries) {
					if (plugin.startsWith(".")) continue;
					const skillsDir = path.join(root, plugin, "skills");
					const isDir = yield* isDirSafe(fs, skillsDir);
					if (!isDir) continue;
					const inner = yield* readClaudeSkillsRoot(skillsDir);
					for (const s of inner) {
						out.push({
							...s,
							name: `${plugin}:${s.name}`,
						});
					}
				}
				return out;
			});

		/**
		 * Marketplace plugins installed through Claude Code live wherever
		 * `~/.claude/plugins/installed_plugins.json` points (`installPath`),
		 * with skills under `<installPath>/skills/<skill>/SKILL.md`. Plugins
		 * the user switched off (`enabledPlugins[id] === false` in
		 * `~/.claude/settings.json`) and project installs for other checkouts
		 * are skipped. Without these, a Claude skills allowlist would silently
		 * hide every marketplace plugin skill.
		 */
		const readClaudeInstalledPlugins = (
			projectCwd: string | null,
		): Effect.Effect<
			ReadonlyArray<{ raw: RawSkill; scope: "global" | "project" }>
		> =>
			Effect.gen(function* () {
				const claudeDir = path.join(home, ".claude");
				const installed = yield* readJsonSafe(
					path.join(claudeDir, "plugins", "installed_plugins.json"),
				);
				if (!isRecord(installed) || !isRecord(installed.plugins)) return [];
				const userSettings = yield* readJsonSafe(
					path.join(claudeDir, "settings.json"),
				);
				const enabledPlugins =
					isRecord(userSettings) && isRecord(userSettings.enabledPlugins)
						? userSettings.enabledPlugins
						: {};
				const out: Array<{ raw: RawSkill; scope: "global" | "project" }> = [];
				for (const [pluginId, installs] of Object.entries(installed.plugins)) {
					if (enabledPlugins[pluginId] === false || !Array.isArray(installs))
						continue;
					const pluginName = pluginId.split("@")[0] || pluginId;
					for (const install of installs) {
						if (!isRecord(install) || typeof install.installPath !== "string")
							continue;
						const projectPath =
							typeof install.projectPath === "string"
								? install.projectPath
								: null;
						if (projectPath !== null && projectPath !== projectCwd) continue;
						const inner = yield* readClaudeSkillsRoot(
							path.join(install.installPath, "skills"),
						);
						for (const raw of inner) {
							out.push({
								raw: { ...raw, name: `${pluginName}:${raw.name}` },
								scope: projectPath === null ? "global" : "project",
							});
						}
					}
				}
				return out;
			});

		/**
		 * Codex prompts: `<root>/<name>.md`. First-line `# Title` is allowed
		 * but the canonical name comes from the filename. Description is the
		 * first non-blank, non-heading line.
		 */
		const readCodexPromptsRoot = (
			root: string,
		): Effect.Effect<ReadonlyArray<RawSkill>> =>
			Effect.gen(function* () {
				const entries = yield* readDirSafe(fs, root);
				const out: RawSkill[] = [];
				for (const entry of entries) {
					if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
					const abs = path.join(root, entry);
					const content = yield* readSafe(fs, abs);
					if (content === null) continue;
					const fm = parseFrontmatter(content);
					let description = fm.description ?? "";
					if (!description) {
						for (const line of content.split("\n").slice(0, 30)) {
							const t = line.trim();
							if (!t || t.startsWith("#") || t.startsWith("---")) continue;
							description = t;
							break;
						}
					}
					out.push({
						name: fm.name ?? fileStem(entry),
						description,
						argumentHint: fm.argumentHint ?? "",
						filePath: abs,
					});
				}
				return out;
			});

		const discoverClaude = (
			projectCwd: string | null,
		): Effect.Effect<ReadonlyArray<Skill>> =>
			Effect.gen(function* () {
				ensureBundledZuseSkillInstalled("claude", home);
				const globalRoot = path.join(home, ".claude", "skills");
				const pluginsRoot = path.join(home, ".claude", "plugins");

				const projectRaw =
					projectCwd === null
						? []
						: yield* readClaudeSkillsRoot(
								path.join(projectCwd, ".claude", "skills"),
							);
				const globalRaw = yield* readClaudeSkillsRoot(globalRoot);
				const pluginsRaw = yield* readClaudePluginsRoot(pluginsRoot);
				const installedPlugins = yield* readClaudeInstalledPlugins(projectCwd);

				const merged: Skill[] = [
					...projectRaw.map((r) => toSkill(r, "project", "claude")),
					...installedPlugins
						.filter((p) => p.scope === "project")
						.map((p) => toSkill(p.raw, "project", "claude")),
					...globalRaw.map((r) => toSkill(r, "global", "claude")),
					...pluginsRaw.map((r) => toSkill(r, "global", "claude")),
					...installedPlugins
						.filter((p) => p.scope === "global")
						.map((p) => toSkill(p.raw, "global", "claude")),
				];
				return dedupeProjectFirst(merged);
			});

		const discoverCodex = (
			projectCwd: string | null,
		): Effect.Effect<ReadonlyArray<Skill>> =>
			Effect.gen(function* () {
				ensureBundledZuseSkillInstalled("codex", home);
				const viaAppServer = yield* Effect.tryPromise({
					try: async (): Promise<ReadonlyArray<Skill>> => {
						// Global-only listing asks Codex about the home directory and
						// keeps user/system/admin skills; repo skills need a project.
						const skills = await codexSkills.load(projectCwd ?? home);
						return skills
							.filter((skill) => projectCwd !== null || skill.scope !== "repo")
							.map((skill) =>
								Skill.make({
									name: skill.name,
									scope: skill.scope === "repo" ? "project" : "global",
									description:
										skill.shortDescription ?? skill.description ?? "",
									arguments: [],
									filePath: skill.path,
									providerId: "codex",
									// Codex's native config is the source of truth.
									enabled: skill.enabled,
									toggleSupported: true,
								}),
							);
					},
					catch: (cause) => cause,
				}).pipe(Effect.catch(() => Effect.succeed(null)));
				if (viaAppServer !== null) return dedupeProjectFirst(viaAppServer);

				// Disk fallback (app-server unavailable): native enablement is
				// unknown and toggles cannot be written, so these stay enabled with
				// `toggleSupported: false`.
				const globalRoot = path.join(home, ".codex", "prompts");
				const globalSkillsRoot = path.join(home, ".codex", "skills");
				const projectRaw =
					projectCwd === null
						? []
						: yield* readCodexPromptsRoot(
								path.join(projectCwd, ".codex", "prompts"),
							);
				const globalRaw = yield* readCodexPromptsRoot(globalRoot);
				const projectSkillsRaw =
					projectCwd === null
						? []
						: yield* readClaudeSkillsRoot(
								path.join(projectCwd, ".codex", "skills"),
							);
				const globalSkillsRaw = yield* readClaudeSkillsRoot(globalSkillsRoot);
				const merged: Skill[] = [
					...projectSkillsRaw.map((r) => toSkill(r, "project", "codex")),
					...projectRaw.map((r) => toSkill(r, "project", "codex")),
					...globalSkillsRaw.map((r) => toSkill(r, "global", "codex")),
					...globalRaw.map((r) => toSkill(r, "global", "codex")),
				];
				return dedupeProjectFirst(merged);
			});

		const discoverZuse = (projectCwd: string | null) =>
			Effect.gen(function* () {
				const found: Skill[] = [];
				const roots: ReadonlyArray<readonly [string, "project" | "global"]> =
					projectCwd === null
						? [[home, "global"]]
						: [
								[projectCwd, "project"],
								[home, "global"],
							];
				for (const [root, scope] of roots) {
					for (const config of PROVIDER_CAPABILITIES.zuse.skillFolders) {
						const raw = yield* readClaudeSkillsRoot(
							path.join(root, config, "skills"),
						);
						found.push(...raw.map((r) => toSkill(r, scope, "zuse")));
					}
				}
				return dedupeProjectFirst(found);
			});

		const discoverRaw = (
			providerId: ProviderId,
			projectCwd: string | null,
		): Effect.Effect<ReadonlyArray<Skill>> =>
			providerId === "zuse"
				? discoverZuse(projectCwd)
				: providerId === "claude"
					? discoverClaude(projectCwd)
					: providerId === "codex"
						? discoverCodex(projectCwd)
						: Effect.succeed([]);

		const discover: SkillDiscoveryService["Service"]["discover"] = (
			providerId,
			projectCwd,
		) =>
			Effect.gen(function* () {
				const skills = yield* discoverRaw(providerId, projectCwd);
				if (!isZuseSkillOverrideProvider(providerId)) return skills;
				const settings = yield* configStore.getSettings();
				return applySkillEnablement(skills, settings.disabledSkills);
			});

		const setEnabled: SkillDiscoveryService["Service"]["setEnabled"] = (
			providerId,
			name,
			enabled,
		) =>
			Effect.gen(function* () {
				if (isZuseSkillOverrideProvider(providerId)) {
					const settings = yield* configStore.getSettings();
					yield* configStore.updateSettings({
						disabledSkills: toggleDisabledKey(
							settings.disabledSkills,
							skillEnablementKey(providerId, name),
							enabled,
						),
					});
					return enabled;
				}
				if (providerId === "codex") {
					// Codex owns its skill config — write the native flag. This
					// affects Codex everywhere, including outside Zuse.
					const response = yield* withCodexApp(null, (app) =>
						app.request<SkillsConfigWriteResponse>("skills/config/write", {
							name,
							enabled,
						}),
					).pipe(
						Effect.mapError(
							(cause) =>
								new SkillConfigError({
									providerId,
									name,
									reason: cause.message,
								}),
						),
					);
					codexForceReload = true;
					return response.effectiveEnabled;
				}
				return yield* new SkillConfigError({
					providerId,
					name,
					reason: "this provider has no skill toggle",
				});
			});

		return { discover, setEnabled };
	}),
);
