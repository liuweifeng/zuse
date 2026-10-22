import {
	Chat,
	ChatId,
	FolderId,
	type MasterChatSummary,
	type MasterWorker,
	Session,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { masterWorkerActivity } from "../../src/lib/master-activity.ts";
import { masterScreenDocument } from "../../src/lib/master-screen.ts";

const now = new Date("2026-09-13T00:00:00Z");
const chatId = ChatId.make("chat"),
	sessionId = SessionId.make("session"),
	projectId = FolderId.make("repository");
const session = Session.make({
	id: sessionId,
	projectId,
	title: "Search",
	titleProvenance: "manual",
	chatId,
	providerId: "codex",
	model: "test",
	status: "running",
	archivedAt: null,
	providerThread: null,
	runtimeMode: "approval-required",
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: now,
	updatedAt: now,
});
const summary = (): MasterChatSummary => ({
	repository: { environmentId: "local", folderId: projectId, name: "Repo" },
	chat: Chat.make({
		id: chatId,
		projectId,
		worktreeId: null,
		title: "Search",
		titleProvenance: "manual",
		activeSessionId: sessionId,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt: null,
		lastReadAt: null,
		createdAt: now,
		updatedAt: now,
	}),
	sessions: [session],
	pr: null,
	stale: false,
	offline: false,
	busySessionIds: [],
	blockedSessionIds: [],
});
const worker: MasterWorker = {
	environmentId: "local",
	folderId: projectId,
	chatId,
	sessionId,
	objective: "Fix search",
	state: "active",
	followUps: 0,
	lastEventSequence: 0,
};
describe("Master slave activity", () => {
	it("prefers a slave's Master state over its session activity", () => {
		const busy = { ...summary(), busySessionIds: [sessionId] };
		expect(masterWorkerActivity(worker, [busy])).toBe("working");
		expect(masterWorkerActivity({ ...worker, state: "paused" }, [busy])).toBe(
			"paused",
		);
		expect(masterWorkerActivity({ ...worker, state: "done" }, [busy])).toBe(
			"done",
		);
		expect(
			masterWorkerActivity(worker, [
				{ ...summary(), blockedSessionIds: [sessionId] },
			]),
		).toBe("blocked");
		expect(masterWorkerActivity(worker, [summary()])).toBe("idle");
		expect(
			masterWorkerActivity(worker, [{ ...summary(), offline: true }]),
		).toBe("offline");
		expect(masterWorkerActivity(worker, [])).toBe("offline");
	});
	it("matches slaves to their own environment's chat", () => {
		const elsewhere = {
			...summary(),
			repository: { ...summary().repository, environmentId: "remote" },
			busySessionIds: [sessionId],
		};
		expect(masterWorkerActivity(worker, [elsewhere, summary()])).toBe("idle");
	});
});
it("puts the trusted bridge and CSP before generated code", () => {
	const generated =
		'<script>zuseMaster.requestAction({_tag:"interrupt"})</script>';
	const document = masterScreenDocument(generated);
	expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
		document.indexOf(generated),
	);
	expect(document).toContain("connect-src 'none'");
	expect(document).toContain("form-action 'none'");
	expect(document).toContain("Object.freeze");
	expect(document).not.toContain("allow-same-origin");
});
