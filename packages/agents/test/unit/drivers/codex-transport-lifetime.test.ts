import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../../src/drivers/codex-app-server-client.ts";

it("rejects pending requests and retires a provider that closes stdout but stays alive", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-codex-eof-"));
	const executable = join(directory, "provider.mjs");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: String(process.pid) } }) + "\\n");
 else { process.stdout.end(JSON.stringify({ method: "thread/closed", params: { threadId: "final-fragment" } })); setInterval(() => {}, 1000); }
});
`,
		{ mode: 0o755 },
	);
	let client: CodexAppServerClient | undefined;
	const terminations: Error[] = [];
	const notifications: string[] = [];
	try {
		client = await CodexAppServerClient.start({
			codexPath: executable,
			startupTimeoutMs: 1000,
			onNotification: (notification) => notifications.push(notification.method),
			onServerRequest: () => {},
			onUnexpectedTermination: (error) => terminations.push(error),
		});
		const pending = client.request("model/list", {}).then(
			() => "resolved",
			(error) => error,
		);
		await expect.poll(() => terminations.length, { timeout: 1000 }).toBe(1);
		expect(await pending).toBeInstanceOf(Error);
		expect(notifications).toEqual(["thread/closed"]);
		const pid = Number(client.initializeResponse.userAgent);
		await expect
			.poll(
				() => {
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				},
				{ timeout: 1000 },
			)
			.toBe(true);
		expect(terminations).toHaveLength(1);
		await expect(client.request("model/list", {})).rejects.toThrow("closed");
	} finally {
		await client?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("bounds the complete startup handshake when authentication never replies", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-codex-login-hang-"));
	const executable = join(directory, "provider.mjs");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
});
`,
		{ mode: 0o755 },
	);
	const abort = new AbortController();
	let settled = false;
	const startup = CodexAppServerClient.start({
		codexPath: executable,
		apiKey: "test-key",
		startupTimeoutMs: 100,
		startupSignal: abort.signal,
		onNotification: () => {},
		onServerRequest: () => {},
	}).then(
		(client) => {
			settled = true;
			return client.close();
		},
		(error) => {
			settled = true;
			return error;
		},
	);
	try {
		await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
		expect(await startup).toMatchObject({
			message: "Codex app-server startup timed out",
		});
	} finally {
		abort.abort();
		await startup;
		rmSync(directory, { recursive: true, force: true });
	}
});

it("cancels startup while an external credential lookup is still pending", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-codex-auth-cancel-"));
	const executable = join(directory, "provider.mjs");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
});
`,
		{ mode: 0o755 },
	);
	const abort = new AbortController();
	let entered = false;
	let release!: () => void;
	const tokens = new Promise<void>((resolve) => {
		release = resolve;
	});
	let settled = false;
	const startup = CodexAppServerClient.start({
		codexPath: executable,
		startupSignal: abort.signal,
		onNotification: () => {},
		onServerRequest: () => {},
		externalAuthProvider: {
			getTokens: async () => {
				entered = true;
				await tokens;
				return {
					accessToken: "test",
					chatgptAccountId: "test",
					chatgptPlanType: null,
					expiresAt: 0,
				};
			},
		},
	}).then(
		(client) => client.close(),
		(error) => {
			settled = true;
			return error;
		},
	);
	try {
		await expect.poll(() => entered).toBe(true);
		abort.abort(new Error("startup cancelled"));
		await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
		expect(await startup).toMatchObject({ message: "startup cancelled" });
	} finally {
		release();
		abort.abort();
		await startup;
		rmSync(directory, { recursive: true, force: true });
	}
});
