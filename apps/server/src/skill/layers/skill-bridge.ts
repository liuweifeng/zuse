import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderId, Skill } from "@zuse/contracts";
import { PROVIDER_CAPABILITIES, PROVIDER_IDS } from "@zuse/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { SessionService } from "../../conversation/services/conversation-services.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { SkillBridge } from "../services/skill-bridge.ts";
import { SkillDiscoveryService } from "../services/skill-discovery.ts";
import { isZuseSkillOverrideProvider } from "../skill-enablement.ts";
import { shouldRefreshSkillsForWatch } from "../skill-watch-filter.ts";

const cacheKey = (providerId: ProviderId, projectCwd: string): string =>
	`${providerId}:${projectCwd}`;

const SKILL_PROVIDERS: ReadonlyArray<ProviderId> = PROVIDER_IDS.filter(
	(providerId) => PROVIDER_CAPABILITIES[providerId].skillFolders.length > 0,
);
const ZUSE_OVERRIDE_SKILL_PROVIDERS: ReadonlySet<ProviderId> = new Set(
	SKILL_PROVIDERS.filter(isZuseSkillOverrideProvider),
);

const watchRoots = (
	providerId: ProviderId,
	projectCwd: string,
	onChange: () => void,
): (() => void) => {
	const home = os.homedir();
	const roots =
		providerId === "zuse"
			? [home, projectCwd].flatMap((root) =>
					PROVIDER_CAPABILITIES.zuse.skillFolders.map((directory) =>
						path.join(root, directory, "skills"),
					),
				)
			: providerId === "claude"
				? [
						path.join(home, ".claude", "skills"),
						path.join(home, ".claude", "plugins"),
						path.join(projectCwd, ".claude", "skills"),
					]
				: [
						path.join(home, ".codex", "skills"),
						path.join(home, ".codex", "prompts"),
						path.join(projectCwd, ".codex", "skills"),
						path.join(projectCwd, ".codex", "prompts"),
					];

	const watchers: fsSync.FSWatcher[] = [];
	let timer: NodeJS.Timeout | null = null;
	const fire = (_event: string, filename: string | Buffer | null): void => {
		if (!shouldRefreshSkillsForWatch(providerId, filename)) return;
		if (timer !== null) clearTimeout(timer);

		timer = setTimeout(() => {
			timer = null;
			onChange();
		}, 250);
	};

	for (const root of roots) {
		try {
			const w = fsSync.watch(root, { recursive: true }, fire);
			w.on("error", () => {});
			watchers.push(w);
		} catch {}
	}

	return () => {
		if (timer !== null) clearTimeout(timer);
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
	};
};

