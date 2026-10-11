import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	server: {
		host: "127.0.0.1",
		port: 15834,
		strictPort: true,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "plugins-ui-fixture",
			enforce: "pre",
			configureServer(s) {
				s.middlewares.use("/__plugins-settings", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await s.transformIndexHtml(
							"/__plugins-settings.html",
							'<html class="dark"><div id="root"></div><script type="module" src="/@id/__x00__plugins-settings-probe"></script></html>',
						),
					);
				});
				s.middlewares.use("/__plugins-popover", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await s.transformIndexHtml(
							"/__plugins-popover.html",
							'<html class="dark"><div id="root"></div><script type="module" src="/@id/__x00__plugins-popover-probe"></script></html>',
						),
					);
				});
				s.middlewares.use("/__plugins", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await s.transformIndexHtml(
							"/__plugins.html",
							'<html class="dark"><div id="root"></div><script type="module" src="/@id/__x00__plugins-probe"></script></html>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (
					id === "\0plugins-probe" ||
					id === "\0plugins-settings-probe" ||
					id === "\0plugins-popover-probe"
				)
					return id;
				if (importer?.includes("skills-settings-list.tsx")) {
					if (id.endsWith("environment-shell-client-bus.ts"))
						return "\0plugins-skills";
				}
				if (
					importer?.includes("plugins-page.tsx") ||
					importer?.includes("plugin-detail.tsx") ||
					importer?.includes("plugin-return-handler.tsx") ||
					importer?.includes("connected-plugins.ts") ||
					importer?.includes("plugins-settings-pane.tsx") ||
					importer?.includes("plugins-navigation.ts") ||
					importer?.includes("use-plugin-connection-toggle.ts") ||
					importer?.includes("add-mcp-server-dialog.tsx") ||
					importer?.includes("plugins-popover.tsx")
				) {
					if (id.endsWith("plugins-client.ts")) return "\0plugins-fixture";
					if (id.endsWith("use-auth.ts")) return "\0plugins-auth";
					if (id.endsWith("platform-capabilities.ts"))
						return "\0plugins-external";
					if (id.endsWith("store/ui.ts")) return "\0plugins-ui";
				}
			},
			load(id) {
				if (id === "\0plugins-skills")
					return `
const skill=(name,providerId,enabled,toggleSupported)=>({name,providerId,enabled,toggleSupported,scope:"global",description:"Example skill "+name,arguments:[],filePath:"/skills/"+name+"/SKILL.md"});
let skills=[skill("pdf","claude",true,true),skill("deploy","codex",false,true),skill("notes","cursor",true,false)];
export async function dispatchEnvironmentShellCommand(command){
 if(command.kind==="skill.listGlobal")return {result:skills};
 if(command.kind==="skill.setEnabled"){window.lastSkillToggle=command.payload;skills=skills.map(s=>s.name===command.payload.name?{...s,enabled:command.payload.enabled}:s);return {result:{providerId:command.payload.providerId,name:command.payload.name,enabled:command.payload.enabled}};}
 throw new Error("unexpected "+command.kind);
}
`;
				if (id === "\0plugins-settings-probe")
					return `import React from 'react';import{createRoot}from'react-dom/client';import{PluginsSettingsPane}from'/src/components/settings/plugins-settings-pane.tsx';import{ToastProvider}from'/src/components/ui/toast.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement('main',{className:'min-h-screen bg-background text-foreground',style:{padding:'36px'}},React.createElement('div',{style:{maxWidth:760,margin:'0 auto'}},React.createElement(PluginsSettingsPane)))));`;
				if (id === "\0plugins-popover-probe")
					return `import React from 'react';import{createRoot}from'react-dom/client';import{PluginsPopover}from'/src/components/plugins/plugins-popover.tsx';import{ToastProvider}from'/src/components/ui/toast.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement('main',{className:'flex min-h-screen items-end bg-background p-10 text-foreground'},React.createElement('div',{className:'flex h-9 w-[560px] items-center gap-2 rounded-xl bg-muted/40 px-3'},React.createElement(PluginsPopover)))));`;
				if (id === "\0plugins-auth")
					return 'export const useAuth=()=>({user:{id:"fixture",email:"user@example.test"},isSignedIn:true});';
				if (id === "\0plugins-ui")
					return "const state={setView(){},setActiveMainTab(){}};export const useUiStore={getState:()=>state};";
				if (id === "\0plugins-external")
					return "export const openExternal=async url=>{window.openedPluginUrl=url;};export const rendererPlatformCapabilities=()=>({desktop:true});export const copyText=async text=>{window.copiedText=text;};";
				if (id === "\0plugins-fixture")
					return `
const entry=(id,name,description,domain,featured=false,category=null)=>({id,name,description,domain,category,featured,custom:false,url:null,apiKeyHeader:null});
const server=(tenantId,id,name,url,apiKeyHeader=null)=>({tenantId,id,name,description:'',domain:'',category:null,featured:false,custom:true,url,apiKeyHeader});
const catalog=[
 entry('linear','Linear','Find and update issues, projects, and documents.','linear.app',true,'productivity'),
 entry('notion','Notion','Search, create, and reorganize workspace content.','notion.com',true,'productivity'),
 entry('sentry','Sentry','Issues, events, releases, and root-cause runs.','sentry.io',true,'observability'),
 entry('cloudflare','Cloudflare Docs','Search Cloudflare documentation from your agents.','cloudflare.com',true),
 ...Array.from({length:60},(_,i)=>entry('tool-'+i,'Tool '+i,'An example MCP server number '+i+'.','example'+i+'.test')),
];
const seeded=location.pathname.startsWith('/__plugins-settings')||location.pathname.startsWith('/__plugins-popover');
let servers=seeded?[server('personal:fixture','custom-acme','Acme Tools','https://mcp.acme.dev/mcp','X-API-Key')]:[];
let connections=seeded?[{id:'c-linear',pluginId:'linear',label:'Linear',owner:'user',state:'connected',createdAt:1,enabled:true},{id:'c-personal',pluginId:'linear',label:'Personal',owner:'user',state:'connected',createdAt:1,enabled:true},{id:'c-acme',pluginId:'custom-acme',label:'Acme Tools',owner:'user',state:'connected',createdAt:1,enabled:false}]:[];
import {useCallback,useEffect,useState} from 'react';
const listeners=new Set();
window.setPluginReadOnly=()=>{window.pluginAdmin=false;notifyPluginsChanged();};
const snapshot=(tenantId='personal:fixture')=>({kind:'snapshot',canManage:window.pluginAdmin!==false,tenantId,tenants:[{id:tenantId,kind:tenantId.startsWith('organization:')?'organization':'personal',name:tenantId.startsWith('organization:')?'Acme Inc':'Personal'}],catalog:[...servers.filter(s=>s.tenantId===tenantId),...catalog],connections:connections.filter(c=>(c.tenantId??'personal:fixture')===tenantId),endpoint:''});
export const notifyPluginsChanged=()=>{for(const l of listeners)l();};
const claimed=new Set();export const claimPluginFailure=id=>{if(claimed.has(id))return false;claimed.add(id);return true;};
export function usePluginSnapshot(account,tenantId){
 const [value,setValue]=useState(null);
 const refresh=useCallback(async()=>{setValue(snapshot(tenantId));for(const l of listeners)if(l!==refresh)l();},[tenantId]);
 useEffect(()=>{if(account===null)return;setValue(snapshot(tenantId));const l=()=>setValue(snapshot(tenantId));listeners.add(l);return()=>listeners.delete(l);},[account,tenantId]);
 return {snapshot:account===null?null:value,failed:false,refresh};
}
export const pluginReturnTo=async()=>({kind:'desktop',port:8976});
export async function pluginRequest(input){
 const attempt=(id,state,extra={})=>({kind:'attempt',id,connectionId:id,state,authorizationUrl:null,expiresAt:Date.now()+60000,error:null,pluginId:'',...extra});
 if(input.action==='addServer'){
  window.lastAddServer=input;
  const tenantId=input.tenantId;
  const fail=error=>attempt(input.requestId,'failed',{error});
  if(input.url.includes('needs-key')&&!input.apiKey)return fail('plugin_auth_unsupported');
  if(input.apiKey&&input.apiKey.value.endsWith(' bad'))return fail('plugin_credentials_rejected');
  const pluginId='custom-'+input.requestId.slice(0,8);
  servers.unshift(server(tenantId,pluginId,input.name,input.url,input.apiKey?.header??null));
  if(input.url.includes('oauth')){connections.push({id:input.requestId,tenantId,pluginId,label:input.name,owner:'user',state:'connecting',createdAt:Date.now(),enabled:true});return attempt(input.requestId,'pending',{pluginId,authorizationUrl:'https://oauth.example/authorize'});}
  connections.push({id:input.requestId,tenantId,pluginId,label:input.name,owner:'user',state:'connected',createdAt:Date.now(),enabled:true});
  return attempt(input.requestId,'connected',{pluginId});
 }
 if(input.action==='removeServer'){window.lastRemoveServer=input;servers=servers.filter(s=>s.id!==input.pluginId);connections=connections.filter(c=>c.pluginId!==input.pluginId);return {kind:'ok'};}
 if(input.action==='setEnabled'){window.lastPluginToggle=input;connections=connections.map(c=>c.id===input.connectionId?{...c,enabled:input.enabled}:c);return {kind:'ok'};}
 if(input.action==='complete'){connections.push({id:'c-linear',pluginId:'linear',label:'Linear',owner:'user',state:'connected',createdAt:Date.now(),enabled:true});return {kind:'attempt',id:'a',connectionId:'c-linear',state:'connected',authorizationUrl:null,expiresAt:Date.now()};}
 if(input.action==='list')return snapshot(input.tenantId);
 if(input.action==='disconnect'){connections=connections.filter(c=>c.id!==input.connectionId);return {kind:'ok'};}
 if(input.action==='poll')return {kind:'attempt',id:input.attemptId,connectionId:input.attemptId,state:'pending',authorizationUrl:'https://mcp.notion.com/authorize',expiresAt:Date.now()+60000};
 if(input.action==='cancel'){connections=connections.filter(c=>c.id!==input.attemptId);return {kind:'attempt',id:input.attemptId,connectionId:input.attemptId,state:'cancelled',authorizationUrl:null,expiresAt:Date.now()};}
 if(input.action==='connect'){
  window.lastReturnTo=input.returnTo;window.lastPluginTenant=input.tenantId;window.lastConnect=input;
  const id=input.requestId;
  if(input.pluginId==='notion'){connections.push({id,pluginId:'notion',label:'Notion',owner:'user',state:'connecting',createdAt:Date.now()});return {kind:'attempt',id,connectionId:id,state:'pending',authorizationUrl:'https://mcp.notion.com/authorize',expiresAt:Date.now()+60000};}
  connections.push({id,tenantId:input.tenantId,pluginId:input.pluginId,label:input.label,owner:input.tenantId?.startsWith('organization:')?'organization':'user',state:'connected',createdAt:Date.now(),enabled:true});return {kind:'attempt',id,connectionId:id,state:'connected',authorizationUrl:null,expiresAt:Date.now()+60000};}
}
`;
				if (id === "\0plugins-probe")
					return `import React from 'react';import{createRoot}from'react-dom/client';import{observeRendererAccount}from'/src/lib/renderer-account.ts';import{selectRendererWorkspace}from'/src/lib/renderer-workspace.ts';observeRendererAccount('fixture');window.selectPluginWorkspace=selectRendererWorkspace;import{PluginsPage}from'/src/components/plugins/plugins-page.tsx';import{PluginReturnHandler}from'/src/components/plugin-return-handler.tsx';import{ToastProvider}from'/src/components/ui/toast.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement('main',{className:'flex h-screen flex-col bg-background text-foreground'},React.createElement(PluginReturnHandler),React.createElement(PluginsPage))));`;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {}),
	});
	const page = await browser.newPage({
		viewport: { width: 1180, height: 820 },
		deviceScaleFactor: 2,
	});
	const shots = process.env.PLUGINS_SCREENSHOT_DIR;
	const shot = async (name) => {
		if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
	};
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// A browser return redeems itself: no confirmation dialog.
	await page.goto(
		"http://127.0.0.1:15834/__plugins?plugin_ticket=fixture&plugin_tenant=personal%3Afixture&plugin=Linear",
	);
	await page.getByText("Linear connected", { exact: true }).waitFor();
	assert(!page.url().includes("plugin_ticket"));
	await page
		.getByRole("button", { name: "Manage Linear", exact: true })
		.first()
		.waitFor();
	await page.getByRole("heading", { name: "Featured" }).waitFor();
	await page.getByRole("heading", { name: "All plugins" }).waitFor();
	await shot("plugins-browse");
	await page.getByRole("button", { name: "Show more", exact: true }).click();
	assert.equal(
		await page.getByRole("button", { name: "Show more", exact: true }).count(),
		0,
	);

	// No-auth plugins connect in place.
	await page
		.getByRole("textbox", { name: "Search plugins" })
		.fill("Cloudflare");
	await page.getByRole("heading", { name: "Results" }).waitFor();
	await page
		.getByRole("button", { name: "Connect Cloudflare Docs", exact: true })
		.click();
	await page
		.getByText("Cloudflare Docs connected", { exact: true })
		.first()
		.waitFor();
	await page
		.getByRole("button", { name: "Manage Cloudflare Docs", exact: true })
		.click();
	await page.getByRole("heading", { name: "Information" }).waitFor();
	await shot("plugins-detail-connected");
	// No names to type: another account gets the next free default.
	await expect(
		page.getByRole("textbox", { name: "Connection name" }),
	).toHaveCount(0);
	const accountActions = page.getByRole("button", { name: /^Actions for / });
	await expect(accountActions).toHaveCount(1);
	await page
		.getByRole("button", { name: "Connect another account", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Actions for Cloudflare Docs 2", exact: true })
		.waitFor();
	await shot("plugins-multiple-accounts");
	// Each account has its own actions; disconnecting one leaves the other.
	await page
		.getByRole("button", { name: "Actions for Cloudflare Docs 2", exact: true })
		.click();
	await page.waitForTimeout(250); // let the menu finish opening
	await shot("plugins-account-menu");
	await page.getByRole("menuitem", { name: "Disconnect" }).click();
	await expect(
		page.getByRole("button", {
			name: "Actions for Cloudflare Docs 2",
			exact: true,
		}),
	).toHaveCount(0);
	await expect(accountActions).toHaveCount(1);
	await page
		.getByRole("button", { name: "Actions for Cloudflare Docs", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Disconnect" }).click();
	// With no accounts, the header offers one Connect; the account takes the plugin's name.
	await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
	await shot("plugins-connect-first");
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await page.waitForFunction(
		() => window.lastConnect?.label === "Cloudflare Docs",
	);
	await page
		.getByRole("button", { name: "Actions for Cloudflare Docs", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Disconnect" }).click();
	await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
	await page.getByRole("button", { name: "Plugins", exact: true }).click();
	await page.getByRole("textbox", { name: "Search plugins" }).fill("");

	// OAuth plugins hand off to the browser and show one clear pending state.
	await page
		.getByRole("button", { name: "Connect Notion", exact: true })
		.first()
		.click();
	await page
		.getByText("Finish signing in to Notion in your browser.", {
			exact: false,
		})
		.waitFor();
	assert.equal(
		await page.evaluate(() => window.openedPluginUrl),
		"https://mcp.notion.com/authorize",
	);
	assert.deepEqual(await page.evaluate(() => window.lastReturnTo), {
		kind: "desktop",
		port: 8976,
	});
	await shot("plugins-pending");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page
		.getByRole("button", { name: "Connect Notion", exact: true })
		.first()
		.waitFor();

	// Custom MCP servers: one shared dialog, specific errors, detail and removal.
	const dialog = page.getByRole("dialog", { name: "Add MCP server" });
	const openAddServer = async () => {
		await page
			.getByRole("button", { name: "Add MCP server", exact: true })
			.first()
			.click();
		await dialog.getByText("Adding to your personal workspace.").waitFor();
	};
	await openAddServer();
	await dialog.getByRole("button", { name: "Add server" }).click();
	await dialog.getByText("Enter a name for this server.").waitFor();
	await dialog.getByRole("textbox", { name: "Name" }).fill("Docs Search");
	await dialog
		.getByRole("textbox", { name: "Server URL" })
		.fill("http://mcp.docs.example.com/mcp");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await dialog.getByText("Enter the server's full https:// URL.").waitFor();
	await dialog
		.getByRole("textbox", { name: "Server URL" })
		.fill("https://mcp.docs.example.com/mcp");
	await shot("plugins-add-server");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await page.getByText("Docs Search added", { exact: true }).waitFor();
	await expect(dialog).toHaveCount(0);
	assert.equal(
		await page.evaluate(() => window.lastAddServer.apiKey),
		undefined,
	);
	await page
		.getByRole("heading", { name: "Docs Search Custom", exact: true })
		.waitFor();
	await page.getByText("https://mcp.docs.example.com/mcp").waitFor();
	await page
		.locator("dd")
		.getByText("Sign in or none", { exact: true })
		.waitFor();
	await shot("plugins-custom-detail");
	await page.getByRole("button", { name: "Plugins", exact: true }).click();
	await page.getByRole("heading", { name: "Custom servers" }).waitFor();

	// A server that needs a key explains how to fix it; nothing is kept.
	await openAddServer();
	await dialog.getByRole("textbox", { name: "Name" }).fill("Acme");
	await dialog
		.getByRole("textbox", { name: "Server URL" })
		.fill("https://needs-key.acme.dev/mcp");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await dialog
		.getByText(
			"This server didn't offer sign-in. If it needs an API key, choose Bearer token or Custom header.",
		)
		.waitFor();
	await shot("plugins-add-server-error");
	await dialog.getByRole("tab", { name: "Bearer token" }).click();
	await dialog.getByLabel("Token").fill("bad");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await dialog
		.getByText("The server rejected this key. Check it and try again.")
		.waitFor();
	await dialog.getByLabel("Token").fill("good");
	await shot("plugins-add-server-key");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await page.getByText("Acme added", { exact: true }).waitFor();
	assert.deepEqual(await page.evaluate(() => window.lastAddServer.apiKey), {
		header: "Authorization",
		value: "Bearer good",
	});
	await page.locator("dd").getByText("Bearer token", { exact: true }).waitFor();
	// Another account on a key-authenticated server asks for its own key inline.
	await page
		.getByRole("button", { name: "Connect another account", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Connect", exact: true }),
	).toBeDisabled();
	await page.getByLabel("API key").fill("k2");
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await page.waitForFunction(
		() => window.lastConnect?.label === "Acme 2",
		undefined,
		{ polling: 100 },
	);
	assert.equal(
		await page.evaluate(() => window.lastConnect.apiKey),
		"Bearer k2",
	);
	// On/off lives in each account's menu.
	await page
		.getByRole("button", { name: "Actions for Acme", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Turn off for agents" }).click();
	await page.waitForFunction(() => window.lastPluginToggle?.enabled === false);
	await page.getByText("Off · agents can't use this account").waitFor();
	await shot("plugins-custom-detail-redesign");
	await page.getByRole("button", { name: "Copy server URL" }).click();
	await page.waitForFunction(
		() => window.copiedText === "https://needs-key.acme.dev/mcp",
	);
	await page.getByRole("button", { name: "More actions", exact: true }).click();
	await page.waitForTimeout(250); // let the menu finish opening
	await shot("plugins-detail-menu");
	await page.getByRole("menuitem", { name: "Remove server" }).click();
	await page.getByRole("alertdialog").getByText("Remove Acme?").waitFor();
	await shot("plugins-remove-server");
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove server" })
		.click();
	await page.getByText("Acme removed", { exact: true }).waitFor();
	await page.getByRole("heading", { name: "Custom servers" }).waitFor();
	await expect(
		page.getByRole("button", { name: "Connect Acme", exact: true }),
	).toHaveCount(0);

	// Servers that use sign-in reuse the pending browser flow.
	await openAddServer();
	await dialog.getByRole("textbox", { name: "Name" }).fill("Wiki");
	await dialog
		.getByRole("textbox", { name: "Server URL" })
		.fill("https://oauth.wiki.example/mcp");
	await dialog.getByRole("button", { name: "Add server" }).click();
	await page
		.getByText("Finish signing in to Wiki in your browser.", { exact: false })
		.waitFor();
	assert.equal(
		await page.evaluate(() => window.openedPluginUrl),
		"https://oauth.example/authorize",
	);
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByText("Finish signing in to Wiki in your browser.", {
			exact: false,
		}),
	).toHaveCount(0);

	await page.getByRole("tab", { name: "Connected" }).click();
	await page
		.getByRole("button", { name: "Manage Linear", exact: true })
		.waitFor();
	await shot("plugins-connected");
	// Workspace switching isolates Personal connections and scopes new connections.
	await page.evaluate(() =>
		window.selectPluginWorkspace({
			kind: "organization",
			organizationId: "team",
		}),
	);
	await expect(
		page.getByRole("button", { name: "Manage Linear", exact: true }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Connected" }).click();
	await page
		.getByRole("button", { name: "Browse plugins", exact: true })
		.waitFor();
	await shot("plugins-connected-empty");
	await page
		.getByRole("button", { name: "Add MCP server", exact: true })
		.first()
		.click();
	await page
		.getByRole("dialog", { name: "Add MCP server" })
		.getByText("Adding to the Acme Inc organization.", { exact: false })
		.waitFor();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("dialog", { name: "Add MCP server" }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Browse" }).click();
	await page
		.getByRole("button", { name: "Connect Cloudflare Docs", exact: true })
		.first()
		.click();
	await page
		.getByText("Cloudflare Docs connected", { exact: true })
		.first()
		.waitFor();
	assert.equal(
		await page.evaluate(() => window.lastPluginTenant),
		"organization:team",
	);
	await shot("plugins-organization");
	await page.evaluate(() => window.selectPluginWorkspace({ kind: "personal" }));
	await page
		.getByRole("button", { name: "Manage Linear", exact: true })
		.first()
		.waitFor();
	await expect(
		page.getByRole("button", { name: "Manage Cloudflare Docs", exact: true }),
	).toHaveCount(0);
	await page.evaluate(() =>
		window.selectPluginWorkspace({
			kind: "organization",
			organizationId: "team",
		}),
	);
	await page
		.getByRole("button", { name: "Manage Cloudflare Docs", exact: true })
		.first()
		.waitFor();
	await expect(
		page.getByRole("button", { name: "Manage Linear", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Manage Cloudflare Docs", exact: true })
		.first()
		.click();
	await page.evaluate(() => window.setPluginReadOnly());
	// Members see accounts and the switch state, without management controls.
	await page
		.getByText("Only organization admins can change plugins in this workspace.")
		.waitFor();
	await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("button", { name: "Connect another account", exact: true }),
	).toHaveCount(0);
	await shot("plugins-member-detail");
	await page.getByRole("button", { name: "Plugins", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Add MCP server", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Add MCP server", exact: true })
		.locator("..")
		.hover();
	await page.getByText("Only organization admins can add servers.").waitFor();
	await shot("plugins-member-read-only");
	// Settings → Plugins: manage what agents can use.
	const settings = await browser.newPage({
		viewport: { width: 1000, height: 760 },
		deviceScaleFactor: 2,
	});
	settings.on("pageerror", (error) => errors.push(error.message));
	await settings.goto("http://127.0.0.1:15834/__plugins-settings");
	await settings.getByRole("switch", { name: "Linear", exact: true }).waitFor();
	await settings
		.getByRole("switch", { name: "Linear / Personal", exact: true })
		.waitFor();
	await settings.waitForTimeout(400);
	if (shots)
		await settings.screenshot({ path: `${shots}/settings-plugins.png` });
	await settings.getByRole("switch", { name: "Linear", exact: true }).click();
	await settings.waitForFunction(
		() => window.lastPluginToggle?.enabled === false,
	);
	assert.equal(
		await settings
			.getByRole("switch", { name: "Linear", exact: true })
			.getAttribute("aria-checked"),
		"false",
	);
	assert.equal(
		await settings
			.getByRole("switch", { name: "Linear / Personal", exact: true })
			.getAttribute("aria-checked"),
		"true",
	);
	// Native MCP inventory is gone: custom servers are plugins.
	await expect(settings.getByRole("tab")).toHaveCount(2);
	await settings
		.getByRole("switch", { name: "Acme Tools", exact: true })
		.waitFor();
	await settings.getByText("Custom", { exact: true }).waitFor();
	await settings.getByRole("button", { name: "Add", exact: true }).click();
	await settings
		.getByRole("menuitem", { name: "Browse plugins", exact: true })
		.waitFor();
	if (shots)
		await settings.screenshot({ path: `${shots}/settings-add-menu.png` });
	await settings
		.getByRole("menuitem", { name: "Add MCP server", exact: true })
		.click();
	await settings.getByRole("dialog", { name: "Add MCP server" }).waitFor();
	await settings.keyboard.press("Escape");
	await expect(
		settings.getByRole("dialog", { name: "Add MCP server" }),
	).toHaveCount(0);
	await settings.getByRole("tab", { name: /Skills/ }).click();
	await settings.getByRole("switch", { name: "deploy" }).waitFor();
	await settings.getByText("Always on", { exact: true }).waitFor();
	await settings.getByRole("switch", { name: "deploy" }).click();
	await settings.waitForFunction(
		() => window.lastSkillToggle?.enabled === true,
	);
	if (shots)
		await settings.screenshot({ path: `${shots}/settings-skills.png` });

	// Composer: the workspace's plugins with quick switches.
	const composer = await browser.newPage({
		viewport: { width: 760, height: 560 },
		deviceScaleFactor: 2,
	});
	composer.on("pageerror", (error) => errors.push(error.message));
	await composer.goto("http://127.0.0.1:15834/__plugins-popover");
	await composer.getByRole("button", { name: "Plugins", exact: true }).click();
	await composer
		.getByRole("switch", { name: "Acme Tools", exact: true })
		.waitFor();
	assert.equal(
		await composer
			.getByRole("switch", { name: "Acme Tools", exact: true })
			.getAttribute("aria-checked"),
		"false",
	);
	await composer.getByText("2 of 3 on", { exact: true }).waitFor();
	await composer
		.getByRole("switch", { name: "Acme Tools", exact: true })
		.click();
	await composer.waitForFunction(
		() =>
			window.lastPluginToggle?.connectionId === "c-acme" &&
			window.lastPluginToggle.enabled === true,
	);
	await composer.getByText("3 of 3 on", { exact: true }).waitFor();
	if (shots)
		await composer.screenshot({
			path: `${shots}/composer-plugins-popover.png`,
		});
	await composer
		.getByRole("button", { name: "Add MCP server", exact: true })
		.click();
	await composer.getByRole("dialog", { name: "Add MCP server" }).waitFor();
	await composer.keyboard.press("Escape");
	await composer.evaluate(() => window.setPluginReadOnly());
	await composer.getByRole("button", { name: "Plugins", exact: true }).click();
	await expect(
		composer.getByRole("switch", { name: "Acme Tools", exact: true }),
	).toBeDisabled();
	await composer
		.getByText("Only organization admins can change plugins in this workspace.")
		.waitFor();
	await expect(
		composer.getByRole("button", { name: "Add MCP server", exact: true }),
	).toBeDisabled();
	assert.deepEqual(errors, []);
	console.log(
		"PASS: automatic return, browse, show more, connect, details, disconnect, OAuth pending, custom MCP servers (add, errors, keys, sign-in, remove), connected tab, organization isolation, read-only member controls, settings toggles, and composer plugins",
	);
} finally {
	await browser?.close();
	await server.close();
}
