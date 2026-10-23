import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	account: { subject: "account-a", epoch: 1 },
	workspace: { key: "personal", epoch: 1 },
	state: null as unknown,
	effect: (() => {}) as () => undefined | (() => void),
	dismissed: false,
	read: vi.fn<() => Promise<boolean>>(),
	star: vi.fn<() => Promise<void>>(),
	dismiss: vi.fn(),
	toast: vi.fn(),
	openExternal: vi.fn(),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: () => [
		fixture.state,
		(value: unknown) => {
			fixture.state = value;
		},
	],
	useEffect: (effect: typeof fixture.effect) => {
		fixture.effect = effect;
	},
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
		snapshot(),
}));
vi.mock("@zuse/i18n/react", async () => {
	const { message } = await import("@zuse/i18n");
	return { useMessages: () => ({ message }) };
});
vi.mock("../../src/lib/renderer-account.ts", () => ({
	rendererAccountSnapshot: () => fixture.account,
	subscribeRendererAccount: vi.fn(),
}));
vi.mock("../../src/lib/renderer-workspace.ts", () => ({
	rendererWorkspaceSnapshot: () => fixture.workspace,
	subscribeRendererWorkspace: vi.fn(),
}));
vi.mock("../../src/hooks/use-organization-action.ts", () => ({
	useOrganizationAction: () => ({
		busy: false,
		run: (action: (current: () => boolean) => Promise<void>) =>
			action(() => true),
	}),
}));
vi.mock("../../src/lib/browser-device-preferences.ts", () => ({
	useBrowserDevicePreferences: (
		select: (value: { githubStarPromptDismissed: boolean }) => unknown,
	) => select({ githubStarPromptDismissed: fixture.dismissed }),
	updateBrowserDevicePreferences: fixture.dismiss,
}));
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: (
		action: (client: {
			"git.zuseStarStatus": typeof fixture.read;
			"git.starZuse": typeof fixture.star;
		}) => unknown,
	) =>
		action({
			"git.zuseStarStatus": fixture.read,
			"git.starZuse": fixture.star,
		}),
}));
vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	openExternal: fixture.openExternal,
}));
vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: fixture.toast },
}));

import { GithubStarPrompt } from "../../src/components/github-star-prompt.tsx";

const render = () => renderToStaticMarkup(<GithubStarPrompt />);
const check = async () => {
	render();
	fixture.effect();
	await fixture.read.mock.results[0]?.value.catch(() => {});
};
beforeEach(() => {
	fixture.account = { subject: "account-a", epoch: 1 };
	fixture.workspace = { key: "personal", epoch: 1 };
	fixture.state = null;
	fixture.dismissed = false;
	fixture.read.mockReset().mockResolvedValue(false);
	fixture.star.mockReset().mockResolvedValue();
	fixture.dismiss.mockClear();
	fixture.toast.mockClear();
	fixture.openExternal.mockClear();
});
it("hides the prompt before GitHub status is verified", () => {
	expect(render()).toBe("");
});
it("hides the prompt when the repository was already starred", async () => {
	fixture.read.mockResolvedValue(true);
	await check();
	expect(render()).toBe("");
});
it("shows the prompt when GitHub confirms the repository is not starred", async () => {
	await check();
	expect(render()).toContain("Star on GitHub");
});
it("keeps an unavailable GitHub status hidden", async () => {
	fixture.read.mockRejectedValue(new Error("offline"));
	await check();
	expect(render()).toBe("");
});
it("does not check or show a dismissed prompt", async () => {
	fixture.dismissed = true;
	await check();
	expect(fixture.read).not.toHaveBeenCalled();
	expect(render()).toBe("");
});
it.each([
	"account",
	"workspace",
] as const)("ignores stale status after the %s changes", async (boundary) => {
	await check();
	expect(render()).toContain("Star on GitHub");
	if (boundary === "account")
		fixture.account = { subject: "account-b", epoch: 2 };
	else fixture.workspace = { key: "organization:org-b", epoch: 2 };
	expect(render()).toBe("");
});
it("ignores a status response after unmount", async () => {
	render();
	const stop = fixture.effect();
	stop?.();
	await fixture.read.mock.results[0]?.value;
	expect(render()).toBe("");
});

it("stars directly and dismisses only after success", async () => {
	await check();
	GithubStarPrompt()?.props.children[0].props.onClick();
	await vi.waitFor(() =>
		expect(fixture.dismiss).toHaveBeenCalledWith({
			githubStarPromptDismissed: true,
		}),
	);
	expect(fixture.star).toHaveBeenCalledOnce();
	expect(fixture.openExternal).not.toHaveBeenCalled();
	expect(fixture.toast).not.toHaveBeenCalled();
});

it("silently allows retry after failure without opening a page", async () => {
	fixture.star.mockRejectedValue(new Error("GitHub unavailable"));
	await check();
	GithubStarPrompt()?.props.children[0].props.onClick();
	await fixture.star.mock.results[0]?.value.catch(() => {});
	expect(fixture.star).toHaveBeenCalledOnce();
	expect(fixture.toast).not.toHaveBeenCalled();
	expect(fixture.dismiss).not.toHaveBeenCalled();
	expect(fixture.openExternal).not.toHaveBeenCalled();
	expect(render()).toContain("Star on GitHub");
	fixture.star.mockResolvedValue();
	GithubStarPrompt()?.props.children[0].props.onClick();
	await vi.waitFor(() => expect(fixture.dismiss).toHaveBeenCalledOnce());
	expect(fixture.star).toHaveBeenCalledTimes(2);
	expect(fixture.toast).not.toHaveBeenCalled();
});
