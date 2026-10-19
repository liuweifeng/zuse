import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type { ComposerInput } from "@zuse/contracts";
import { formatError } from "../lib/format-error.ts";
import { subscribeRendererAccount } from "../lib/renderer-account.ts";
import { updateQueuedMessage } from "../lib/session-actions.ts";
import { createAtomStore } from "../state/atom-store.ts";
import {
	finalizeStartupInputWhenReady,
	releaseDraftAttachmentPreviews,
	type StartupInputOptions,
	type StartupInputTarget,
} from "./startup-input.ts";

type StartupQueueJob = Readonly<{
	status: "preparing" | "failed";
	error: string | null;
	retry: () => Promise<boolean>;
	cancel: () => void;
}>;

/** Owns first-message bytes beyond the landing screen's navigation lifetime.
 * Bytes stay in memory for retry; after reload the durable unready queue item
 * remains authoritative and the UI asks the user to reattach the files. */
export const useStartupQueueStore = createAtomStore<{
	readonly jobs: Readonly<Record<string, StartupQueueJob>>;
}>(() => ({ jobs: {} }));

export const startupQueueKey = (ref: SessionRef, queueId: string): string =>
	JSON.stringify([resourceRefKey(ref), queueId]);

export const cancelStartupQueue = (ref: SessionRef, queueId: string): void => {
	useStartupQueueStore.getState().jobs[startupQueueKey(ref, queueId)]?.cancel();
};

export const prepareStartupQueue = (
	input: ComposerInput,
	target: StartupInputTarget,
	options: StartupInputOptions,
	queueId: string,
): Promise<boolean> => {
	const key = startupQueueKey(target.ref, queueId);
	const existing = useStartupQueueStore.getState().jobs[key];
	if (existing !== undefined) return existing.retry();
	let cancelled = false;
	const controller = new AbortController();
	let inFlight: Promise<boolean> | null = null;
	let prepared: ComposerInput | null = null;
	const remove = () => {
		useStartupQueueStore.setState((state) => {
			const jobs = { ...state.jobs };
			delete jobs[key];
			return { jobs };
		});
		releaseDraftAttachmentPreviews(options.pendingAttachments);
	};
	const cancel = () => {
		cancelled = true;
		controller.abort();
		remove();
	};
	const publish = (status: StartupQueueJob["status"], error: string | null) => {
		useStartupQueueStore.setState((state) => ({
			jobs: { ...state.jobs, [key]: { status, error, retry, cancel } },
		}));
	};
	const run = async (): Promise<boolean> => {
		try {
			prepared ??= await finalizeStartupInputWhenReady(input, target, options, {
				signal: controller.signal,
			});
			if (cancelled) return false;
			const updated = await updateQueuedMessage(target.ref, queueId, prepared);
			if (cancelled) return false;
			if (!updated)
				throw new Error("Couldn't send your prepared message. Please retry.");
			remove();
			return true;
		} catch (error) {
			if (!cancelled) publish("failed", formatError(error));
			return false;
		} finally {
			inFlight = null;
		}
	};
	const retry = (): Promise<boolean> => {
		if (cancelled) return Promise.resolve(false);
		if (inFlight !== null) return inFlight;
		publish("preparing", null);
		inFlight = run();
		return inFlight;
	};
	return retry();
};

const clear = () => {
	for (const job of Object.values(useStartupQueueStore.getState().jobs))
		job.cancel();
};
const unsubscribe = subscribeRendererAccount(clear);
if (import.meta.hot)
	import.meta.hot.dispose(() => {
		unsubscribe();
		clear();
	});
