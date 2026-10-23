import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
	Chat,
	ChatId,
	ChatNotFoundError,
	Folder,
	FolderId,
	MasterError,
	type MasterOwnership,
	type MasterSettings,
	type ProviderId,
	type RepositorySettings,
	type RuntimeMode,
	Session,
	SessionId,
	SessionNotFoundError,
	Worktree,
	WorktreeId,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiLinkError,
	ApiLinkService,
} from "../../src/api/api-link-service.ts";
import { AppPaths } from "../../src/app-paths.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import {
	type ConversationOrchestrationDependencies,
	makeConversationOrchestration,
} from "../../src/conversation/core/conversation-orchestration.ts";
import {
	ChatService,
	MessageService,
	SessionService,
	TranscriptService,
} from "../../src/conversation/services/conversation-services.ts";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";
import { MasterDeployment } from "../../src/master/deployment.ts";
import { memorySource } from "../../src/master/memory.ts";
import { makeMemoryConsolidation } from "../../src/master/memory-consolidation.ts";
import { MasterMemoryDreamer } from "../../src/master/memory-dreamer.ts";
import { MasterPeers } from "../../src/master/peers.ts";
import { MasterService, MasterServiceLive } from "../../src/master/service.ts";
import {
	MasterStore,
	MasterStoreLive,
	masterFailure,
} from "../../src/master/store.ts";
import {
	MasterToolRouter,
	MasterToolRouterLive,
} from "../../src/master/tool-router.ts";
import { Migration0065Masters } from "../../src/persistence/migrations/0065_masters.ts";
import { RepositorySettingsService } from "../../src/repository-settings/services/repository-settings-service.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

/** Fail loudly if a test crosses an unconfigured external integration. */
const stub = <T extends object>(partial: Partial<T>): T =>
	new Proxy(partial, {
		get(target, key) {
			if (key in target) return Reflect.get(target, key);
			return () => {
				throw new Error(`Unexpected service call: ${String(key)}`);
			};
		},
	}) as T;
