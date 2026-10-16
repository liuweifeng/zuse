import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { chromium } from "@playwright/test";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import {
	githubAuthorizationCallback,
	githubAuthorizationUrl,
	makeGithubInstallUrl,
} from "../../src/cloud-github-app.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { ApiStoreMemory } from "../../src/store.ts";

const keys = generateKeyPairSync("ed25519");
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = String(input);
	if (url === "https://github.com/login/oauth/access_token")
		return Response.json({ access_token: "test-only-token" });
	if (url === "https://api.github.com/user") return Response.json({ id: 7 });
	const installation = {
		id: 123,
		app_id: 1,
		account: { id: 7, login: "test-owner", type: "User" },
		repository_selection: "selected",
		suspended_at: null,
	};
	if (url.startsWith("https://api.github.com/user/installations?"))
		return Response.json({ installations: [installation] });
	if (url === "https://api.github.com/app/installations/123")
		return Response.json(installation);
	throw new Error("Unexpected upstream request");
}) as typeof fetch;

const handle = async (request: Request): Promise<Response> => {
	if (new URL(request.url).pathname === "/start") {
		const install = await runtime.runPromise(
			makeGithubInstallUrl("test-owner"),
		);
		return Response.redirect(githubAuthorizationUrl(install, origin), 302);
	}
	if (new URL(request.url).pathname === "/test-oauth") {
		const url = new URL(request.url);
		const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
		callback.searchParams.set("state", url.searchParams.get("state") ?? "");
		callback.searchParams.set("code", "test-code");
		return Response.redirect(callback, 302);
	}
	const response = await runtime.runPromise(
		githubAuthorizationCallback(request).pipe(
			Effect.catch((error) =>
				Effect.succeed(new Response(error.code, { status: error.status })),
			),
		),
	);
	const location = response.headers.get("location");
	if (location?.startsWith("https://github.com/login/oauth/authorize?")) {
		response.headers.set(
			"location",
			`${origin}/test-oauth${new URL(location).search}`,
		);
	}
	return response;
};
const server = createServer(async (incoming, outgoing) => {
	try {
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers)) {
			if (value !== undefined)
				headers.set(key, Array.isArray(value) ? value.join(", ") : value);
		}
		const response = await handle(
			new Request(new URL(incoming.url ?? "/", origin), {
				method: incoming.method,
				headers,
				...(incoming.method === "POST" ? { body: await text(incoming) } : {}),
			}),
		);
		response.headers.forEach((value, key) => {
			outgoing.setHeader(key, value);
		});
		outgoing.writeHead(response.status);
		outgoing.end(await response.text());
	} catch {
		outgoing.writeHead(500).end("Test callback failed");
	}
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		ApiStoreMemory,
		configurationLayer({
			apiIssuer: origin,
			publicApiOrigin: origin,
			workosJwksUrl: "unused",
			workosIssuer: "unused",
			mintPrivateKey: Redacted.make(
				JSON.stringify(keys.privateKey.export({ format: "jwk" })),
			),
			mintPublicKey: JSON.stringify(keys.publicKey.export({ format: "jwk" })),
			githubApp: {
				appId: "1",
				slug: "test",
				clientId: "test-client",
				clientSecret: Redacted.make("test-secret"),
				privateKey: Redacted.make(
					appKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
				),
			},
		}),
	),
);
const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
	args: ["--no-sandbox"],
});
try {
	const page = await browser.newPage();
	await page.goto(`${origin}/start`);
	assert.match(
		await page.locator("body").innerText(),
		/Choose a GitHub account/,
	);
	await page
		.getByRole("button", { name: "Use this account: test-owner" })
		.waitFor();
	const posted = page.waitForRequest(
		(request) =>
			request.method() === "POST" && request.url().startsWith(origin),
	);
	await Promise.all([
		page.waitForNavigation(),
		page.getByRole("button", { name: "Use this account: test-owner" }).click(),
	]);
	const headers = await (await posted).allHeaders();
	assert.equal(
		headers.origin,
		origin,
		"The real form POST must preserve Origin for CSRF validation",
	);
	assert.equal(
		headers.referer,
		`${origin}/`,
		"Do not leak OAuth codes or signed state in Referer",
	);
	assert.match(
		await page.locator("body").innerText(),
		/test-owner is connected/,
	);
	const store = await runtime.runPromise(CloudWorkspaceStore);
	assert.equal(
		(await runtime.runPromise(store.listGithubInstallations("test-owner")))
			.length,
		1,
	);
	console.log(
		"PASS: real browser OAuth + connection form persists exactly one installation without leaking callback parameters",
	);
} finally {
	await browser.close();
	await runtime.dispose();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	globalThis.fetch = nativeFetch;
}