export const SkillBridgeLive = Layer.effect(
	SkillBridge,
	Effect.gen(function* () {
		const discovery = yield* SkillDiscoveryService;
		const store = yield* SessionService;
		const workspace = yield* WorkspaceService;
		const configStore = yield* ConfigStoreService;

		interface CacheEntry {
			readonly providerId: ProviderId;
			readonly projectCwd: string;
			readonly skills: ReadonlyArray<Skill>;
			readonly stop: () => void;
			readonly hub: PubSub.PubSub<ReadonlyArray<Skill>>;

			readonly generation: number;
		}
		const cache = new Map<string, CacheEntry>();

		const refreshEntry = (key: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const started = cache.get(key);
				if (started === undefined) return;
				const generation = started.generation + 1;
				cache.set(key, { ...started, generation });
				const next = yield* discovery.discover(
					started.providerId,
					started.projectCwd,
				);
				const cur = cache.get(key);
				if (cur === undefined || cur.generation !== generation) return;
				cache.set(key, { ...cur, skills: next });
				yield* PubSub.publish(cur.hub, next);
			});

		const refreshProviders = (
			providerIds: ReadonlySet<ProviderId>,
		): Effect.Effect<void> =>
			Effect.forEach(
				[...cache.entries()]
					.filter(([, entry]) => providerIds.has(entry.providerId))
					.map(([key]) => key),
				refreshEntry,
				{ concurrency: "unbounded", discard: true },
			);

		const ensureEntry = (
			providerId: ProviderId,
			projectCwd: string,
		): Effect.Effect<CacheEntry> =>
			Effect.gen(function* () {
				const key = cacheKey(providerId, projectCwd);
				const existing = cache.get(key);
				if (existing !== undefined) return existing;

				const initial = yield* discovery.discover(providerId, projectCwd);
				const hub = yield* PubSub.unbounded<ReadonlyArray<Skill>>();
				const raced = cache.get(key);
				if (raced !== undefined) {
					yield* PubSub.shutdown(hub);
					return raced;
				}
				const stop = watchRoots(providerId, projectCwd, () => {
					Effect.runFork(refreshEntry(key));
				});
				const entry: CacheEntry = {
					providerId,
					projectCwd,
					skills: initial,
					stop,
					hub,
					generation: 0,
				};
				cache.set(key, entry);
				return entry;
			});

		const resolveSession = (
			sessionId: Parameters<SkillBridge["Service"]["list"]>[0],
		) =>
			Effect.gen(function* () {
				const session = yield* store.getSession(sessionId);
				const folder = yield* workspace.findById(session.projectId);

				const projectCwd = folder?.path ?? process.cwd();
				return { providerId: session.providerId, projectCwd };
			});

		const list: SkillBridge["Service"]["list"] = (sessionId) =>
			Effect.gen(function* () {
				const { providerId, projectCwd } = yield* resolveSession(sessionId);
				const entry = yield* ensureEntry(providerId, projectCwd);
				return entry.skills;
			});

		const listForProject: SkillBridge["Service"]["listForProject"] = (
			projectId,
			providerId,
		) =>
			Effect.gen(function* () {
				const folder = yield* workspace.findById(projectId);
				const projectCwd = folder?.path ?? process.cwd();
				const entry = yield* ensureEntry(providerId, projectCwd);
				return entry.skills;
			});

		const stream: SkillBridge["Service"]["stream"] = (sessionId) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const { providerId, projectCwd } = yield* resolveSession(sessionId);
					const entry = yield* ensureEntry(providerId, projectCwd);

					const subscription = yield* PubSub.subscribe(entry.hub);
					const current =
						cache.get(cacheKey(providerId, projectCwd))?.skills ?? entry.skills;
					return Stream.concat(
						Stream.succeed(current),
						Stream.fromSubscription(subscription),
					);
				}),
			);

		let lastDisabledSkills: string | null = null;

		const listGlobal: SkillBridge["Service"]["listGlobal"] = () =>
			Effect.forEach(
				SKILL_PROVIDERS,
				(providerId) => discovery.discover(providerId, null),
				{ concurrency: "unbounded" },
			).pipe(Effect.map((lists) => lists.flat()));

		const setEnabled: SkillBridge["Service"]["setEnabled"] = ({
			providerId,
			name,
			enabled,
		}) =>
			Effect.gen(function* () {
				const effective = yield* discovery.setEnabled(
					providerId,
					name,
					enabled,
				);

				const settings = yield* configStore.getSettings();
				lastDisabledSkills = JSON.stringify(settings.disabledSkills);
				yield* refreshProviders(new Set([providerId]));
				return { providerId, name, enabled: effective };
			});

		yield* configStore.settingsChanges().pipe(
			Stream.runForEach((settings) => {
				const next = JSON.stringify(settings.disabledSkills);
				const previous = lastDisabledSkills;
				lastDisabledSkills = next;
				return previous === null || previous === next
					? Effect.void
					: refreshProviders(ZUSE_OVERRIDE_SKILL_PROVIDERS);
			}),
			Effect.forkScoped,
		);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				for (const entry of cache.values()) entry.stop();
				cache.clear();
			}),
		);

		return { list, listForProject, stream, listGlobal, setEnabled };
	}),
);
