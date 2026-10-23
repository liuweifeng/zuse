import { makeSessionTimelineCacheEntry } from "@zuse/client-runtime/session-timeline-cache";
import {
	type CloudChatSummary,
	EnvironmentId,
	type FolderId,
	type MessageId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { openCloudChat, summaryFromLaunch } from "./cloud-workspaces.ts";
import { forkTimelinePreview } from "./fork-timeline-preview.ts";
import { getControlPlaneRpcClient } from "./rpc-client.ts";
import { sessionTimelineCache } from "./session-timeline-cache.ts";
import {
	getRendererClientBus,
	sessionTimelineResourceKey,
} from "./session-timeline-client-bus.ts";

export const forkCloudMachine = async (input: {
	readonly cloud: CloudChatSummary;
	readonly projectId: FolderId;
	readonly source: Session | null;
	readonly sourceSessionId: SessionId;
	readonly fromMessageId: MessageId;
}) => {
	const { cloud, source } = input;
	if (cloud.providerId !== "boxd")
		throw new Error("Machine forks are only available on boxd.");
	const bus = getRendererClientBus();
	const sourceRef = {
		environmentId: EnvironmentId.make(cloud.workspaceId),
		sessionId: input.sourceSessionId,
	};
	const sourceTimeline =
		bus.snapshot(sessionTimelineResourceKey(sourceRef)).data ??
		(await sessionTimelineCache?.load(sourceRef).catch(() => null))?.projection;
	const scope = cloud.workspaceScope ?? { kind: "personal" as const };
	const control = await getControlPlaneRpcClient(scope);
	const launch = await Effect.runPromise(
		control["cloud.workspaces.fork"]({
			projectId: cloud.projectId,
			providerId: "boxd",
			baseRef: cloud.branch,
			agent: source?.providerId ?? cloud.agent,
			model: source?.model ?? cloud.model,
			runtimeMode: source?.runtimeMode ?? cloud.runtimeMode,
			idempotencyKey: crypto.randomUUID(),
			forkSource: {
				workspaceId: cloud.workspaceId,
				sessionId: input.sourceSessionId,
				messageId: input.fromMessageId,
			},
		}),
	);
	const summary = summaryFromLaunch({
		workspaceScope: scope,
		workspace: launch.workspace,
		repositoryIdentity: cloud.repositoryIdentity,
		repositoryDisplayName: cloud.repositoryDisplayName,
		title: `Fork of ${source?.title ?? cloud.title}`,
		agent: source?.providerId ?? cloud.agent,
		model: source?.model ?? cloud.model,
		runtimeMode: source?.runtimeMode ?? cloud.runtimeMode,
	});
	if (sourceTimeline != null) {
		const preview = forkTimelinePreview(
			sourceTimeline,
			input.fromMessageId,
			launch.initialSessionId,
		);
		if (preview !== null) {
			const ref = {
				environmentId: EnvironmentId.make(launch.workspace.workspaceId),
				sessionId: launch.initialSessionId,
			};
			const key = sessionTimelineResourceKey(ref);
			bus.snapshot(key);
			bus.overlay(key, {
				initialData: preview,
				update: (current) =>
					current.messages.length === 0 ? preview : current,
			});

			await sessionTimelineCache
				?.save(
					makeSessionTimelineCacheEntry({
						ref,
						projection: preview,
						cursor: { epoch: `fork-preview:${ref.environmentId}`, version: 0 },
					}),
				)
				.catch((error) => console.warn("Could not cache fork preview", error));
		}
	}
	await openCloudChat(summary, input.projectId);
	return {
		chatId: launch.chatId,
		sessionId: launch.initialSessionId,
		forkMode: "machine" as const,
	};
};
