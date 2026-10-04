import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { signalDevApp, spawnDevApp } from "./dev-app-process.mjs";

// Model Electron's ordinary helper and its independently detached engine.
// The engine remains Electron's direct child despite having its own group.
const fixture = `
const { spawn } = require('node:child_process');
const { once } = require('node:events');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
(async () => {
  const children = await Promise.all([false, true].map(async detached => {
    const child = spawn(process.execPath, ['-e', \`
      const server = require('node:net').createServer(s => s.end());
      server.listen(0, '127.0.0.1', () => process.send({port: server.address().port}));
      process.on('disconnect', () => {});
    \`], { detached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const [ready] = await once(child, 'message');
    return { pid: child.pid, ...ready };
  }));
  process.send(children);
  setInterval(() => {}, 1000);
})();
`;

function reachable(port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (connected) => {
			socket.destroy();
			resolve(connected);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(500, () => finish(false));
	});
}

for (const signal of ["SIGTERM", "SIGKILL"]) {
	test(`dev ${signal} cleans up shell helpers and preserves detached engine`, {
		skip: process.platform === "win32",
		timeout: 5_000,
	}, async () => {
		const app = spawnDevApp(process.execPath, ["-e", fixture], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		let children = [];
		try {
			[children] = await once(app, "message");
			const [helper, engine] = children;
			assert.equal(await reachable(helper.port), true);
			assert.equal(await reachable(engine.port), true);
			const exited = once(app, "exit");
			signalDevApp(app, signal);
			await exited;
			for (let i = 0; i < 50 && (await reachable(helper.port)); i++) {
				await delay(10);
			}
			assert.equal(
				await reachable(helper.port),
				false,
				"shell helper must stop",
			);
			assert.equal(
				await reachable(engine.port),
				true,
				"engine must survive shell restart",
			);
		} finally {
			for (const child of [app, ...children]) {
				try {
					process.kill(child.pid, "SIGKILL");
				} catch {}
			}
		}
	});
}
