import { Effect } from "effect";
import { expect, it } from "vitest";
import { initializeSystemRepository } from "../../src/conversation-fixture.ts";
import { withSystemTest } from "../../src/system-scope.ts";

it("restores Master ownership, history, observations and command receipts after a server restart", async () => {
	await withSystemTest("zuse-master-restart-", async (scope) => {
		const repository = scope.path("repository");
		initializeSystemRepository(repository);
		const server = await scope.server();
		expect(
			(
				await fetch(`http://127.0.0.1:${server.port}/master-peer`, {
					method: "POST",
					body: "{}",
				})
			).status,
		).toBe(403);
		const rpc = await scope.rpc(server.endpoint);
		const client = rpc.client;
		const folder = await Effect.runPromise(
			client["workspace.add"]({ path: repository }),
		);
		let master = await Effect.runPromise(
			client["masters.create"]({
				commandId: "create",
				settings: {
					name: "Engineering",
					providerId: "gemini",
					model: "gemini-2.5-pro",
					instructions: "Ask before merging",
					skills: [],
					modelGuidance: "",
					maxConcurrent: 4,
					maxFollowUps: 3,
				},
				repositories: [],
			}),
		);
		expect(
			(await Effect.runPromise(client["masters.get"]({ masterId: master.id })))
				.capabilities,
		).toEqual({
			crossEnvironment: false,
			homeTransfer: false,
			generatedScreens: false,
		});
		master = await Effect.runPromise(
			client["masters.execute"]({
				masterId: master.id,
				commandId: "configure",
				action: {
					_tag: "configure",
					expectedRevision: master.revision,
					settings: master.settings,
					repositories: [
						{
							environmentId: master.homeEnvironmentId,
							folderId: folder.id,
							name: folder.name,
						},
					],
				},
			}),
		);
		const firstSession = master.activeSessionId;
		const decision = {
			masterId: master.id,
			commandId: "decision",
			action: {
				_tag: "entry" as const,
				id: "decision",
				kind: "decision" as const,
				text: "Choose rollout date",
				status: "open" as const,
			},
		};
		const before = await Effect.runPromise(client["masters.execute"](decision));
		master = await Effect.runPromise(
			client["masters.execute"]({
				masterId: master.id,
				commandId: "renew",
				action: { _tag: "renew" },
			}),
		);
		await Effect.runPromise(
			client["masters.execute"]({
				masterId: master.id,
				commandId: "artifact",
				action: {
					_tag: "publish",
					id: "plan",
					title: "Plan",
					kind: "markdown",
					content: "A durable plan",
					expectedVersion: 0,
					pinned: true,
				},
			}),
		);
		await rpc.dispose();
		await server.stop("SIGKILL");
		const restarted = await scope.server();
		const restored = await scope.rpc(restarted.endpoint);
		const snapshot = await Effect.runPromise(
			restored.client["masters.get"]({ masterId: master.id }),
		);
		expect(snapshot.master.activeSessionId).toBe(master.activeSessionId);
		expect(snapshot.master.activeSessionId).not.toBe(firstSession);
		expect(snapshot.master.conversations).toHaveLength(3);
		expect(snapshot.master.entries[0]?.text).toBe("Choose rollout date");
		expect(snapshot.chats).toHaveLength(0);
		expect(
			(await Effect.runPromise(restored.client["workspace.list"]({}))).map(
				(item) => item.id,
			),
		).toEqual([folder.id]);
		expect(
			(await Effect.runPromise(restored.client["masters.execute"](decision)))
				.revision,
		).toBe(before.revision);
		expect(
			(
				await Effect.runPromise(
					restored.client["masters.artifact"]({
						masterId: master.id,
						artifactId: "plan",
						version: 1,
					}),
				)
			).content,
		).toBe("A durable plan");
	});
}, 60_000);
