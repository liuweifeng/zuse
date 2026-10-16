import { afterEach, expect, test, vi } from "vitest";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
	process.argv = originalArgv;
	process.exitCode = originalExitCode;
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:fs/promises");
});

test("publisher attempts both deletions and preserves the provisioning error", async () => {
	vi.resetModules();
	process.argv = ["node", "daytona-publish.mjs", "cleanup-test"];
	vi.stubEnv("DAYTONA_API_KEY", "test-key");
	vi.doMock("node:child_process", () => ({ spawnSync: () => ({ status: 0 }) }));
	vi.doMock("node:fs/promises", () => ({
		readFile: async () => JSON.stringify({ vcpuCount: 2, memoryMib: 4096 }),
	}));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const calls = [];
	vi.stubGlobal("fetch", async (url, init) => {
		const route = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
		calls.push(route);
		if (route === "GET /api/snapshots/zuse-base-cleanup-test")
			return new Response(null, { status: 404 });
		if (route === "POST /api/snapshots") return Response.json({ id: "seed" });
		if (route === "GET /api/snapshots/zuse-base-cleanup-test-seed")
			return Response.json({ state: "active" });
		if (route === "POST /api/sandbox") return Response.json({ id: "builder" });
		if (route === "GET /api/sandbox/builder")
			return Response.json({ state: "started" });
		if (route === "GET /api/sandbox/builder/toolbox-proxy-url")
			return new Response(null, { status: 502 });
		if (route === "DELETE /api/sandbox/builder")
			return new Response(null, { status: 503 });
		if (route === "DELETE /api/snapshots/seed")
			return new Response(null, { status: 204 });
		throw new Error(`Unexpected request: ${route}`);
	});
	await expect(
		import("../../../cloud-sandboxes/daytona-publish.mjs"),
	).rejects.toThrow("Daytona GET failed (502)");
	expect(calls).toContain("DELETE /api/snapshots/seed");
	expect(error).toHaveBeenCalledWith(
		"Daytona cleanup failed:",
		"Daytona DELETE failed (503)",
	);
	expect(process.exitCode).toBe(1);
});
