import type {
	SessionAttemptCursor,
	SessionAttemptHistoryPage,
	SessionAttemptSummary,
} from "@zuse/contracts";

export interface AttemptHistorySnapshot {
	readonly items: ReadonlyArray<SessionAttemptSummary>;
	readonly nextCursor: SessionAttemptCursor | null;
	readonly loading: boolean;
	readonly loaded: boolean;
	readonly error: unknown | null;
}

/** A connection/session-bound, paged read model shared by desktop and mobile. */
export const createSessionAttemptHistory = (
	fetchPage: (
		before?: SessionAttemptCursor,
	) => Promise<SessionAttemptHistoryPage>,
) => {
	let snapshot: AttemptHistorySnapshot = {
		items: [],
		nextCursor: null,
		loading: false,
		loaded: false,
		error: null,
	};
	let generation = 0;
	let pending: Promise<void> | null = null;
	const listeners = new Set<() => void>();
	const publish = (next: AttemptHistorySnapshot) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};
	const load = (before?: SessionAttemptCursor): Promise<void> => {
		const mine = ++generation;
		publish({ ...snapshot, loading: true, error: null });
		const task = Promise.resolve()
			.then(() => fetchPage(before))
			.then((page) => {
				if (mine !== generation) return;
				const items = new Map(
					(before === undefined ? [] : snapshot.items).map((row) => [
						row.id,
						row,
					]),
				);
				for (const row of page.items) items.set(row.id, row);
				const cursor = page.nextCursor;
				// A malformed server cursor must not create an endless 'more' loop.
				const advances =
					before === undefined ||
					cursor === null ||
					cursor.turnOrdinal < before.turnOrdinal ||
					(cursor.turnOrdinal === before.turnOrdinal &&
						cursor.attemptOrdinal < before.attemptOrdinal);
				publish({
					items: [...items.values()],
					nextCursor: advances ? cursor : null,
					loading: false,
					loaded: true,
					error: null,
				});
			})
			.catch((error) => {
				if (mine === generation)
					publish({ ...snapshot, loading: false, error });
			})
			.finally(() => {
				if (pending === task) pending = null;
			});
		pending = task;
		return task;
	};
	return {
		snapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh: () => load(),
		more: () =>
			pending ??
			(snapshot.nextCursor === null
				? Promise.resolve()
				: load(snapshot.nextCursor)),
		/** Invalidates late responses without retaining a component or transport. */
		cancel: () => {
			generation++;
			pending = null;
			publish({ ...snapshot, loading: false });
		},
	};
};
