import { emptyPr } from "@zuse/git/github-pr-info";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => ({
	local: vi.fn(),
	account: vi.fn(),
	hosted: false,
}));
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: (run: (client: object) => Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(run({ "github.observe": transport.local })),
	runCloudControl: (run: (client: object) => Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(run({ "cloud.github.observe": transport.account })),
	peekControlPlaneCache: () => null,
	invalidateControlPlaneCache: vi.fn(),
	runCachedRead: (_key: string, read: () => Promise<unknown>) => read(),
}));
vi.mock("../../src/lib/hosted-session.ts", () => ({
	isHostedProduct: () => transport.hosted,
}));

import { rendererGitHubObserver } from "../../src/lib/github-observer.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";

const target = {
	host: "github.com",
	owner: "acme",
	repo: "cloud-checkout",
	branch: "feature",
};
const success = {
	pr: { ...emptyPr("feature"), state: "open" as const, number: 42 },
	details: null,
};
beforeEach(() => {
	transport.hosted = false;
	transport.local.mockReturnValue(Effect.succeed(success));
	transport.account.mockReturnValue(Effect.succeed(success));
	observeRendererAccount("alice");
	selectRendererWorkspace({ kind: "personal" });
});
afterEach(() => {
	rendererGitHubObserver.clear();
	vi.clearAllMocks();
});

test("desktop reads cloud checkout status on its own host without a runtime client", async () => {
	await rendererGitHubObserver.refresh(target);
	expect(transport.local).toHaveBeenCalledWith({ target, force: false });
	expect(transport.account).not.toHaveBeenCalled();
	expect(rendererGitHubObserver.snapshot(target).value?.pr.number).toBe(42);
});

test("missing desktop GitHub credentials can use the connected account", async () => {
	transport.local.mockReturnValue(
		Effect.succeed({ pr: emptyPr("feature", "authentication"), details: null }),
	);
	await rendererGitHubObserver.refresh(target);
	expect(transport.account).toHaveBeenCalledOnce();
	expect(rendererGitHubObserver.snapshot(target).value?.pr.number).toBe(42);
});

test.each([
	"hosted",
	"organization",
])("%s reads use account authentication and never local gh", async (mode) => {
	if (mode === "hosted") transport.hosted = true;
	else selectRendererWorkspace({ kind: "organization", organizationId: "org" });
	await rendererGitHubObserver.refresh(target);
	expect(transport.local).not.toHaveBeenCalled();
	expect(transport.account).toHaveBeenCalledOnce();
});
