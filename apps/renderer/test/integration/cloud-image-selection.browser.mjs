import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".cloud-setup-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15820,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "cloud-setup-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__cloud_setup", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__cloud_setup.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__cloud-setup-probe"></script>',
						),
					);
				});
			},

			resolveId(id, importer) {
				if (id === "\0cloud-setup-probe") return id;
				if (!importer?.includes("cloud-workspace-pool.tsx")) return;
				if (id.endsWith("use-auth.ts")) return "\0selection-auth";
				if (id.endsWith("cloud-workspace-session-cache.ts"))
					return "\0selection-cache";
				if (id.endsWith("control-plane-client.ts")) return "\0selection-client";
				if (id.endsWith("cloud-image-monitor.ts")) return "\0selection-monitor";
			},
			load(id) {
				if (id === "\0selection-auth")
					return `export const useAuth = () => ({isLoading:false,isSignedIn:true});`;
				if (id === "\0selection-monitor")
					return `export const subscribeCloudImages = () => () => {}; export const refreshCloudImages = async () => {};`;
				if (id === "\0selection-client")
					return `
                 export const subscribeControlPlaneSessionCache = () => () => {};
                 export const runCloudControl = fn => fn({'cloud.image.build': async request => {
                  window.buildRequests.push(request);
                  const image = window.images.find(i => i.providerId === request.providerId);
                  window.staleImages = structuredClone(window.images);
                  image.state = 'ready';
                  image.updatedAt = 100;
                  image.builds = [{buildId:'build',state:'ready',mode:request.mode,active:true,runtimeVersion:'v1',configurationDigest:'config',repositories:[],providers:[],createdAt:1,updatedAt:2,logText:'Build completed successfully'}];
                  return image;
                 }});
                `;
				if (id === "\0selection-cache")
					return `
                 window.buildRequests = [];
                 window.available = ['box','e2b','boxd'];
                 window.images = window.available.map(providerId => ({providerId,state:providerId === 'e2b' ? 'failed' : 'not-built',repositories:[],providers:[{providerId:'codex',state:'connected'}],builds:[],updatedAt:1}));
                 export const loadCloudProviders = async () => ({providers:window.available.map(providerId => ({providerId,displayName:providerId}))});
                 export const invalidateCloudProjects = () => { window.cachedProjects = undefined; };
                 export const loadCloudProjects = async () => ({projects:[{projectId:'project',updatedAt:1}]});
                 export const loadCloudWorkspaces = async () => ({workspaces:[]});
                 export const loadCloudProviderImages = async () => ({images:(window.returnStaleImages && window.staleImages ? window.staleImages : window.images).filter(i => !window.unavailableStatus?.includes(i.providerId)),complete:!window.unavailableStatus?.length});
                 export const peekCloudGithub = () => ({installations:[{suspended:false}],repositories:[]});
                 export const loadCloudGithub = async () => peekCloudGithub();
                 export const loadCloudEntitlements = async () => ({});
                 export const hasCloudEntitlement = () => true;
                 export const loadCloudBillingSummary = async () => ({overageCapMicros:25000000});
                 export const loadCloudBillingUsage = async () => ({items:[]});
                `;
				if (id === "\0cloud-setup-probe")
					return `
                 import React from 'react';
                 import {createRoot} from 'react-dom/client';
                 import {CloudWorkspacePool} from '/src/components/settings/cloud-workspace-pool.tsx';
                 import '/src/styles.css';
                 const onProgress = progress => {window.progress = progress;};
                 document.documentElement.classList.add('dark');
                 createRoot(document.getElementById('root')).render(React.createElement('div', {style:{maxWidth:720,margin:'80px auto'}}, React.createElement(CloudWorkspacePool, {onboarding:{step:'image',onProgress}})));
                `;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_PATH,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__cloud_setup`,
	);
	await page.getByRole("radio", { name: /boxd/ }).waitFor({ timeout: 30000 });
	assert.equal(await page.getByRole("radio").first().inputValue(), "boxd");
	assert.equal(
		await page.getByRole("radio", { name: /boxd/ }).isChecked(),
		true,
	);
	await page.getByRole("button", { name: "Build image", exact: true }).click();
	await page.waitForFunction(() => window.progress?.image === true);
	assert.deepEqual(
		await page.evaluate(() => window.buildRequests.map((r) => r.providerId)),
		["boxd"],
	);
	await page
		.getByRole("button", { name: "boxd build logs", exact: true })
		.click();
	await page.getByText("Build completed successfully").waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });

	await page.evaluate(() => {
		window.unavailableStatus = ["e2b"];
		window.dispatchEvent(new Event("focus"));
	});
	await page
		.getByRole("button", { name: "E2B build logs", exact: true })
		.getByText("Checking")
		.waitFor();
	assert.equal(await page.evaluate(() => window.progress.image), true);
	assert.equal(
		await page
			.getByRole("button", { name: "Rebuild image", exact: true })
			.isEnabled(),
		true,
	);
	await page.evaluate(() => {
		window.unavailableStatus = [];
		window.dispatchEvent(new Event("focus"));
	});
	await page
		.getByRole("button", { name: "E2B build logs", exact: true })
		.getByText("Build failed")
		.waitFor();
	await page.getByRole("radio", { name: "E2B", exact: true }).check();
	await page.waitForFunction(() => window.progress?.image === false);
	await page.evaluate(() => {
		window.returnStaleImages = true;
	});
	await page.getByRole("button", { name: "Retry build", exact: true }).click();
	await page.waitForFunction(() => window.progress?.image === true);
	await page
		.getByRole("button", { name: "Rebuild image", exact: true })
		.waitFor();
	await page.evaluate(() => {
		window.returnStaleImages = false;
	});
	assert.deepEqual(
		await page.evaluate(() => window.buildRequests.map((r) => r.providerId)),
		["boxd", "e2b"],
	);

	await page.evaluate(() => {
		window.available = ["box", "boxd"];
	});
	await page
		.getByRole("button", { name: "Rebuild image", exact: true })
		.click();
	await page.getByRole("alert").waitFor();
	assert.deepEqual(
		await page.evaluate(() => window.buildRequests.map((r) => r.providerId)),
		["boxd", "e2b"],
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: selection scopes builds and readiness, logs open, unrelated failures do not block setup, removed providers cannot trigger a fallback build",
	);
	if (process.env.CLOUD_IMAGE_PREVIEW === "1") {
		console.log(
			`Preview: http://127.0.0.1:${server.httpServer.address().port}/__cloud_setup`,
		);
		await new Promise((resolve) => process.once("SIGINT", resolve));
	}
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
