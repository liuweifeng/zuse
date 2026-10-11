import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	EnvironmentId,
} from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	client: false,
	phase: "connecting",
	error: null as string | null,
	release: vi.fn(),
	listener: undefined as (() => void) | undefined,
	unsubscribe: vi.fn(),
}));
vi.mock("../../src/lib/session-timeline-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-client-bus.ts")
	>()),
	registerEnvironmentActivation: vi.fn(),
	getRendererClientBus: () => ({
		client: () => (state.client ? {} : null),
		connection: () => ({ phase: state.phase, error: state.error }),
		retain: () => ({ release: state.release }),
		subscribe: (_key: unknown, listener: () => void) => {
			state.listener = listener;
			return state.unsubscribe;
		},
	}),
}));

import {
	environmentShellResourceKey,
	waitForEnvironmentGateway,
} from "../../src/lib/environment-shell-client-bus.ts";

const environmentId = EnvironmentId.make("early-cloud-runtime");
const key = environmentShellResourceKey({ environmentId });
beforeEach(() => {
	state.client = false;
	state.phase = "connecting";
	state.error = null;
	state.release.mockClear();
	state.listener = undefined;
	state.unsubscribe.mockClear();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("connection-first cloud gateway readiness", () => {
	it("does not open on a ticket or connecting frame; opens on the live runtime client", async () => {
		let opened = false;
		const ready = waitForEnvironmentGateway(environmentId, key).then(() => {
			opened = true;
		});
		state.listener?.();
		await Promise.resolve();
		expect(opened).toBe(false);
		state.client = true;
		state.phase = "connected";
		state.listener?.();
		await ready;
		expect(opened).toBe(true);
		expect(state.unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops waiting on authentication failure and cleans its listener", async () => {
		const ready = waitForEnvironmentGateway(environmentId, key);
		const failed = expect(ready).rejects.toThrow("gateway is not available");
		state.phase = "blocked-auth";
		state.listener?.();
		await failed;
		expect(state.unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases its observer when the runtime never becomes reachable", async () => {
		const ready = waitForEnvironmentGateway(environmentId, key, 100);
		const failed = expect(ready).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(100);
		await failed;
		expect(state.unsubscribe).toHaveBeenCalledOnce();
	});
});

import { connectCloudWorkspaceForLaunch } from "../../src/lib/cloud-workspaces.ts";

const launchSummary = CloudChatSummary.make({
	workspaceId: "cold-launch",
	projectId: "project",
	repositoryIdentity: "github.com/test/project",
	repositoryDisplayName: "project",
	chatId: ChatId.make("chat"),
	initialSessionId: AgentSessionId.make("session"),
	title: "Cloud chat",
	branch: "zuse/test",
	providerId: "e2b",
	agent: "codex",
	model: "gpt-5.6",
	runtimeMode: "full-access",
	state: "provisioning",
	desiredState: "ready",
	runtimeState: "connecting",
	statusCode: "provisioning",
	startupPhase: "booting",
	revision: 1,
	summaryRevision: 0,
	sessionHeadVersion: 0,
	unread: false,
	lastMessageAt: 1,
	createdAt: 1,
	updatedAt: 1,
});
it("keeps a cold launch retained beyond the ordinary connection timeout until its runtime is ready", async () => {
	let settled = false;
	const launched = connectCloudWorkspaceForLaunch(launchSummary).then(
		(release) => {
			settled = true;
			return release;
		},
		(cause) => {
			settled = true;
			throw cause;
		},
	);
	void launched.catch(() => undefined);
	await vi.advanceTimersByTimeAsync(70_800);
	expect(settled).toBe(false);
	expect(state.release).not.toHaveBeenCalled();
	state.client = true;
	state.phase = "connected";
	state.listener?.();
	const release = await launched;
	release();
	expect(state.release).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("surfaces a launch protocol mismatch immediately instead of waiting out cold-start time", async () => {
	const launched = connectCloudWorkspaceForLaunch(
		CloudChatSummary.make({
			...launchSummary,
			workspaceId: "mismatched-launch",
		}),
	);
	const failed = expect(launched).rejects.toThrow(
		"Update required: runtime uses protocol 6",
	);
	state.phase = "update-required";
	state.error = "Update required: runtime uses protocol 6";
	state.listener?.();
	await failed;
	expect(state.release).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
it("bounds a launch that never advertises a gateway and releases its lease", async () => {
	const launched = connectCloudWorkspaceForLaunch(
		CloudChatSummary.make({ ...launchSummary, workspaceId: "stuck-launch" }),
	);
	const failed = expect(launched).rejects.toThrow(
		"Timed out waiting for the cloud workspace gateway",
	);
	await vi.advanceTimersByTimeAsync(5 * 60_000);
	await failed;
	expect(state.release).toHaveBeenCalledOnce();
	expect(state.unsubscribe).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
