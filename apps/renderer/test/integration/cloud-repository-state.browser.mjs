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
				if (id.endsWith("platform-capabilities.ts"))
					return "\0selection-platform";
			},
			load(id) {
				if (id === "\0selection-platform")
					return `export const openExternal = async url => { window.openedGithubUrl = typeof url === 'function' ? await url() : url; };`;
				if (id === "\0selection-auth")
					return `export const useAuth = () => ({isLoading:false,isSignedIn:true});`;
				if (id === "\0selection-monitor")
					return `export const subscribeCloudImages = () => () => {}; export const refreshCloudImages = async () => {};`;
				if (id === "\0selection-client")
					return `
                 export const subscribeControlPlaneSessionCache = listener => { window.cacheListener = listener; return () => {}; };
                 export const runCloudControl = fn => fn({'cloud.github.install': async () => ({url:'https://api-staging.zuse.sh/v1/cloud/github/callback?state=test'}), 'cloud.projects.connect': async () => {
                  await new Promise(resolve => { window.finishConnect = resolve; });
                  window.projects = [window.project];
                  return window.project;
                 }});
                `;
				if (id === "\0selection-cache")
					return `
                 window.project = {projectId:'project',repositoryIdentity:'github.com/acme/app',repositoryUrl:'https://github.com/acme/app',displayName:'acme/app',defaultBranch:'main',visibility:'private',state:'connected',activeBuilds:{},latestBuilds:{},createdAt:1,updatedAt:1};
                 window.projects = [];
                 window.cachedProjects = window.projects;
                 export const loadCloudProviders = async () => ({providers:[{providerId:'boxd',displayName:'boxd'}]});
                 export const invalidateCloudProjects = () => { window.cachedProjects = undefined; };
                 export const loadCloudProjects = async (refresh = false) => {
                  if (!refresh && window.cachedProjects) return {projects:window.cachedProjects};
                  const projects = window.projects;
                  // Other cache entries can notify while the post-write read is pending.
                  if (refresh && projects.length > 0) {
                   queueMicrotask(() => window.cacheListener?.('cloud-workspace:providers'));
                   await new Promise(resolve => setTimeout(resolve, 30));
                  }
                  if (window.delayProjects) {
                   window.delayProjects = false;
                   await new Promise(resolve => { window.resolveOldProjects = resolve; });
                  }
                  window.cachedProjects = projects;
                  return {projects};
                 };
                 export const loadCloudWorkspaces = async () => ({workspaces:[]});
                 export const loadCloudProviderImages = async () => ({images:[{providerId:'boxd',state:'not-built',repositories:[],providers:[],builds:[],updatedAt:1}],complete:true});
                 export const peekCloudGithub = () => ({installations:[{installationId:1,accountLogin:'acme',accountType:'Organization',suspended:false}],repositories:[{nameWithOwner:'acme/app',httpsUrl:'https://github.com/acme/app',defaultBranch:'main',isPrivate:true}]});
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
                 createRoot(document.getElementById('root')).render(React.createElement('div', {style:{maxWidth:720,margin:'80px auto'}}, React.createElement(CloudWorkspacePool, {onboarding:{step:'github',onProgress}})));
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
	await page
		.getByRole("button", { name: "Repository", exact: true })
		.waitFor({ timeout: 30000 });
	const existing = page.getByRole("button", {
		name: "Connect existing account",
		exact: true,
	});
	await ((await existing.count())
		? existing
		: page.getByRole("button", { name: "Configure app", exact: true })
	).click();
	await page.waitForFunction(
		() =>
			window.openedGithubUrl !== undefined ||
			document.body.textContent.includes(
				"That cloud action could not be completed",
			),
	);
	assert.equal(
		await page.evaluate(() => window.openedGithubUrl),
		"https://api-staging.zuse.sh/v1/cloud/github/callback?state=test",
	);
	assert.equal(await existing.count(), 0);

	await page.evaluate(() => {
		window.delayProjects = true;
		window.dispatchEvent(new Event("focus"));
	});
	await page.waitForFunction(
		() => typeof window.resolveOldProjects === "function",
	);
	await page.getByRole("button", { name: "Repository", exact: true }).click();
	await page.getByRole("button", { name: /acme\/app/ }).click();
	await page.getByRole("button", { name: "Add 1", exact: true }).click();
	await page.waitForFunction(() => typeof window.finishConnect === "function");
	assert.equal(
		await page
			.getByRole("button", { name: "Repository", exact: true })
			.isDisabled(),
		true,
	);
	assert.equal(
		await page
			.getByRole("button", { name: "Repository", exact: true })
			.locator(".animate-spin")
			.count(),
		1,
	);
	await page.evaluate(() => window.finishConnect());
	await page.getByRole("button", { name: "Remove acme/app" }).waitFor();
	await page.waitForFunction(() => window.progress?.github === true);
	await page.evaluate(async () => {
		window.resolveOldProjects();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
	assert.equal(
		await page.getByRole("button", { name: "Remove acme/app" }).count(),
		1,
		"A stale refresh must not remove the newly connected repository",
	);
	assert.equal(
		await page.evaluate(() => window.progress.github),
		true,
		"A stale refresh must not reset GitHub setup progress",
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: adding a repository survives an older background refresh without resetting setup progress",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
