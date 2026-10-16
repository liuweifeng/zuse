import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".message-origin-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15833,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "message-origin-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__origins", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__origins.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__origin-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0origin-probe") return id;
				if (!importer?.includes("message-row.tsx")) return;
				if (id.includes("environment-entity-hooks")) return "\0origin-entities";
				if (id.includes("store/environment-catalog"))
					return "\0origin-environment";
				if (id.includes("lib/session-navigation")) return "\0origin-navigation";
			},
			load(id) {
				if (id === "\0origin-entities")
					return `export const useEnvironmentEntities = environmentId => {
if(environmentId!=='remote')throw new Error('Wrong sender environment');
return {chatsByProject:{project:[{id:'chat',archivedAt:null}]},sessionsByProject:{project:[{id:'sender-one',chatId:'chat',title:'Review API boundaries',archivedAt:null},{id:'sender-two',chatId:'chat',title:'Check desktop navigation',archivedAt:null}]}};};`;
				if (id === "\0origin-environment")
					return `export const useEnvironmentCatalogStore = select => select({activeEnvironmentId:'local'});`;
				if (id === "\0origin-navigation")
					return `export const openSession = async ref => {window.opened.push(ref);return true;};`;
				if (id === "\0origin-probe")
					return `import '/src/styles.css';import React from 'react';import{createRoot}from'react-dom/client';import{UserBubble}from'/src/components/message-row.tsx';
window.opened=[];const root=createRoot(document.getElementById('root'));
const source=(sessionId,title)=>({chatId:'chat',sessionId,providerId:'claude',title});
window.renderOrigins=mode=>root.render(React.createElement('div',{style:{maxWidth:660,padding:24}},mode==='slack'?React.createElement(UserBubble,{text:'Request from Slack (thread 1.0):\\nWhy are webhook deliveries failing since this morning? It started right after the 9:40 deploy.',environmentId:'remote',source:{_tag:'slack',text:'Why are webhook deliveries failing since this morning? It started right after the 9:40 deploy.',author:'Aaron Mahlke',channel:'eng-alerts'}}):React.createElement(UserBubble,{text:'The delegated review is complete.',environmentId:'remote',...(mode==='single'?{origin:source('sender-one','Old title')}:{origins:[source('sender-one','Old title'),source('sender-two','Old second title'),source('unavailable','Archived security review')]})})));
window.renderOrigins('single');`;
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
		`http://127.0.0.1:${server.httpServer.address().port}/__origins`,
	);
	await page
		.getByRole("button", { name: "Sent by Review API boundaries", exact: true })
		.click();
	assert.deepEqual(await page.evaluate(() => window.opened), [
		{ environmentId: "remote", sessionId: "sender-one" },
	]);
	assert.equal(
		(await page.locator("body").innerText()).includes("from another chat"),
		false,
	);
	await page.evaluate(() => window.renderOrigins("multiple"));
	await page
		.getByRole("button", {
			name: "Sent by Check desktop navigation",
			exact: true,
		})
		.click();
	assert.deepEqual(await page.evaluate(() => window.opened.at(-1)), {
		environmentId: "remote",
		sessionId: "sender-two",
	});
	assert.equal(
		await page
			.getByRole("button", {
				name: "Sent by Archived security review",
				exact: true,
			})
			.isDisabled(),
		true,
	);
	await page.screenshot({
		path: resolve(root, "../../.context/message-origin.png"),
	});
	await page.evaluate(() => window.renderOrigins("slack"));
	const slackBubble = await page.locator("[data-chat-user-bubble]").innerText();
	assert.match(slackBubble, /Aaron Mahlke in #eng-alerts/);
	assert.equal(slackBubble.includes("Request from Slack"), false);
	await page.screenshot({
		path: resolve(root, "../../.context/message-source-slack.png"),
	});
	assert.deepEqual(errors, []);
	console.log("Sender attribution browser behavior passed.");
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
