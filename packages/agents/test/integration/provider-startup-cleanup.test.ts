import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { startGeminiSession } from "@zuse/agents/drivers/gemini";
import { startGrokSession } from "@zuse/agents/drivers/grok";
import { startKiroSession } from "@zuse/agents/drivers/kiro";
import { startOpencodeSession } from "@zuse/agents/drivers/opencode";
import { startOpencode2Session } from "@zuse/agents/drivers/opencode2";
import { startPiSession } from "@zuse/agents/drivers/pi";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { __testing, mcpGatewayDiagnostics } from "@zuse/agents/mcp-gateway";
import type { AgentSessionId, FolderId } from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterAll, expect, it } from "vitest";

const attachments = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("unused"),
	saveText: () => Effect.die("unused"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

afterAll(() => __testing.closeServer());

it("revokes the MCP context when an ACP process crashes before handle disposal", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-mcp-crash-"));
	const executable = join(root, "kiro-cli");
	const fixture = new URL(
		"../../../../tests/testkit/fixtures/fake-acp-provider.mjs",
		import.meta.url,
	).href;
	await writeFile(
		executable,
		`#!/usr/bin/env node\nprocess.env.ZUSE_FAKE_ACP_SCENARIO = "crash";\nprocess.env.ZUSE_FAKE_ACP_STATE_DIR = ${JSON.stringify(join(root, "state"))};\nawait import(${JSON.stringify(fixture)});\n`,
	);
	await chmod(executable, 0o755);
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const baseline = mcpGatewayDiagnostics().activeSessionCount;
				const handle = yield* startKiroSession(
					{
						folderId: "cleanup-folder" as FolderId,
						providerId: "kiro",
						mode: "sdk",
						model: "claude-sonnet-4.5",
						permissionMode: "default",
					},
					root,
					executable,
					"cleanup-session" as AgentSessionId,
					async () => ({ _tag: "AllowOnce" }),
					() => "approval-required",
					async () => ({ id: "unused", ok: false, error: "unused" }),
					"node",
				);
				yield* Effect.gen(function* () {
					expect(mcpGatewayDiagnostics().activeSessionCount).toBe(baseline + 1);
					yield* handle.send("Crash now").pipe(Effect.catch(() => Effect.void));
					const events = yield* Stream.runCollect(handle.events);
					expect(
						Array.from(events).some((event) => event._tag === "Error"),
					).toBe(true);
					expect(mcpGatewayDiagnostics().activeSessionCount).toBe(baseline);
				}).pipe(Effect.ensuring(handle.close()));
			}).pipe(Effect.provide(attachments), Effect.timeout("10 seconds")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	"kiro",
	"grok",
	"gemini",
	"codex",
	"pi",
	"opencode",
	"opencode2",
] as const)("cancelling %s forcibly stops an unresponsive process and revokes its MCP context", async (providerId) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-startup-cancel-"));
	const executable = join(root, "provider-cli");
	const pidFile = join(root, "pid");
	// Report only after the driver sends its first handshake request. Never reply.
	await writeFile(
		executable,
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\n${providerId.startsWith("opencode") ? `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` : ""}\nprocess.stdin.on("data", () => writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));\n`,
	);
	await chmod(executable, 0o755);
	const baseline = mcpGatewayDiagnostics().activeSessionCount;
	const input = {
		folderId: "cleanup-folder" as FolderId,
		providerId,
		mode: "sdk" as const,
		permissionMode: "default" as const,
	};
	const sessionId = `cancel-${providerId}` as AgentSessionId;
	const requestPermission = async () => ({ _tag: "AllowOnce" as const });
	const runtimeMode = () => "approval-required" as const;
	const browserSend = async () => ({
		id: "unused",
		ok: false as const,
		error: "unused",
	});
	const resumeFile = join(root, "session.jsonl");
	await writeFile(resumeFile, JSON.stringify({ type: "session" }) + "\n");
	const start =
		providerId === "pi"
			? startPiSession(input, root, executable, sessionId, resumeFile)
			: providerId === "opencode" || providerId === "opencode2"
				? (providerId === "opencode"
						? startOpencodeSession
						: startOpencode2Session)(input, root, [], executable, sessionId)
				: providerId === "kiro"
					? startKiroSession(
							input,
							root,
							executable,
							sessionId,
							requestPermission,
							runtimeMode,
							browserSend,
							"node",
						)
					: (providerId === "grok"
							? startGrokSession
							: providerId === "gemini"
								? startGeminiSession
								: startCodexSession)(
							input,
							root,
							null,
							executable,
							sessionId,
							requestPermission,
							runtimeMode,
							browserSend,
							"node",
						);
	const fiber = Effect.runFork(start.pipe(Effect.provide(attachments)));
	let pid: number | undefined;
	try {
		await expect
			.poll(async () => {
				try {
					pid = Number(await readFile(pidFile, "utf8"));
					return pid > 0;
				} catch {
					return false;
				}
			})
			.toBe(true);
		expect(mcpGatewayDiagnostics().activeSessionCount).toBe(
			baseline + (["pi", "opencode", "opencode2"].includes(providerId) ? 0 : 1),
		);
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(mcpGatewayDiagnostics().activeSessionCount).toBe(baseline);
		await expect
			.poll(
				() => {
					if (pid === undefined) return false;
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				},
				{ timeout: 4_000 },
			)
			.toBe(true);
	} finally {
		await Effect.runPromise(Fiber.interrupt(fiber));
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	"opencode",
	"opencode2",
] as const)("cancelling %s after server readiness closes its pending HTTP startup", async (providerId) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-http-startup-cancel-"));
	const executable = join(root, "provider-cli");
	const pidFile = join(root, "pid");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((req, res) => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  // Keep both session creation and the event connection pending.
});
server.listen(0, "127.0.0.1", () => {
  console.log("listening on http://127.0.0.1:" + server.address().port);
  console.log("server password fixture-only");
});
`,
	);
	await chmod(executable, 0o755);
	const start = (
		providerId === "opencode" ? startOpencodeSession : startOpencode2Session
	)(
		{ folderId: "cleanup-folder" as FolderId, providerId, mode: "sdk" },
		root,
		[],
		executable,
		`http-cancel-${providerId}` as AgentSessionId,
	);
	const fiber = Effect.runFork(start.pipe(Effect.provide(attachments)));
	let pid: number | undefined;
	try {
		await expect
			.poll(async () => {
				try {
					pid = Number(await readFile(pidFile, "utf8"));
					return pid > 0;
				} catch {
					return false;
				}
			})
			.toBe(true);
		await Effect.runPromise(Fiber.interrupt(fiber));
		await expect
			.poll(() => {
				if (pid === undefined) return false;
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			})
			.toBe(true);
	} finally {
		await Effect.runPromise(Fiber.interrupt(fiber));
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});
