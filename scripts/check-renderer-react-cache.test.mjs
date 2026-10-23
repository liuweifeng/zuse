import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, resolveConfig } from "vite-plus";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const requireSystem = createRequire(
	join(repoRoot, "tests/system/package.json"),
);
const { chromium } = requireSystem("playwright-core");
const chrome =
	process.env.CHROME_PATH ??
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: "/usr/bin/google-chrome");

test("React hooks survive cached navigation across optimizer generations", {
	skip: !existsSync(chrome),
	timeout: 30000,
}, async () => {
	// Keep the fixture under the checkout so Vite resolves the actual installed React.
	await mkdir(join(repoRoot, ".context"), { recursive: true });
	const root = await mkdtemp(join(repoRoot, ".context/react-cache-test-"));
	let server;
	let browser;
	try {
		await writeFile(
			join(root, "index.html"),
			'<div id="root"></div><script type="module" src="/main.js"></script>',
		);
		await writeFile(
			join(root, "main.js"),
			`import React from 'react';import {createRoot} from 'react-dom/client';function App(){const value=React.useSyncExternalStore(()=>()=>{},()=>"hooks work");return React.createElement('div',null,value)}createRoot(document.getElementById('root')).render(React.createElement(App));`,
		);
		const config = await resolveConfig(
			{
				configFile: resolve(repoRoot, "apps/renderer/vite.config.ts"),
				logLevel: "silent",
			},
			"serve",
		);
		server = await createServer({
			configFile: false,
			root,
			cacheDir: join(root, "cache"),
			logLevel: "silent",
			resolve: { dedupe: ["react", "react-dom"] },
			optimizeDeps: {
				entries: ["index.html"],
				include: ["react", "react-dom/client"],
			},
			server: { host: "127.0.0.1", port: 0, headers: config.server.headers },
		});
		await server.listen();
		const address = server.httpServer.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		browser = await chromium.launch({
			executablePath: chrome,
			args: ["--no-sandbox"],
		});
		const page = await browser.newPage();
		const failures = [];
		page.on("pageerror", (error) => failures.push(error.message));
		await page.goto(url);
		await page.waitForFunction(() =>
			document.body.textContent.includes("hooks work"),
		);
		// Reproduce the reported mixed URLs: React advances, ReactDOM's entry URL
		// remains stable. With immutable caching, the browser keeps its old React import.
		const environment = server.environments.client;
		environment.depsOptimizer.metadata.optimized.react.browserHash =
			"next-generation";
		environment.moduleGraph.invalidateAll();
		await page.goto(`${url}/?generation=next`);
		await page.waitForFunction(() =>
			document.body.textContent.includes("hooks work"),
		);
		assert.deepEqual(failures, []);
	} finally {
		await browser?.close();
		await server?.close();
		await rm(root, { recursive: true, force: true });
	}
});
