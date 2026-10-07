import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { ProviderId, SessionTimelineProjection } from "@zuse/contracts";

export type ModelSelection = Readonly<{
	providerId: ProviderId;
	model: string;
}>;
type Result =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };
type Entry = {
	ref: SessionRef;
	selection: ModelSelection;
	running: boolean;
	stop: () => void;
	blockedCursor: string | null;
};

/** A selection is intent until the authoritative timeline allows configuration. */
export function createPendingModelChanges(options: {
	current: (ref: SessionRef) => ModelSelection | null;
	snapshot: (ref: SessionRef) => ResourceView<SessionTimelineProjection>;
	retain: (ref: SessionRef, listener: () => void) => () => void;
	apply: (ref: SessionRef, selection: ModelSelection) => Promise<void>;
	changed: (ref: SessionRef, selection: ModelSelection | null) => void;
	failed: (error: unknown) => string;
}) {
	const entries = new Map<string, Entry>();
	const clear = (key: string, entry: Entry) => {
		if (entries.get(key) !== entry) return;
		entries.delete(key);
		entry.stop();
		options.changed(entry.ref, null);
	};
	const pumpAttempt = async (key: string, entry: Entry): Promise<Result> => {
		if (entries.get(key) !== entry || entry.running) return { ok: true };
		const view = options.snapshot(entry.ref);
		if (view.connection === "revoked") {
			clear(key, entry);
			return {
				ok: false,
				reason: options.failed(
					new Error("This session is no longer available."),
				),
			};
		}
		if (
			view.sync !== "live" ||
			view.connection !== "connected" ||
			view.data === null
		)
			return { ok: true };
		const busy =
			view.data.activeTurn !== null || view.data.queue.items.length > 0;
		if (busy) {
			entry.blockedCursor = null;
			return { ok: true };
		}
		const cursor = JSON.stringify(view.cursor);
		if (entry.blockedCursor === cursor) return { ok: true };
		entry.running = true;
		const selection = entry.selection;
		try {
			await options.apply(entry.ref, selection);
			if (entry.selection === selection) clear(key, entry);
		} catch (error) {
			// Only a definite rejection for active work is safe to defer again. Other
			// failures may have ambiguous delivery and must never be silently replayed.
			if (isBusyModelChange(error)) {
				entry.blockedCursor = cursor;
			} else {
				clear(key, entry);
				return { ok: false, reason: options.failed(error) };
			}
		} finally {
			entry.running = false;
		}
		if (
			entries.get(key) === entry &&
			(entry.selection !== selection || entry.blockedCursor !== null)
		)
			void pump(key, entry);
		return { ok: true };
	};
	const pump = async (key: string, entry: Entry): Promise<Result> => {
		try {
			return await pumpAttempt(key, entry);
		} catch (error) {
			clear(key, entry);
			return { ok: false, reason: options.failed(error) };
		}
	};
	return {
		request(ref: SessionRef, selection: ModelSelection): Promise<Result> {
			const key = resourceRefKey(ref);
			const existing = entries.get(key);
			const current = options.current(ref);
			if (
				!existing?.running &&
				current?.providerId === selection.providerId &&
				current.model === selection.model
			) {
				if (existing !== undefined) clear(key, existing);
				return Promise.resolve({ ok: true });
			}
			if (existing !== undefined) {
				existing.selection = selection;
				options.changed(ref, selection);
				return pump(key, existing);
			}
			const entry: Entry = {
				ref,
				selection,
				running: false,
				stop: () => {},
				blockedCursor: null,
			};
			entries.set(key, entry);
			options.changed(ref, selection);
			try {
				entry.stop = options.retain(ref, () => {
					void pump(key, entry);
				});
			} catch (error) {
				clear(key, entry);
				return Promise.resolve({ ok: false, reason: options.failed(error) });
			}
			return pump(key, entry);
		},
		cancel(ref: SessionRef): void {
			const key = resourceRefKey(ref);
			const entry = entries.get(key);
			if (entry !== undefined && !entry.running) clear(key, entry);
		},
		dispose(): void {
			for (const [key, entry] of entries) clear(key, entry);
		},
	};
}

const BUSY_REASON =
	"Finish or stop the active turn and clear queued messages before switching provider or model.";
export function isBusyModelChange(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	return (
		"_tag" in error &&
		error._tag === "SessionConfigurationError" &&
		"reason" in error &&
		error.reason === BUSY_REASON
	);
}
