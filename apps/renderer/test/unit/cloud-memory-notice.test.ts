import { describe, expect, test } from "vitest";
import {
	cloudMemoryNotice,
	shouldObserveCloudMemory,
} from "../../src/lib/cloud-memory-notice.ts";

describe("cloud memory notice", () => {
	test("preserves a memory diagnostic when lifecycle reports a generic failure", () => {
		expect(
			cloudMemoryNotice("connection-failed", false, "runtime-memory-recovering")
				?.title,
		).toBe("connections:cloud_memory_recovering");
		expect(
			cloudMemoryNotice("connection-failed", false, "network-error"),
		).toBeNull();
	});
	test("shows a warning only for measured pressure and clears after recovery", () => {
		expect(cloudMemoryNotice("ready", true)?.title).toBe(
			"connections:cloud_memory_low",
		);
		expect(cloudMemoryNotice("ready", false)).toBeNull();
		expect(cloudMemoryNotice("connection-failed", false)).toBeNull();
	});
	test("distinguishes waiting, confirmed OOM recovery, and stopped retries", () => {
		expect(cloudMemoryNotice("runtime-memory-pressure", false)?.title).toBe(
			"connections:cloud_memory_waiting",
		);
		expect(cloudMemoryNotice("runtime-memory-recovering", false)?.title).toBe(
			"connections:cloud_memory_recovering",
		);
		expect(cloudMemoryNotice("runtime-memory-recovery-failed", true)).toEqual({
			title: "connections:cloud_memory_failed",
			busy: false,
		});
	});
});

test("does not open telemetry for local, paused, idle, or disconnected chats", () => {
	const ready = { state: "ready", runtimeState: "online" } as const;
	expect(shouldObserveCloudMemory(ready, "connected", "running")).toBe(true);
	expect(shouldObserveCloudMemory(ready, "connected", "idle")).toBe(false);
	expect(shouldObserveCloudMemory(ready, "failed", "running")).toBe(false);
	expect(shouldObserveCloudMemory(null, "connected", "running")).toBe(false);
	expect(
		shouldObserveCloudMemory(
			{ state: "paused", runtimeState: "offline" },
			"connected",
			"running",
		),
	).toBe(false);
});
