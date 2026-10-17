import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { layer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, test, vi } from "vitest";
import {
	checkNativeGitAccess,
	makeCloudGitExecution,
	prepareGitExecution,
} from "../../src/api/cloud-git-execution.ts";
import {
	MigrationsLive,
	MigrationsThrough0064Live,
} from "../../src/persistence/migrations.ts";
import { makeRuntimeGitExecution } from "../../src/provider/services/runtime-git-execution.ts";

const authHelperPath = fileURLToPath(
	new URL("../../../../infra/cloud-sandboxes/github-auth.sh", import.meta.url),
);
afterEach(() => vi.unstubAllGlobals());

test("concurrent member and Slack runs commit and authenticate with isolated identities", async () => {
	const directory = await mkdtemp(join(tmpdir(), "git-execution-"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			const context = JSON.parse(init.body);
			const name = context.slackMessageId ? "zuse[bot]" : context.actor.subject;
			return Response.json({
				token: `token-${name}`,
				expiresAtMs: Date.now() + 3_600_000,
				identity: { name, email: `${name}@example.test` },
			});
		}),
	);
	try {
		const contexts = [
			{ actor: { subject: "alice", membershipId: "a" } },
			{ actor: { subject: "bob", membershipId: "b" } },
			{ slackMessageId: "slack-1" },
		];
		const executions = await Promise.all(
			contexts.map((context, index) =>
				prepareGitExecution({
					directory,
					authHelperPath,
					key: String(index),
					context,
					credentialUrl: "https://api.test/token",
					credential: "runtime",
				}),
			),
		);
		for (const [index, execution] of executions.entries()) {
			const env = {
				...process.env,
				...execution.env,
				GIT_CONFIG_GLOBAL: join(directory, "empty.config"),
				GIT_CONFIG_NOSYSTEM: "1",
				ZUSE_GITHUB_TOKEN_FILE: "",
				ZUSE_USER_DATA: directory,
			};
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: directory,
					env,
					encoding: "utf8",
				}).trim();
			if (index === 0) git("init", "-q");
			git("commit", "--allow-empty", "-qm", "identity test");
			const name = ["alice", "bob", "zuse[bot]"][index];
			expect(git("log", "-1", "--format=%an|%cn")).toBe(`${name}|${name}`);
			const credential = execFileSync("git", ["credential", "fill"], {
				cwd: directory,
				env,
				encoding: "utf8",
				input: "protocol=https\nhost=github.com\n\n",
			});
			expect(credential).toContain(`password=token-${name}`);
			await writeFile(
				join(directory, "fake-gh"),
				'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n',
				{ mode: 0o700 },
			);
			expect(
				execFileSync(
					join(
						execution.env.ZUSE_GITHUB_CONTEXT_DIR ?? "missing-context",
						"gh",
					),
					["api", "user"],
					{
						env: { ...env, ZUSE_GH_BINARY: join(directory, "fake-gh") },
						encoding: "utf8",
					},
				),
			).toBe(`token-${name}`);
			expect(
				JSON.parse(
					await readFile(
						join(
							execution.env.ZUSE_GITHUB_CONTEXT_DIR ?? "missing-context",
							"request.json",
						),
						"utf8",
					),
				),
			).toEqual(contexts[index]);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("migrated cloud turns preserve actor ownership across restart without borrowing a later or settled actor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "git-actors-"));
	const sqlite = layer({ filename: join(directory, "db.sqlite") });
	const previous = ManagedRuntime.make(
		Layer.merge(sqlite, MigrationsThrough0064Live.pipe(Layer.provide(sqlite))),
	);
	let runtime: { dispose: () => Promise<void> } | undefined;
	const fetch = vi.fn(async (_url, init) => {
		const { actor, slackMessageId } = JSON.parse(init.body);
		const name = slackMessageId
			? "zuse[bot]"
			: (actor?.subject ?? "workspace-owner");
		return Response.json({
			token: name,
			expiresAtMs: Date.now() + 3_600_000,
			identity: { name, email: `${name}@example.test` },
		});
	});
	vi.stubGlobal("fetch", fetch);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('p','/tmp/p','P','2026-10-01','2026-10-01')`;
				yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('c','p','C','2026-10-01','2026-10-01')`;
				yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,current_turn_id,chat_id,created_at,updated_at) VALUES ('s','p','S','codex','gpt','running','turn-a','c','2026-10-01','2026-10-01')`;
				for (const [version, name] of [
					[1, "alice"],
					[2, "bob"],
				] as const) {
					const turnId = version === 1 ? "turn-a" : "turn-b";
					for (const [offset, type, payload] of [
						[0, "TurnStarted", { turnId, startedAt: version }],
						[
							1,
							"ProviderTurnRequested",
							{
								turnId,
								providerInputJson: JSON.stringify({
									actor: { subject: name, membershipId: name },
								}),
							},
						],
					] as const) {
						const sequence = version * 2 + offset;
						yield* sql`INSERT INTO events (event_id,stream_kind,stream_id,stream_version,type,occurred_at,actor,payload_json) VALUES (${`event-${sequence}`},'session','s',${sequence},${type},'2026-10-01',NULL,${JSON.stringify({ _tag: type, ...payload })})`;
					}
				}
			}),
		);
		await previous.dispose();
		const upgraded = ManagedRuntime.make(
			Layer.merge(sqlite, MigrationsLive.pipe(Layer.provide(sqlite))),
		);
		runtime = upgraded;
		const sql = await upgraded.runPromise(SqlClient.SqlClient);
		expect(
			(
				await upgraded.runPromise(
					sql<{ name: string }>`PRAGMA table_info(sessions)`,
				)
			).map((row) => row.name),
		).not.toContain("current_turn_id");
		const options = {
			sql,
			directory,
			authHelperPath,
			credentialUrl: "https://api.test/token",
			credential: () => "runtime",
			initialSessionId: "s",
		};
		const resolve = makeCloudGitExecution(options);
		const alice = await resolve("s");
		expect(alice?.env.GIT_AUTHOR_NAME).toBe("alice");
		expect((await resolve("s"))?.key).toBe(alice?.key);
		expect(fetch).toHaveBeenCalledTimes(1);
		await upgraded.runPromise(
			Effect.gen(function* () {
				yield* sql`UPDATE session_turns SET status='completed' WHERE id='turn-a'`;
				yield* sql`UPDATE session_turns SET status='starting' WHERE id='turn-b'`;
			}),
		);
		const bob = await resolve("s");
		expect(bob?.key).not.toBe(alice?.key);
		expect(bob?.env.GIT_AUTHOR_NAME).toBe("bob");
		expect(
			(await makeCloudGitExecution(options)("s"))?.env.GIT_AUTHOR_NAME,
		).toBe("bob");
		await upgraded.runPromise(
			sql`UPDATE session_turns SET status='completed' WHERE id='turn-b'`,
		);
		expect((await resolve("s"))?.context).toEqual({});
		expect((await resolve("s"))?.env.GIT_AUTHOR_NAME).toBe("workspace-owner");
		// A Slack-created conversation keeps the app identity when continued in
		// the UI, after the original turn settles, and after runtime restart.
		await upgraded.runPromise(
			sql`UPDATE session_turns SET status='running' WHERE id='turn-b'`,
		);
		const slackOptions = {
			...options,
			initialContext: { slackMessageId: "msg_launch_workspace" },
		};
		for (const extra of [
			{},
			{ nativeRepositoryPath: "/missing-native-repo" },
		]) {
			const execution = await makeCloudGitExecution({
				...slackOptions,
				...extra,
			})("s");
			expect(execution?.context).toEqual({
				actor: { subject: "bob", membershipId: "bob" },
				slackMessageId: "msg_launch_workspace",
			});
			expect(execution?.env.GIT_AUTHOR_NAME).toBe("zuse[bot]");
		}
		await upgraded.runPromise(
			sql`UPDATE session_turns SET status='completed' WHERE id='turn-b'`,
		);
		expect(
			(await makeCloudGitExecution(slackOptions)("s"))?.env.GIT_AUTHOR_NAME,
		).toBe("zuse[bot]");
		expect(
			(await makeCloudGitExecution(slackOptions)("another-session"))?.context,
		).toEqual({});
	} finally {
		await runtime?.dispose();
		await previous.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cloud startup waits for its resolver and fails closed after disposal", async () => {
	const service = makeRuntimeGitExecution(true);
	let resolved = false;
	const pending = service.resolve("session").then(() => {
		resolved = true;
	});
	await Promise.resolve();
	expect(resolved).toBe(false);
	const dispose = service.install(async () => undefined);
	await pending;
	expect(resolved).toBe(true);
	dispose();
	await expect(service.resolve("session")).rejects.toThrow(
		"Cloud GitHub execution is unavailable",
	);
	expect(
		await makeRuntimeGitExecution().resolve("local-session"),
	).toBeUndefined();
});

test("managed Git fallback rewrites SSH only in the agent process and preserves native config", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native git-"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				token: "test-token",
				expiresAtMs: Date.now() + 60000,
				identity: { name: "Alice", email: "alice@example.test" },
			}),
		),
	);
	try {
		execFileSync("git", ["init", "-q", directory]);
		execFileSync("git", [
			"-C",
			directory,
			"remote",
			"add",
			"origin",
			"git@github.com:acme/repo.git",
		]);
		execFileSync("git", [
			"-C",
			directory,
			"config",
			"credential.helper",
			"native-helper",
		]);
		const execution = await prepareGitExecution({
			directory,
			nativeRepositoryPath: directory,
			authHelperPath,
			key: "native-fallback",
			context: { actor: { subject: "alice", membershipId: "a" } },
			credentialUrl: "https://api.test/token",
			credential: "runtime",
		});
		const git = (args: string[], env = process.env) =>
			execFileSync("git", ["-C", directory, ...args], {
				env,
				encoding: "utf8",
			}).trim();
		expect(
			git(["remote", "get-url", "origin"], {
				...process.env,
				...execution.env,
			}),
		).toBe("https://github.com/acme/repo.git");
		expect(git(["remote", "get-url", "origin"])).toBe(
			"git@github.com:acme/repo.git",
		);
		expect(git(["config", "credential.helper"])).toBe("native-helper");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("native Git honors the repository SSH command and never silently borrows a managed identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native-access-"));
	const runtime = ManagedRuntime.make(
		layer({ filename: join(directory, "db.sqlite") }),
	);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	try {
		execFileSync("git", ["init", "-q", directory]);
		execFileSync("git", [
			"-C",
			directory,
			"remote",
			"add",
			"origin",
			"git@github.com:acme/repo.git",
		]);
		const ssh = join(directory, "native-ssh");
		await writeFile(
			ssh,
			"#!/bin/sh\necho 'Permission denied (publickey)' >&2\nexit 1\n",
			{ mode: 0o700 },
		);
		execFileSync("git", ["-C", directory, "config", "core.sshCommand", ssh]);
		const resolve = makeCloudGitExecution({
			nativeRepositoryPath: directory,
			sql: await runtime.runPromise(SqlClient.SqlClient),
			directory,
			authHelperPath,
			credentialUrl: "https://api.test/token",
			credential: () => "runtime",
			initialSessionId: "session",
		});
		await expect(resolve("session")).rejects.toThrow("Authentication required");
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		await runtime.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([
	"environment",
	"config",
])("native Git check suppresses %s askpass prompts", async (source) => {
	const directory = await mkdtemp(join(tmpdir(), "git-askpass-"));
	const server = createServer((_request, response) => {
		response.writeHead(401);
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test server port");
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", directory, ...args]);
		git("init", "-q");
		git("remote", "add", "origin", `http://127.0.0.1:${address.port}/repo`);
		git("config", "credential.helper", "");
		const helper = join(directory, "askpass");
		const marker = join(directory, "prompted");
		await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
			mode: 0o700,
		});
		if (source === "environment") vi.stubEnv("GIT_ASKPASS", helper);
		else {
			vi.stubEnv("GIT_ASKPASS", undefined);
			git("config", "core.askPass", helper);
		}
		expect(await checkNativeGitAccess(directory)).toBe(
			"authentication-required",
		);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		vi.unstubAllEnvs();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([
	["github_user_connection_required", "GitHub authentication required"],
	[
		"workspace_access_denied",
		"You do not have permission to edit this workspace",
	],
	[
		"github_execution_identity_invalid",
		"GitHub execution identity could not be verified",
	],
	["unknown", "GitHub access could not be verified"],
])("preserves the reason for GitHub credential refusal: %s", async (code, message) => {
	const directory = await mkdtemp(join(tmpdir(), "git-refusal-"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ error: code }, { status: 403 })),
	);
	try {
		await expect(
			prepareGitExecution({
				directory,
				authHelperPath,
				key: "test",
				context: {},
				credentialUrl: "https://api.test/token",
				credential: "runtime",
			}),
		).rejects.toThrow(message);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
