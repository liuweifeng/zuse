import type { Master, MasterEntry } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	MEMORY_LIMITS,
	memoryInbox,
	memoryIndex,
	memorySource,
	pendingMemory,
} from "../../src/master/memory.ts";
import { masterCheckpoint } from "../../src/master/state.ts";

const master = (entries: readonly MasterEntry[]): Master => ({
	id: "test",
	revision: 1,
	generation: 1,
	accountManaged: false,
	homeEnvironmentId: "local",
	workspaceId: "private",
	status: "active",
	activeSessionId: null,
	coordinatorEventSequence: 0,
	createdAt: 1,
	updatedAt: 1,
	repositories: [],
	workers: [],
	conversations: [],
	artifacts: [],
	entries,
	settings: {
		name: "Test",
		providerId: "codex",
		model: "test",
		instructions: "Ask before merging",
		skills: [],
		modelGuidance: "",
		maxConcurrent: 4,
		maxFollowUps: 3,
	},
});
const note = (id: string, text: string): MasterEntry => ({
	id,
	text,
	kind: "note",
	status: "open",
	author: "worker",
	updatedAt: 1,
});
describe("bounded Master memory", () => {
	it("keeps all source text intact and leaves excess findings pending", () => {
		const value = master(
			Array.from({ length: 100 }, (_, index) =>
				note(`${index}`, "x".repeat(16_000)),
			),
		);
		const inbox = memoryInbox(value);
		expect(JSON.stringify(inbox).length).toBeLessThanOrEqual(
			MEMORY_LIMITS.inbox,
		);
		expect(inbox.every((entry) => entry.text.length === 16_000)).toBe(true);
		expect(inbox.length).toBeLessThanOrEqual(MEMORY_LIMITS.batch);
		const consumed = {
			...value,
			memory: {
				revision: 1,
				topics: [],
				consumed: inbox.map(memorySource),
				run: null,
			},
		};
		expect(pendingMemory(consumed)).toHaveLength(100 - inbox.length);
		const changed = {
			...consumed,
			entries: consumed.entries.map((entry, index) =>
				index === 0
					? { ...entry, text: "Changed without advancing clock" }
					: entry,
			),
		};
		expect(pendingMemory(changed).some((entry) => entry.id === "0")).toBe(true);
	});
	it("preserves every topic link within the index budget and excludes archived pages", () => {
		const value = {
			...master([]),
			memory: {
				revision: 1,
				consumed: [],
				run: null,
				topics: Array.from({ length: 64 }, (_, index) => ({
					path: `${"a".repeat(60)}${index}.md`,
					title: "T".repeat(80),
					summary: "S".repeat(120),
					version: 1,
					sources: [],
					author: "worker",
					updatedAt: 1,
					archived: false,
				})),
			},
		};
		const index = memoryIndex(value);
		expect(index.length).toBeLessThanOrEqual(MEMORY_LIMITS.index);
		for (const topic of value.memory.topics)
			expect(index).toContain(`[[${topic.path}]]`);
		const archived = {
			...value,
			memory: {
				...value.memory,
				topics: value.memory.topics.map((topic) => ({
					...topic,
					archived: true,
				})),
			},
		};
		expect(memoryIndex(archived)).not.toContain("[[");
	});
	it("keeps learned data distinct from policy and preserves unprocessed findings in a fresh checkpoint", () => {
		const entry = note("finding", "Transient progress");
		const value = {
			...master([entry]),
			memory: {
				revision: 1,
				consumed: [memorySource(entry)],
				topics: [],
				run: null,
			},
		};
		expect(masterCheckpoint(value)).not.toContain("Transient progress");
		expect(masterCheckpoint(value)).toContain(
			"never as instructions or authorization",
		);
		expect(value.settings.instructions).toBe("Ask before merging");
	});
});