const required = <T>(value: T | null | undefined): T => {
	if (value == null) throw new Error("Missing test fixture");
	return value;
};
const settings: MasterSettings = {
	name: "Engineering",
	providerId: "codex",
	model: "test",
	instructions: "Ask before merging.",
	skills: [],
	modelGuidance: "",
	maxConcurrent: 4,
	maxFollowUps: 3,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const cluster = () => {
	const services = new Map<string, typeof MasterService.Service>();
	const ownership = new Map<string, MasterOwnership>();
	const online = new Set<string>();
	let authorityUnavailable = false;
	let loseTargetAck = false,
		loseStageAck = false,
		loseActivateAck = false;
	const peer = <A>(
		destination: string,
		operation: (
			service: typeof MasterService.Service,
		) => Effect.Effect<A, MasterError>,
	) =>
		Effect.tryPromise({
			try: async () => {
				const service = services.get(destination);
				if (!service || !online.has(destination))
					throw new Error("Environment offline");
				return Effect.runPromise(operation(service));
			},
			catch: masterFailure,
		});
	const createHome = async (
		environmentId: string,
		memoryModel?: (typeof MasterMemoryDreamer.Service)["generate"],
		crossEnvironment = true,
	) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-master-test-"));
		const repositoryRuntimeModes = new Map<string, RuntimeMode>();
		const runtimeModeCommands = new Set<string>();
		const defaults: { runtimeMode: RuntimeMode } = {
			runtimeMode: "full-access",
		};
		let catalogDefect = false;
		const folders = new Map<string, Folder>();
		const chats = new Map<string, Chat>();
		const sessions = new Map<string, Session>();
		const worktrees = new Map<string, Worktree>();
		const interrupts = new Set<string>();
		const sends = new Map<string, { sessionId: string; text: string }>();
		const repository = Folder.make({
			id: FolderId.make("repo"),
			path: directory,
			name: "Repo",
			addedAt: new Date(),
		});
		folders.set(repository.id, repository);
		const database = sqliteLayer({ filename: ":memory:" });
		const migrated = Layer.effectDiscard(
			Effect.gen(function* () {
				yield* Migration0065Masters;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT, stream_kind TEXT, type TEXT, payload_json TEXT)`;
				yield* sql`CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content_json TEXT)`;
			}),
		).pipe(Layer.provideMerge(database));
		const makeSession = (
			chat: Chat,
			id = SessionId.make(crypto.randomUUID()),
			selection: {
				readonly providerId: ProviderId;
				readonly model: string;
				readonly runtimeMode?: RuntimeMode;
			} = { providerId: settings.providerId, model: settings.model },
		) => {
			const value = Session.make({
				id,
				chatId: chat.id,
				projectId: chat.projectId,
				title: chat.title,
				titleProvenance: "manual",
				providerId: selection.providerId,
				model: selection.model,
				status: "idle",
				archivedAt: null,
				providerThread: null,
				runtimeMode: selection.runtimeMode ?? "approval-required",
				worktreeId: chat.worktreeId,
				forkedFromSessionId: null,
				forkedFromMessageId: null,
				permissionMode: "default",
				toolSearch: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			sessions.set(value.id, value);
			return value;
		};
		const fakeChat = stub<typeof ChatService.Service>({
			listChats: (folderId) =>
				Effect.succeed(
					[...chats.values()].filter((chat) => chat.projectId === folderId),
				),
			getChat: (chatId) =>
				chats.has(chatId)
					? Effect.succeed(required(chats.get(chatId)))
					: Effect.fail(new ChatNotFoundError({ chatId })),
			createChat: (input) =>
				Effect.sync(() => {
					const id = input.chatId ?? ChatId.make(crypto.randomUUID());
					const chat =
						chats.get(id) ??
						Chat.make({
							id,
							projectId: input.projectId,
							title: input.title ?? "Chat",
							titleProvenance: "manual",
							worktreeId: input.worktreeId ?? null,
							activeSessionId: input.initialSessionId ?? null,
							originSessionId: null,
							archivedAt: null,
							lastMessageAt: null,
							lastReadAt: null,
							createdAt: new Date(),
							updatedAt: new Date(),
						});
					chats.set(id, chat);
					return {
						chat,
						initialMessage: null,
						initialSession:
							(input.initialSessionId &&
								sessions.get(input.initialSessionId)) ||
							makeSession(chat, input.initialSessionId, input),
					};
				}),
		});
		const dependencies = Layer.mergeAll(
			Layer.succeed(MasterDeployment, { crossEnvironment }),
			migrated,
			NodeServices.layer,
			Layer.succeed(MasterMemoryDreamer, {
				generate:
					memoryModel ??
					(() =>
						Effect.fail(
							new MasterError({ reason: "No test model configured" }),
						)),
			}),
			MasterToolRouterLive,
			Layer.succeed(AppPaths, { userData: directory }),
			Layer.succeed(
				ConfigStoreService,
				stub<typeof ConfigStoreService.Service>({
					getSettings: () =>
						Effect.succeed(
							stub<
								Effect.Success<
									ReturnType<typeof ConfigStoreService.Service.getSettings>
								>
							>({ defaultRuntimeMode: defaults.runtimeMode }),
						),
				}),
			),
			Layer.succeed(
				RepositorySettingsService,
				stub<typeof RepositorySettingsService.Service>({
					get: (folderId) =>
						Effect.succeed(
							stub<RepositorySettings>({
								defaultRuntimeMode:
									repositoryRuntimeModes.get(folderId) ?? null,
							}),
						),
				}),
			),
			Layer.succeed(ChatService, fakeChat),
			Layer.succeed(
				SessionService,
				stub<typeof SessionService.Service>({
					getSession: (sessionId) => {
						const session = sessions.get(sessionId);
						return session
							? Effect.succeed(session)
							: Effect.fail(new SessionNotFoundError({ sessionId }));
					},
					listSessions: (folderId) =>
						catalogDefect
							? Effect.die(new Error("Unrecognized saved provider"))
							: Effect.succeed(
									[...sessions.values()].filter(
										(session) => session.projectId === folderId,
									),
								),
					// Like the session domain, a repeated command ID replays its receipt.
					setRuntimeMode: (sessionId, runtimeMode, commandId) =>
						Effect.sync(() => {
							if (runtimeModeCommands.has(commandId)) return;
							runtimeModeCommands.add(commandId);
							const session = required(sessions.get(sessionId));
							sessions.set(
								sessionId,
								Session.make({ ...session, runtimeMode }),
							);
						}),
					createSession: (input) =>
						Effect.sync(() =>
							makeSession(
								required(chats.get(input.chatId)),
								input.sessionId,
								input,
							),
						),
				}),
			),
			Layer.succeed(
				MessageService,
				stub<typeof MessageService.Service>({
					sendMessage: (commandId, sessionId, text) =>
						Effect.sync(() => {
							if (!sends.has(commandId))
								sends.set(commandId, { sessionId, text });
						}),
					interruptSession: (_commandId, sessionId) =>
						Effect.sync(() => {
							interrupts.add(sessionId);
							return {
								_tag: "not-active" as const,
								reason: "no-active-turn" as const,
								expectedTurnId: null,
								actualTurnId: null,
							};
						}),
				}),
			),
			Layer.succeed(
				TranscriptService,
				stub<typeof TranscriptService.Service>({
					exportTranscript: (sessionId) =>
						Effect.succeed(`Transcript of ${sessionId}`),
				}),
			),
			Layer.succeed(WorkspaceService, {
				createScratch: () =>
					Effect.die(new Error("Unexpected scratch workspace creation")),
				add: (path, options) =>
					Effect.sync(() => {
						const folder = Folder.make({
							id: FolderId.make(
								options
									? `master-workspace-${options.privateId}`
									: crypto.randomUUID(),
							),
							path,
							name: "Workspace",
							addedAt: new Date(),
						});
						folders.set(folder.id, folder);
						return folder;
					}),
				list: () => Effect.succeed([...folders.values()]),
				findById: (id) => Effect.succeed(folders.get(id) ?? null),
				getSelected: () => Effect.succeed(null),
				setSelected: () => Effect.void,
				remove: () => Effect.void,
				streamChanges: () => Stream.empty,
			}),
			Layer.succeed(
				WorktreeService,
				stub<typeof WorktreeService.Service>({
					get: (id) => Effect.succeed(worktrees.get(id) ?? null),
					create: (folderId, _base, requestedId) =>
						Effect.sync(() => {
							const id = requestedId ?? WorktreeId.make(crypto.randomUUID());
							const worktree = Worktree.make({
								id,
								projectId: folderId,
								path: join(directory, id),
								name: "task",
								branch: "task",
								branchProvenance: "manual",
								baseBranch: "main",
								createdAt: new Date(),
								setupStatus: "succeeded",
								setupOutput: "",
								setupStartedAt: null,
								setupFinishedAt: null,
								pokemon: null,
							});
							worktrees.set(id, worktree);
							return worktree;
						}),
				}),
			),
			Layer.succeed(
				GitService,
				stub<typeof GitService.Service>({
					prState: () => Effect.fail(new Error("No GitHub fixture") as never),
				}),
			),
			Layer.succeed(
				LanAuthService,
				stub<typeof LanAuthService.Service>({
					environmentKeys: () =>
						Effect.succeed({ envId: environmentId } as never),
					getApiConfig: () => Effect.succeed({ environmentId } as never),
				}),
			),
			Layer.succeed(
				ApiLinkService,
				stub<typeof ApiLinkService.Service>({
					masterAuthority: (masterId, command) =>
						authorityUnavailable
							? Effect.fail(new ApiLinkError({ reason: "api_404:not_found" }))
							: Effect.sync(() => {
									const current = ownership.get(masterId);
									if (command._tag === "read") return current ?? null;
									if (
										current?.generation === command.expectedGeneration + 1 &&
										current.homeEnvironmentId === command.homeEnvironmentId
									)
										return current;
									if ((current?.generation ?? 0) !== command.expectedGeneration)
										throw new Error("Ownership conflict");
									const value = {
										masterId,
										generation: command.expectedGeneration + 1,
										homeEnvironmentId: command.homeEnvironmentId,
										repositories: command.repositories,
									};
									ownership.set(masterId, value);
									return value;
								}),
				}),
			),
			Layer.succeed(MasterPeers, {
				probe: (destination) => peer(destination, () => Effect.void),
				target: (destination, input) =>
					peer(destination, (service) => service.target(input)).pipe(
						Effect.flatMap((result) => {
							if (loseTargetAck && input.action._tag === "delegate") {
								loseTargetAck = false;
								return Effect.fail(
									new MasterError({ reason: "Acknowledgment lost" }),
								);
							}
							return Effect.succeed(result);
						}),
					),
				stage: (destination, commandId, payload) =>
					peer(destination, (service) =>
						service.transfer(commandId, payload),
					).pipe(
						Effect.flatMap((result) => {
							if (loseStageAck) {
								loseStageAck = false;
								return Effect.fail(
									new MasterError({ reason: "Stage acknowledgment lost" }),
								);
							}
							return Effect.succeed(result);
						}),
					),
				activate: (destination, masterId, commandId) =>
					peer(destination, (service) =>
						service.activate(masterId, commandId),
					).pipe(
						Effect.flatMap((result) => {
							if (loseActivateAck) {
								loseActivateAck = false;
								return Effect.fail(
									new MasterError({ reason: "Activation acknowledgment lost" }),
								);
							}
							return Effect.succeed(result);
						}),
					),
				workerQuery: (
					destination,
					masterId,
					workerEnvironment,
					sessionId,
					query,
				) =>
					peer(destination, (service) =>
						service.workerQuery(masterId, workerEnvironment, sessionId, query),
					),
			}),
		);
		const storeLayer = MasterStoreLive.pipe(Layer.provide(migrated));
		const runtime = ManagedRuntime.make(
			MasterServiceLive.pipe(
				Layer.provideMerge(storeLayer),
				Layer.provideMerge(dependencies),
			),
		);
		const service = await runtime.runPromise(MasterService);
		services.set(environmentId, service);
		online.add(environmentId);
		cleanups.push(async () => {
			online.delete(environmentId);
			services.delete(environmentId);
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		});
		return {
			directory,
			failCatalog: () => {
				catalogDefect = true;
			},
			service,
			runtime,
			chats,
			sessions,
			folders,
			worktrees,
			sends,
			interrupts,
			repository,
			fakeChat,
			repositoryRuntimeModes,
			defaults,
		};
	};
	return {
		createHome,
		setAuthorityUnavailable: () => {
			authorityUnavailable = true;
		},
		ownership,
		online,
		loseNextTargetAck: () => {
			loseTargetAck = true;
		},
		loseNextActivateAck: () => {
			loseActivateAck = true;
		},
		loseNextStageAck: () => {
			loseStageAck = true;
		},
	};
};

describe("Master coordination across environment boundaries", () => {
	it("binds coordinator instructions and tools from the owning runtime outside an RPC context", async () => {
		const home = await cluster().createHome("local");
		const master = await Effect.runPromise(
			home.service.create({
				commandId: "coordinator-context",
				settings,
				repositories: [
					{ environmentId: "local", folderId: "repo", name: "Repo" },
				],
			}),
		);
		const session = required(
			home.sessions.get(required(master.activeSessionId)),
		);
		const runtime = await home.runtime.runPromise(Effect.context<never>());
		const tools = await Effect.runPromise(
			makeConversationOrchestration(
				stub<ConversationOrchestrationDependencies>({
					runtime,
					getSettings: () => Effect.fail("use defaults"),
					getModelCatalog: () => Effect.fail("use bundled models"),
				}),
				{
					sessionId: session.id,
					chatId: session.chatId,
					projectId: session.projectId,
					worktreeId: null,
					providerId: session.providerId,
					model: session.model,
				},
			),
		);
		expect(tools.instructions).toContain("You are the coordinator");
		expect(await tools.deps.master?.(undefined, true)).toMatchObject({
			ok: true,
		});
	});

	it("routes CLI actions with stable IDs and preserves Plan mode and coordinator ownership", async () => {
		const home = await cluster().createHome("local");
		const master = await Effect.runPromise(
			home.service.create({
				commandId: "cli-master",
				settings,
				repositories: [
					{ environmentId: "local", folderId: "repo", name: "Repo" },
				],
			}),
		);
		const router = await home.runtime.runPromise(MasterToolRouter);
		const sid = required(master.activeSessionId);
		const action = JSON.stringify({
			_tag: "delegate",
			environmentId: "local",
			folderId: "repo",
			task: "Fix search",
			title: "Search",
			providerId: "codex",
			model: "test",
		});
		const session = required(home.sessions.get(sid));
		home.sessions.set(
			sid,
			Session.make({ ...session, permissionMode: "plan" }),
		);
		expect(await router.call(sid, action, false, "cli-delegate")).toMatchObject(
			{ ok: false, error: "Zot mutations are blocked in Plan mode." },
		);
		home.sessions.set(sid, session);
		expect(await router.call(sid, action, false, "cli-delegate")).toMatchObject(
			{ ok: true },
		);
		expect(await router.call(sid, action, false, "cli-delegate")).toMatchObject(
			{ ok: true },
		);
		expect(
			(await Effect.runPromise(home.service.snapshot(master.id))).master
				.workers,
		).toHaveLength(1);
		expect(home.worktrees.size).toBe(1);
		await Effect.runPromise(
			home.service.execute(master.id, "cli-renew", { _tag: "renew" }),
		);
		expect(
			await router.call(sid, action, false, "cli-old-coordinator"),
		).toMatchObject({ ok: false });
	});

	it("keeps Master state readable when a repository contains incompatible saved sessions", async () => {
		const home = await cluster().createHome("local");
		await Effect.runPromise(
			home.fakeChat.createChat({
				projectId: home.repository.id,
				providerId: "codex",
				model: "test",
			}),
		);
		const master = await Effect.runPromise(
			home.service.create({
				commandId: "catalog-fault",
				settings,
				repositories: [
					{ environmentId: "local", folderId: "repo", name: "Repo" },
				],
			}),
		);
		expect(
			(await Effect.runPromise(home.service.snapshot(master.id))).chats,
		).toHaveLength(1);
		home.failCatalog();
		const snapshot = await Effect.runPromise(home.service.snapshot(master.id));
		expect(snapshot.unavailableEnvironments).toEqual(["local"]);
		expect(snapshot.chats[0]).toMatchObject({ stale: true, offline: true });
		expect(snapshot.coordinator?.id).toBe(master.activeSessionId);
	});

	it("runs the coordinator and its slaves with the user's permission defaults", async () => {
		const home = await cluster().createHome("local");
		home.repositoryRuntimeModes.set("repo", "auto-accept-edits");
		const master = await Effect.runPromise(
			home.service.create({
				commandId: "create-modes",
				settings,
				repositories: [
					{ environmentId: "local", folderId: "repo", name: "Repo" },
				],
			}),
		);
		// The private workspace has no repository override: the global default.
		expect(
			home.sessions.get(required(master.activeSessionId))?.runtimeMode,
		).toBe("full-access");
		await Effect.runPromise(
			home.service.execute(master.id, "delegate-modes", {
				_tag: "delegate",
				environmentId: "local",
				folderId: "repo",
				task: "Fix search",
				title: "Search",
				providerId: "codex",
				model: "test",
			}),
		);
		const worker = required(
			[...home.sessions.values()].find((session) =>
				session.id.startsWith("master-session-"),
			),
		);
		expect(worker.runtimeMode).toBe("auto-accept-edits");

		// Coordinators saved before this asked on every step; the supervisor
		// moves them to the current default.
		const coordinator = required(
			home.sessions.get(required(master.activeSessionId)),
		);
		home.sessions.set(
			coordinator.id,
			Session.make({ ...coordinator, runtimeMode: "approval-required" }),
		);
		await vi.waitFor(
			() =>
				expect(home.sessions.get(coordinator.id)?.runtimeMode).toBe(
					"full-access",
				),
			{ timeout: 5_000, interval: 50 },
		);

		// Back to a mode used before, then forward again: each change applies.
		for (const mode of ["approval-required", "full-access"] as const) {
			home.defaults.runtimeMode = mode;
			await vi.waitFor(
				() => expect(home.sessions.get(coordinator.id)?.runtimeMode).toBe(mode),
				{ timeout: 5_000, interval: 50 },
			);
		}
	}, 20_000);

	it("writes delegation-only coordinator instructions on creation and renewal", async () => {
		const home = await cluster().createHome("local");
		const master = await Effect.runPromise(
			home.service.create({
				commandId: "create-role",
				settings,
				repositories: [
					{ environmentId: "local", folderId: "repo", name: "Repo" },
				],
			}),
		);
		const instructions = () =>
			readFileSync(
				join(home.directory, "masters", master.id, "AGENTS.md"),
				"utf8",
			);
		expect(instructions()).toContain(
			"Delegate all work to workers: implementation, research, investigation, triage, analysis and reviews",
		);
		expect(instructions()).toContain("Create a worker before any work begins");
		expect(instructions()).toContain("Ask before merging.");
		// Packaged builds have no zuse CLI; coordination goes through MCP tools.
		expect(instructions()).toContain("master_state and master_action tools");
		expect(instructions()).not.toMatch(/zuse master (state|action)/);
		expect(instructions()).toContain(
			"don't use shell commands, file search, plugins or connected services to do a task",
		);
		await Effect.runPromise(
			home.service.execute(master.id, "renew-role", { _tag: "renew" }),
		);
		expect(instructions()).toContain("Create a worker before any work begins");
		expect(home.sends.size).toBe(0);
	});

	it("observes existing chats without instructions and retries a lost delegation acknowledgment once", async () => {
		const group = cluster(),
			source = await group.createHome("local"),
			destination = await group.createHome("cloud");
		await Effect.runPromise(
			destination.fakeChat.createChat({
				projectId: destination.repository.id,
				providerId: "codex",
				model: "test",
			}),
		);
		const master = await Effect.runPromise(
			source.service.create({
				commandId: "create",
				settings,
				repositories: [
					{ environmentId: "cloud", folderId: "repo", name: "Repo" },
				],
			}),
		);
		expect(
			(await Effect.runPromise(source.service.snapshot(master.id))).chats,
		).toHaveLength(1);
		expect(destination.sends.size).toBe(0);
		const delegate = {
			_tag: "delegate" as const,
			environmentId: "cloud",
			folderId: "repo",
			task: "Fix search",
			title: "Search",
			providerId: "codex" as const,
			model: "test",
		};
		group.loseNextTargetAck();
		await expect(
			Effect.runPromise(
				source.service.execute(master.id, "delegate", delegate),
			),
		).rejects.toThrow();
		const earlyWorker = required(
			[...destination.sessions.values()].find((session) =>
				session.id.startsWith("master-session-"),
			),
		);
		const shared = await Effect.runPromise(
			source.service.workerQuery(master.id, "cloud", earlyWorker.id, {
				_tag: "state",
			}),
		);
		expect(JSON.parse(shared.json).objective).toBe("Fix search");
		await Effect.runPromise(
			source.service.workerQuery(master.id, "cloud", earlyWorker.id, {
				_tag: "report",
				id: "finding",
				text: "The index needs rebuilding.",
			}),
		);
		const result = await Effect.runPromise(
			source.service.execute(master.id, "delegate", delegate),
		);
		expect(result.workers).toHaveLength(1);
		expect(destination.chats.size).toBe(2);
		expect(destination.worktrees.size).toBe(1);
		expect(
			(
				await Effect.runPromise(
					source.service.execute(master.id, "delegate", delegate),
				)
			).revision,
		).toBe(result.revision);
		group.online.delete("cloud");
		const offline = await Effect.runPromise(source.service.snapshot(master.id));
		expect(offline.chats[0]?.offline).toBe(true);
		expect(offline.unavailableEnvironments).toEqual(["cloud"]);
	});
	it.each([
		"stage",
		"activation",
	] as const)("recovers a lost %s acknowledgment with one owner and intact history", async (failure) => {
		const group = cluster(),
			source = await group.createHome("local"),
			destination = await group.createHome("cloud");
		let master = await Effect.runPromise(
			source.service.create({
				commandId: "create",
				settings,
				repositories: [],
			}),
		);
		master = await Effect.runPromise(
			source.service.execute(master.id, "decision", {
				_tag: "entry",
				id: "decision",
				kind: "decision",
				text: "Choose API version",
				status: "open",
			}),
		);
		master = await Effect.runPromise(
			source.service.execute(master.id, "publish", {
				_tag: "publish",
				id: "plan",
				title: "Plan",
				kind: "markdown",
				content: "Shared plan",
				expectedVersion: 0,
				pinned: true,
			}),
		);
		const previous = required(master.activeSessionId);
		master = await Effect.runPromise(
			source.service.execute(master.id, "renew", { _tag: "renew" }),
		);
		expect(master.activeSessionId).not.toBe(previous);
		expect(master.entries[0]?.status).toBe("open");
		expect(master.conversations).toHaveLength(2);
		if (failure === "stage") group.loseNextStageAck();
		else group.loseNextActivateAck();
		await expect(
			Effect.runPromise(
				source.service.execute(master.id, "move", {
					_tag: "move",
					environmentId: "cloud",
				}),
			),
		).rejects.toThrow();
		expect(group.ownership.get(master.id)?.homeEnvironmentId).toBe(
			failure === "stage" ? "local" : "cloud",
		);
		const moved = await Effect.runPromise(
			source.service.execute(master.id, "move", {
				_tag: "move",
				environmentId: "cloud",
			}),
		);
		expect(group.ownership.get(master.id)?.homeEnvironmentId).toBe("cloud");
		expect(moved.generation).toBe(2);
		expect(moved.conversations).toHaveLength(3);
		expect(
			(
				await Effect.runPromise(
					destination.service.artifact(master.id, "plan", 1),
				)
			).content,
		).toBe("Shared plan");
		expect(
			(
				await Effect.runPromise(
					destination.service.transcript(master.id, previous),
				)
			).content,
		).toBe(`Transcript of ${previous}`);
		await expect(
			Effect.runPromise(
				source.service.execute(master.id, "old-home", { _tag: "renew" }),
			),
		).rejects.toThrow();
		expect(
			(await Effect.runPromise(destination.service.snapshot(master.id))).master
				.entries[0]?.text,
		).toBe("Choose API version");
	});
});

it("routes settlements only to the fresh coordinator and respects denial and follow-up limits", async () => {
	const group = cluster(),
		source = await group.createHome("local"),
		destination = await group.createHome("cloud");
	let master = await Effect.runPromise(
		source.service.create({
			commandId: "create",
			settings,
			repositories: [
				{ environmentId: "cloud", folderId: "repo", name: "Repo" },
			],
		}),
	);
	master = await Effect.runPromise(
		source.service.execute(master.id, "delegate", {
			_tag: "delegate",
			environmentId: "cloud",
			folderId: "repo",
			task: "Fix search",
			title: "Search",
			providerId: "codex",
			model: "test",
		}),
	);
	const worker = required(master.workers[0]);
	const previous = master.activeSessionId;
	master = await Effect.runPromise(
		source.service.execute(master.id, "renew", { _tag: "renew" }),
	);
	await destination.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO events (stream_id, stream_kind, type, payload_json) VALUES (${worker.sessionId}, 'session', 'TurnSettled', '{"outcome":"completed"}')`;
		}),
	);
	const deadline = Date.now() + 5000;
	while (source.sends.size === 0 && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 25));
	expect(
		[...source.sends.values()].map((message) => message.sessionId),
	).toEqual([master.activeSessionId]);
	expect(
		[...source.sends.values()].some(
			(message) => message.sessionId === previous,
		),
	).toBe(false);
	for (let index = 0; index < 3; index++)
		await Effect.runPromise(
			source.service.execute(
				master.id,
				`follow-${index}`,
				{
					_tag: "message",
					environmentId: "cloud",
					sessionId: worker.sessionId,
					text: "Please continue the requested objective.",
				},
				required(master.activeSessionId),
			),
		);
	await expect(
		Effect.runPromise(
			source.service.execute(
				master.id,
				"follow-excess",
				{
					_tag: "message",
					environmentId: "cloud",
					sessionId: worker.sessionId,
					text: "Please continue.",
				},
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow();
	expect(destination.sends.size).toBe(3);
	await Effect.runPromise(
		source.service.execute(master.id, "interrupt", {
			_tag: "interrupt",
			environmentId: "cloud",
			sessionId: worker.sessionId,
		}),
	);
	await expect(
		Effect.runPromise(
			source.service.execute(
				master.id,
				"after-interrupt",
				{
					_tag: "message",
					environmentId: "cloud",
					sessionId: worker.sessionId,
					text: "Please continue.",
				},
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow();
	expect(
		(await Effect.runPromise(source.service.snapshot(master.id))).master
			.workers[0]?.state,
	).toBe("paused");
}, 10000);

it("recovers an unacknowledged worker after stop without starting a replacement", async () => {
	const group = cluster(),
		source = await group.createHome("local"),
		destination = await group.createHome("cloud");
	let master = await Effect.runPromise(
		source.service.create({
			commandId: "create",
			settings,
			repositories: [
				{ environmentId: "cloud", folderId: "repo", name: "Repo" },
			],
		}),
	);
	const action = {
		_tag: "delegate" as const,
		environmentId: "cloud",
		folderId: "repo",
		task: "Fix search",
		title: "Search",
		providerId: "codex" as const,
		model: "test",
	};
	group.loseNextTargetAck();
	await expect(
		Effect.runPromise(source.service.execute(master.id, "lost", action)),
	).rejects.toThrow();
	group.online.delete("cloud");
	master = await Effect.runPromise(
		source.service.execute(master.id, "stop", {
			_tag: "control",
			status: "stopped",
		}),
	);
	expect(master.status).toBe("stopped");
	expect(destination.chats.size).toBe(1);
	group.online.add("cloud");
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline) {
		master = (await Effect.runPromise(source.service.snapshot(master.id)))
			.master;
		if (master.workers.length) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(master.workers[0]?.state).toBe("paused");
	expect(destination.chats.size).toBe(1);
	expect(destination.worktrees.size).toBe(1);
	expect(destination.interrupts.size).toBeGreaterThan(0);
	await expect(
		Effect.runPromise(source.service.execute(master.id, "lost", action)),
	).rejects.toThrow();
}, 10000);

it.each([
	"stop",
	"detach",
] as const)("cancels queued work on %s and preserves its existing chats", async (operation) => {
	const group = cluster(),
		source = await group.createHome("local"),
		destination = await group.createHome("cloud");
	let master = await Effect.runPromise(
		source.service.create({
			commandId: "create",
			settings: { ...settings, maxConcurrent: 1 },
			repositories: [
				{ environmentId: "cloud", folderId: "repo", name: "Repo" },
			],
		}),
	);
	const action = {
		_tag: "delegate" as const,
		environmentId: "cloud",
		folderId: "repo",
		task: "Fix search",
		title: "Search",
		providerId: "codex" as const,
		model: "test",
	};
	master = await Effect.runPromise(
		source.service.execute(master.id, "first", action),
	);
	const worker = required(master.workers[0]);
	await destination.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO events (stream_id, stream_kind, type, payload_json) VALUES (${worker.sessionId}, 'session', 'TurnStarted', '{}')`;
		}),
	);
	await Effect.runPromise(source.service.execute(master.id, "queued", action));
	expect(
		(
			await Effect.runPromise(source.service.snapshot(master.id))
		).pendingActions.some(
			(item) => item.commandId === "queued" && item.state === "queued",
		),
	).toBe(true);
	if (operation === "detach") {
		const current = (
			await Effect.runPromise(source.service.snapshot(master.id))
		).master;
		const detached = await Effect.runPromise(
			source.service.execute(master.id, "detach", {
				_tag: "configure",
				expectedRevision: current.revision,
				settings: current.settings,
				repositories: [],
			}),
		);
		expect(detached.workers).toHaveLength(0);
		expect(
			(await Effect.runPromise(source.service.snapshot(master.id)))
				.pendingActions,
		).toHaveLength(0);
		expect(destination.chats.size).toBe(1);
		expect(destination.interrupts.size).toBe(0);
		await expect(
			Effect.runPromise(source.service.execute(master.id, "queued", action)),
		).rejects.toThrow();
		return;
	}
	group.online.delete("cloud");
	await Effect.runPromise(
		source.service.execute(master.id, "stop", {
			_tag: "control",
			status: "stopped",
		}),
	);
	group.online.add("cloud");
	const deadline = Date.now() + 6000;
	while (!destination.interrupts.size && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 25));
	expect(destination.interrupts.has(worker.sessionId)).toBe(true);
	expect(destination.chats.size).toBe(1);
	await expect(
		Effect.runPromise(source.service.execute(master.id, "queued", action)),
	).rejects.toThrow();
}, 10000);

it("permission denial pauses the objective without an automatic retry", async () => {
	const group = cluster(),
		source = await group.createHome("local"),
		destination = await group.createHome("cloud");
	let master = await Effect.runPromise(
		source.service.create({
			commandId: "create",
			settings,
			repositories: [
				{ environmentId: "cloud", folderId: "repo", name: "Repo" },
			],
		}),
	);
	master = await Effect.runPromise(
		source.service.execute(master.id, "delegate", {
			_tag: "delegate",
			environmentId: "cloud",
			folderId: "repo",
			task: "Fix search",
			title: "Search",
			providerId: "codex",
			model: "test",
		}),
	);
	const worker = required(master.workers[0]);
	await destination.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO events (stream_id, stream_kind, type, payload_json) VALUES (${worker.sessionId}, 'session', 'PermissionResolved', '{"decision":"Deny"}')`;
		}),
	);
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline) {
		master = (await Effect.runPromise(source.service.snapshot(master.id)))
			.master;
		if (master.workers[0]?.state === "paused") break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(master.workers[0]?.state).toBe("paused");
	expect(destination.sends.size).toBe(0);
	await expect(
		Effect.runPromise(
			source.service.execute(
				master.id,
				"retry",
				{
					_tag: "message",
					environmentId: "cloud",
					sessionId: worker.sessionId,
					text: "Continue",
				},
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow();
}, 10000);

it("creates a local Master when the account API has not deployed Masters", async () => {
	const group = cluster();
	group.setAuthorityUnavailable();
	const source = await group.createHome("local");
	const input = {
		commandId: "local-create",
		settings,
		repositories: [{ environmentId: "local", folderId: "repo", name: "Repo" }],
	};
	const master = await Effect.runPromise(source.service.create(input));
	expect(master.accountManaged).toBe(false);
	expect(master.activeSessionId).toBeTruthy();
	expect((await Effect.runPromise(source.service.create(input))).id).toBe(
		master.id,
	);
	expect(source.chats.size).toBe(1);
});
it("does not leave a Master when cross-environment ownership is unavailable", async () => {
	const group = cluster();
	group.setAuthorityUnavailable();
	const source = await group.createHome("local");
	await expect(
		Effect.runPromise(
			source.service.create({
				commandId: "remote-create",
				settings,
				repositories: [
					{ environmentId: "cloud", folderId: "repo", name: "Repo" },
				],
			}),
		),
	).rejects.toThrow("Cross-environment Zots are not available");
	const count = await source.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql`SELECT id FROM masters`;
		}),
	);
	expect(count).toHaveLength(0);
	expect(source.chats.size).toBe(0);
});
it("changes a Master's name and mascot without starting a new conversation", async () => {
	const home = await cluster().createHome("local");
	const master = await Effect.runPromise(
		home.service.create({ commandId: "create", settings, repositories: [] }),
	);
	const avatar = { mascot: "ping", color: "teal" } as const;
	const updated = await Effect.runPromise(
		home.service.execute(master.id, "appearance", {
			_tag: "appearance",
			name: "  pip  ",
			avatar,
		}),
	);
	expect(updated.settings.name).toBe("pip");
	expect(updated.settings.avatar).toEqual(avatar);
	expect(updated.activeSessionId).toBe(master.activeSessionId);
	expect(updated.conversations).toHaveLength(master.conversations.length);
	await expect(
		Effect.runPromise(
			home.service.execute(
				master.id,
				"coordinator-appearance",
				{
					_tag: "appearance",
					name: "mine now",
					avatar,
				},
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow("controlled by the user");
	await expect(
		Effect.runPromise(
			home.service.execute(master.id, "blank-appearance", {
				_tag: "appearance",
				name: "   ",
				avatar,
			}),
		),
	).rejects.toThrow("1–120 characters");
});

it("keeps attributed memory versions across renewal, retries and home transfer", async () => {
	const group = cluster();
	const home = await group.createHome("local");
	const destination = await group.createHome("cloud");
	let master = await Effect.runPromise(
		home.service.create({
			commandId: "memory-create",
			settings,
			repositories: [],
		}),
	);
	master = await Effect.runPromise(
		home.service.execute(master.id, "finding", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Repository tests require Bun.",
			status: "open",
		}),
	);
	const source = memorySource(
		required(master.entries.find((entry) => entry.id === "finding")),
	);
	const action = {
		_tag: "remember" as const,
		path: "testing.md",
		title: "Testing",
		summary: "Use Bun for repository tests",
		content: "Run repository tests with Bun.",
		sources: [source],
		expectedVersion: 0,
		archived: false,
	};
	const first = await Effect.runPromise(
		home.service.execute(
			master.id,
			"remember",
			action,
			required(master.activeSessionId),
		),
	);
	expect(
		(
			await Effect.runPromise(
				home.service.execute(
					master.id,
					"remember",
					action,
					required(master.activeSessionId),
				),
			)
		).revision,
	).toBe(first.revision);
	await expect(
		Effect.runPromise(home.service.execute(master.id, "stale", action)),
	).rejects.toThrow("Memory changed");
	await expect(
		Effect.runPromise(
			home.service.execute(
				master.id,
				"forged",
				{
					...action,
					path: "forged.md",
					sources: [{ ...source, fingerprint: "fake" }],
				},
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow("source changed");
	master = await Effect.runPromise(
		home.service.execute(master.id, "finding-update", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Use the updated test command.",
			status: "open",
		}),
	);
	const nextSource = memorySource(
		required(master.entries.find((entry) => entry.id === "finding")),
	);
	await Effect.runPromise(
		home.service.execute(
			master.id,
			"memory-update",
			{
				...action,
				content: "Use the updated test command.",
				sources: [nextSource],
				expectedVersion: 1,
			},
			required(master.activeSessionId),
		),
	);
	const oldPage = JSON.parse(
		(
			await Effect.runPromise(
				home.service.artifact(master.id, "memory/testing.md", 1),
			)
		).content,
	);
	expect(oldPage.evidence[0].text).toBe("Repository tests require Bun.");
	const renewed = await Effect.runPromise(
		home.service.execute(master.id, "memory-renew", { _tag: "renew" }),
	);
	expect(renewed.memory?.topics[0]?.version).toBe(2);
	expect(renewed.conversations.at(-1)?.checkpoint).toContain("testing.md");
	const restored = await Effect.runPromise(
		home.service.execute(master.id, "restore-memory", {
			_tag: "restoreMemory",
			path: "testing.md",
			version: 1,
			expectedVersion: 2,
		}),
	);
	expect(restored.memory?.topics[0]?.author).toBe("user");
	await expect(
		Effect.runPromise(
			home.service.execute(
				master.id,
				"policy-rewrite",
				{ ...action, expectedVersion: 3 },
				required(renewed.activeSessionId),
			),
		),
	).rejects.toThrow("User-authored memory");
	const moved = await Effect.runPromise(
		home.service.execute(master.id, "memory-move", {
			_tag: "move",
			environmentId: "cloud",
		}),
	);
	expect(moved.homeEnvironmentId).toBe("cloud");
	const transferred = JSON.parse(
		(
			await Effect.runPromise(
				destination.service.artifact(master.id, "memory/testing.md", 3),
			)
		).content,
	);
	expect(transferred.content).toBe(oldPage.content);
	expect(transferred.evidence).toEqual(oldPage.evidence);
});

it("consolidates a bounded finding batch once and commits consumed sources with its pages", async () => {
	let calls = 0;
	const home = await cluster().createHome("local", (input) =>
		Effect.sync(() => {
			calls++;
			const data = JSON.parse(input.prompt);
			return JSON.stringify({
				edits: [
					{
						path: "testing.md",
						title: "Testing",
						summary: "Use Bun",
						content: "Use Bun for tests.",
						sources: [data.findings[0].source],
						expectedVersion: 0,
						archived: false,
					},
				],
				consumed: data.findings.map(
					(finding: { source: unknown }) => finding.source,
				),
			});
		}),
	);
	let master = await Effect.runPromise(
		home.service.create({
			commandId: "dream-create",
			settings,
			repositories: [],
		}),
	);
	master = await Effect.runPromise(
		home.service.execute(master.id, "dream-finding", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Use Bun for tests.",
			status: "open",
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "dream-config", {
			_tag: "memoryConfig",
			config: { providerId: "claude", model: "test", automatic: false },
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "dream-run", { _tag: "dream" }),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "dream-run", { _tag: "dream" }),
	);
	await expect
		.poll(
			async () =>
				(await Effect.runPromise(home.service.snapshot(master.id))).master
					.memory?.run?.state,
			{ timeout: 8000 },
		)
		.toBe("done");
	master = (await Effect.runPromise(home.service.snapshot(master.id))).master;
	expect(calls).toBe(1);
	expect(master.memory?.consumed).toEqual([
		memorySource(required(master.entries[0])),
	]);
	expect(master.memory?.topics).toHaveLength(1);
	expect(
		JSON.parse(
			(
				await Effect.runPromise(
					home.service.artifact(master.id, "memory/testing.md", 1),
				)
			).content,
		).evidence[0].id,
	).toBe("finding");
	await Effect.runPromise(
		home.service.execute(master.id, "dream-empty", { _tag: "dream" }),
	);
	await expect
		.poll(
			async () =>
				(await Effect.runPromise(home.service.snapshot(master.id))).master
					.memory?.run?.state,
			{ timeout: 8000 },
		)
		.toBe("done");
	expect(calls).toBe(1);
});

it("rejects a dream based on changed findings without consuming or publishing them", async () => {
	let finish: (text: string) => void = () => {};
	let inputData: { findings: Array<{ source: unknown }> } | null = null;
	const home = await cluster().createHome("local", (input) =>
		Effect.promise(() => {
			inputData = JSON.parse(input.prompt);
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		}),
	);
	const master = await Effect.runPromise(
		home.service.create({
			commandId: "race-create",
			settings,
			repositories: [],
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "race-finding", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Old finding",
			status: "open",
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "race-config", {
			_tag: "memoryConfig",
			config: { providerId: "claude", model: "test", automatic: false },
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "race-run", { _tag: "dream" }),
	);
	await expect.poll(() => inputData, { timeout: 8000 }).not.toBeNull();
	await Effect.runPromise(
		home.service.execute(master.id, "race-edit", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Changed finding",
			status: "open",
		}),
	);
	finish(
		JSON.stringify({
			edits: [],
			consumed: required<{ findings: Array<{ source: unknown }> }>(
				inputData,
			).findings.map((finding) => finding.source),
		}),
	);
	await expect
		.poll(
			async () =>
				(await Effect.runPromise(home.service.snapshot(master.id))).master
					.memory?.run?.state,
			{ timeout: 8000 },
		)
		.toBe("failed");
	const memory = (await Effect.runPromise(home.service.snapshot(master.id)))
		.master.memory;
	expect(memory?.consumed).toEqual([]);
	expect(memory?.topics).toEqual([]);
	expect(memory?.run?.error).toContain("changed during consolidation");
});

it("cancels a running dream promptly and closes its model without publishing", async () => {
	let started = false,
		closed = false;
	const home = await cluster().createHome("local", () =>
		Effect.sync(() => {
			started = true;
		}).pipe(
			Effect.andThen(Effect.never),
			Effect.ensuring(
				Effect.sync(() => {
					closed = true;
				}),
			),
		),
	);
	const master = await Effect.runPromise(
		home.service.create({
			commandId: "cancel-create",
			settings,
			repositories: [],
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "cancel-finding", {
			_tag: "entry",
			id: "finding",
			kind: "note",
			text: "Reusable learning",
			status: "open",
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "cancel-config", {
			_tag: "memoryConfig",
			config: { providerId: "claude", model: "test", automatic: false },
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "cancel-run", { _tag: "dream" }),
	);
	await expect.poll(() => started, { timeout: 8000 }).toBe(true);
	await Effect.runPromise(
		home.service.execute(master.id, "cancel-now", { _tag: "cancelDream" }),
	);
	await expect.poll(() => closed, { timeout: 3000 }).toBe(true);
	const memory = (await Effect.runPromise(home.service.snapshot(master.id)))
		.master.memory;
	expect(memory?.run?.state).toBe("cancelled");
	expect(memory?.consumed).toEqual([]);
	expect(memory?.topics).toEqual([]);
});

it("recovers an interrupted memory job without replaying its automatic batch", async () => {
	const home = await cluster().createHome("local");
	const master = await Effect.runPromise(
		home.service.create({
			commandId: "recover-memory",
			settings,
			repositories: [],
		}),
	);
	await Effect.runPromise(
		home.service.execute(master.id, "recover-finding", {
			_tag: "entry",
			id: "pending-finding",
			kind: "note",
			text: "Use focused behavior tests.",
			status: "open",
		}),
	);
	const snapshot = (await Effect.runPromise(home.service.snapshot(master.id)))
		.master;
	const batchKey = `memory-auto:${master.id}:${createHash("sha256")
		.update(
			JSON.stringify(
				snapshot.entries
					.filter((entry) => entry.kind === "note")
					.map(memorySource),
			),
		)
		.digest("hex")}`;
	const store = await home.runtime.runPromise(MasterStore);
	await Effect.runPromise(
		store.change(master.id, (value) => ({
			...value,
			memory: {
				revision: 0,
				topics: [],
				consumed: [],
				config: { providerId: "claude", model: "test", automatic: true },
				run: {
					id: "interrupted-job",
					batchKey,
					state: "running",
					error: null,
					updatedAt: Date.now(),
				},
			},
		})),
	);
	let calls = 0;
	const consolidate = makeMemoryConsolidation({
		store,
		dreamer: Option.some({
			generate: () =>
				Effect.sync(() => {
					calls++;
					return "{}";
				}),
		}),
		mutationLock: Semaphore.makeUnsafe(1),
		environmentId: "local",
		directory: () => home.directory,
		ownsGeneration: () => Effect.succeed(true),
		coordinatorBusy: () => Effect.succeed(false),
	});
	await Effect.runPromise(consolidate);
	const recovered = (await Effect.runPromise(home.service.snapshot(master.id)))
		.master.memory;
	expect(recovered?.run?.state).toBe("failed");
	expect(recovered?.run?.error).toContain("interrupted");
	expect(recovered?.consumed).toEqual([]);
	await Effect.runPromise(consolidate);
	expect(calls).toBe(0);
	expect(
		(await Effect.runPromise(home.service.snapshot(master.id))).master.memory
			?.run?.state,
	).toBe("failed");
});
it("repairs a Z whose coordinator conversation and private workspace were lost", async () => {
	const home = await cluster().createHome("local");
	const master = await Effect.runPromise(
		home.service.create({ commandId: "create", settings, repositories: [] }),
	);
	const lost = required(master.activeSessionId);
	home.sessions.delete(lost);
	for (const [id, chat] of home.chats)
		if (chat.activeSessionId === lost) home.chats.delete(id);
	home.folders.delete(master.workspaceId);
	expect(
		(await Effect.runPromise(home.service.snapshot(master.id))).coordinator,
	).toBeNull();
	const renewed = await Effect.runPromise(
		home.service.execute(master.id, "repair", { _tag: "renew" }),
	);
	expect(renewed.activeSessionId).not.toBe(lost);
	expect(home.folders.has(master.workspaceId)).toBe(true);
	expect(
		(await Effect.runPromise(home.service.snapshot(master.id))).coordinator?.id,
	).toBe(renewed.activeSessionId);
});
it("changes a Z's repositories without starting a new conversation", async () => {
	const home = await cluster().createHome("local");
	const master = await Effect.runPromise(
		home.service.create({ commandId: "create", settings, repositories: [] }),
	);
	const repositories = [
		{ environmentId: "local", folderId: "repo", name: "Repo" },
	] as const;
	const updated = await Effect.runPromise(
		home.service.execute(master.id, "bind", {
			_tag: "repositories",
			repositories,
		}),
	);
	expect(updated.repositories).toEqual(repositories);
	expect(updated.activeSessionId).toBe(master.activeSessionId);
	expect(updated.conversations).toHaveLength(master.conversations.length);
	await expect(
		Effect.runPromise(
			home.service.execute(
				master.id,
				"coordinator-bind",
				{ _tag: "repositories", repositories: [] },
				required(master.activeSessionId),
			),
		),
	).rejects.toThrow("controlled by the user");
});

it("preserves the active coordinator model on fresh chat but honors explicit configuration", async () => {
	const home = await cluster().createHome("local");
	let master = await Effect.runPromise(
		home.service.create({
			commandId: "model-create",
			settings,
			repositories: [],
		}),
	);
	const sessionId = SessionId.make(required(master.activeSessionId));
	home.sessions.set(
		sessionId,
		Session.make({
			...required(home.sessions.get(sessionId)),
			providerId: "gemini",
			model: "gemini-2.5-pro",
		}),
	);
	master = await Effect.runPromise(
		home.service.execute(master.id, "model-fresh", { _tag: "renew" }),
	);
	expect(master.settings).toMatchObject({
		providerId: "gemini",
		model: "gemini-2.5-pro",
	});
	expect(
		home.sessions.get(SessionId.make(required(master.activeSessionId))),
	).toMatchObject({ providerId: "gemini", model: "gemini-2.5-pro" });
	const count = master.conversations.length;
	master = await Effect.runPromise(
		home.service.execute(master.id, "model-fresh", { _tag: "renew" }),
	);
	expect(master.conversations).toHaveLength(count);
	master = await Effect.runPromise(
		home.service.execute(master.id, "model-configure", {
			_tag: "configure",
			expectedRevision: master.revision,
			settings: {
				...master.settings,
				providerId: "codex",
				model: "explicit-model",
			},
			repositories: [],
		}),
	);
	expect(master.settings).toMatchObject({
		providerId: "codex",
		model: "explicit-model",
	});
	expect(
		home.sessions.get(SessionId.make(required(master.activeSessionId))),
	).toMatchObject({ providerId: "codex", model: "explicit-model" });
});

it("gates remote coordination at the server while local delegation remains available", async () => {
	const home = await cluster().createHome("local", undefined, false);
	await expect(
		Effect.runPromise(
			home.service.create({
				commandId: "gated-remote",
				settings,
				repositories: [
					{ environmentId: "cloud", folderId: "repo", name: "Repo" },
				],
			}),
		),
	).rejects.toThrow("Cross-environment");
	let master = await Effect.runPromise(
		home.service.create({
			commandId: "gated-local",
			settings,
			repositories: [
				{ environmentId: "local", folderId: "repo", name: "Repo" },
			],
		}),
	);
	expect(master.accountManaged).toBe(false);
	expect(
		(await Effect.runPromise(home.service.snapshot(master.id))).capabilities,
	).toEqual({
		crossEnvironment: false,
		homeTransfer: false,
		generatedScreens: false,
	});
	await expect(
		Effect.runPromise(
			home.service.execute(master.id, "gated-binding", {
				_tag: "repositories",
				repositories: [
					{ environmentId: "cloud", folderId: "repo", name: "Repo" },
				],
			}),
		),
	).rejects.toThrow("Cross-environment");
	await expect(
		Effect.runPromise(
			home.service.execute(master.id, "gated-home", {
				_tag: "move",
				environmentId: "cloud",
			}),
		),
	).rejects.toThrow("Cross-environment");
	await expect(
		Effect.runPromise(
			home.service.target({
				commandId: "gated-incoming",
				masterId: master.id,
				homeEnvironmentId: "cloud",
				generation: 1,
				folderId: "repo",
				action: { _tag: "catalog" },
			}),
		),
	).rejects.toThrow("Cross-environment");
	master = await Effect.runPromise(
		home.service.execute(master.id, "gated-delegate", {
			_tag: "delegate",
			environmentId: "local",
			folderId: "repo",
			providerId: "codex",
			model: "test",
			title: "Local task",
			task: "Implement in an isolated worktree",
		}),
	);
	expect(master.workers).toHaveLength(1);
});

it("does not let a worker report bypass the source deployment gate", async () => {
	const group = cluster();
	const source = await group.createHome("local", undefined, false);
	const destination = await group.createHome("cloud");
	const owner = await Effect.runPromise(
		destination.service.create({
			commandId: "report-owner",
			settings,
			repositories: [],
		}),
	);
	const worker = await Effect.runPromise(
		source.fakeChat.createChat({
			projectId: source.repository.id,
			providerId: "codex",
			model: "test",
		}),
	);
	const sessionId = required(worker.initialSession).id;
	await source.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO master_worker_origins VALUES (${sessionId},${owner.id},'cloud','repo')`;
		}),
	);
	const router = await source.runtime.runPromise(MasterToolRouter);
	const result = await router.call(
		sessionId,
		JSON.stringify({
			_tag: "report",
			id: "blocked-report",
			text: "Do not deliver remotely",
		}),
		false,
		"report-attempt",
	);
	expect(result).toMatchObject({ ok: false });
	expect(JSON.stringify(result)).toContain("Cross-environment");
	expect(
		(await Effect.runPromise(destination.service.snapshot(owner.id))).master
			.entries,
	).toHaveLength(0);
});

it("retains existing remote references during local configuration without enabling remote dispatch", async () => {
	const home = await cluster().createHome("local", undefined, false);
	let master = await Effect.runPromise(
		home.service.create({
			commandId: "legacy-remote-create",
			settings,
			repositories: [],
		}),
	);
	const store = await home.runtime.runPromise(MasterStore);
	const remote = {
		environmentId: "legacy-cloud",
		folderId: "legacy-repo",
		name: "Legacy",
	};
	master = await Effect.runPromise(
		store.change(master.id, (value) => ({
			...value,
			repositories: [remote, { ...remote, folderId: "second" }],
		})),
	);
	master = await Effect.runPromise(
		home.service.execute(master.id, "remove-one-legacy", {
			_tag: "repositories",
			repositories: [
				remote,
				{ environmentId: "local", folderId: "repo", name: "Local" },
			],
		}),
	);
	expect(master.repositories).toContainEqual(remote);
	expect(master.repositories).toHaveLength(2);
	await expect(
		Effect.runPromise(
			home.service.execute(master.id, "legacy-dispatch", {
				_tag: "delegate",
				environmentId: remote.environmentId,
				folderId: remote.folderId,
				task: "Must not run",
				title: "Blocked",
				providerId: "codex",
				model: "test",
			}),
		),
	).rejects.toThrow("Cross-environment");
	expect(master.workers).toHaveLength(0);
});
