import type { Master, MasterChatSummary, MasterWorker } from "@zuse/contracts";

/** Live execution state of one session inside a Master chat summary. */
type MasterSessionActivity = "offline" | "blocked" | "working" | "idle";
const masterSessionActivity = (
	summary: MasterChatSummary | undefined,
	sessionId: string,
): MasterSessionActivity =>
	!summary || summary.offline
		? "offline"
		: summary.blockedSessionIds.includes(sessionId)
			? "blocked"
			: summary.busySessionIds.includes(sessionId)
				? "working"
				: "idle";

/** What a supervised slave is doing: its Master state wins over session activity. */
export type MasterWorkerActivity = MasterSessionActivity | "paused" | "done";
export const masterWorkerActivity = (
	worker: MasterWorker,
	chats: readonly MasterChatSummary[],
): MasterWorkerActivity =>
	worker.state !== "active"
		? worker.state
		: masterSessionActivity(
				chats.find(
					(chat) =>
						chat.repository.environmentId === worker.environmentId &&
						chat.chat.id === worker.chatId,
				),
				worker.sessionId,
			);

/** Slaves still supervised (not paused or marked done). */
export const activeSlaveCount = (master: Pick<Master, "workers">) =>
	master.workers.filter((worker) => worker.state === "active").length;
