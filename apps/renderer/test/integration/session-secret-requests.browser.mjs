import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".secret-request-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15832,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "secret-request-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__secrets", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__secrets.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__secret-request-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0secret-request-probe") return id;
				if (
					importer?.includes("session-secret-requests.tsx") &&
					id.endsWith("rpc-client.ts")
				)
					return "\0secret-rpc";
			},
			load(id) {
				if (id === "\0secret-rpc")
					return `import {Effect,Redacted} from 'effect';
export const getVerifiedRpcClient=async()=>({
 'secrets.list':({sessionId})=>Effect.sync(()=>{window.listCalls++;if(window.unsupported)throw new Error('Unknown request tag: secrets.list');return window.requests.filter(r=>r.sessionId===sessionId)}),
 'secrets.respond':input=>Effect.suspend(()=>{window.responses.push({sessionId:input.sessionId,requestId:input.requestId,redacted:Redacted.isRedacted(input.value),value:input.value?Redacted.value(input.value):undefined});if(window.failSave)return Effect.fail(new Error('failed'));window.requests=window.requests.filter(r=>r.id!==input.requestId);return Effect.succeed({})})
});`;
				if (id === "\0secret-request-probe")
					return `import '/src/styles.css';import React from 'react';import{createRoot}from'react-dom/client';import{SessionSecretRequests}from'/src/components/session-secret-requests.tsx';
window.listCalls=0;window.responses=[];window.requests=[{id:'r1',sessionId:'one',label:'API token',reason:'Upload files',environmentVariable:'UPLOAD_TOKEN',status:'pending',reference:null,createdAt:1}];
const root=createRoot(document.getElementById('root'));window.renderSession=sessionId=>root.render(React.createElement(SessionSecretRequests,{sessionRef:{environmentId:'local',sessionId}}));window.renderSession('one');`;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_BIN,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__secrets`,
	);
	await page.getByLabel("API token").fill("private-fixture-token");
	await page.screenshot({
		path: resolve(root, "../../.context/secret-request.png"),
	});
	await page.evaluate(() => {
		window.failSave = true;
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByRole("alert").waitFor();
	assert.equal(
		await page.getByLabel("API token").inputValue(),
		"private-fixture-token",
	);
	assert.deepEqual(await page.evaluate(() => window.responses[0]), {
		sessionId: "one",
		requestId: "r1",
		redacted: true,
		value: "private-fixture-token",
	});
	await page.evaluate(() => {
		window.failSave = false;
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByLabel("API token").waitFor({ state: "detached" });
	assert.equal(
		(await page.locator("body").innerText()).includes("private-fixture-token"),
		false,
	);
	await page.evaluate(() => {
		window.requests = [
			{
				id: "r2",
				sessionId: "one",
				label: "Second token",
				reason: "",
				environmentVariable: "TOKEN",
				status: "pending",
				reference: null,
				createdAt: 2,
			},
		];
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.getByLabel("Second token").waitFor();
	await page.getByLabel("Second token").fill("old-session-value");
	await page.evaluate(() => window.renderSession("two"));
	await page.getByLabel("Second token").waitFor({ state: "detached" });
	const visibleCalls = await page.evaluate(() => window.listCalls);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForTimeout(100);
	assert.equal(await page.evaluate(() => window.listCalls), visibleCalls);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForTimeout(100);
	await page.evaluate(() => {
		window.unsupported = true;
		window.renderSession("three");
	});
	await page.waitForTimeout(100);
	const before = await page.evaluate(() => window.listCalls);
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
	await page.waitForTimeout(100);
	assert.equal(await page.evaluate(() => window.listCalls), before);
	assert.deepEqual(errors, []);
	console.log("Private request browser behavior passed.");
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
