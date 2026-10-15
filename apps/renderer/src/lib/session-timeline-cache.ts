import { resourceCacheStorageKey } from "@zuse/client-runtime/client-persistence";
import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	prependSessionTimelineMessages,
	restoreSessionTimelineState,
} from "@zuse/client-runtime/session-timeline";
import {
	decodeSessionTimelineCacheEntry,
	encodeSessionTimelineCacheEntry,
	type SessionTimelineCache,
	type SessionTimelineCacheEntry,
} from "@zuse/client-runtime/session-timeline-cache";
import {
	Message,
	type SessionId,
	type SessionStreamCursor,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Schema } from "effect";
import { hostedCacheDatabaseName } from "./hosted-session.ts";
import {
	decodeTimelineReadingPosition,
	encodeTimelineReadingPosition,
	type TimelineReadingPosition,
	type TimelineReadingPositionStore,
} from "./timeline-reading-position.ts";

const DATABASE_NAME = "zuse-session-timelines";
const DATABASE_VERSION = 6;
const HISTORY_STORE_NAME = "cloud-history-pages";
const STORE_NAME = "timelines";
const METADATA_STORE_NAME = "timeline-metadata";
const READING_POSITION_STORE_NAME = "reading-positions";
const CLOUD_CATALOG_STORE_NAME = "cloud-catalog";
export const cloudCatalogCacheKey = (subject: string): string =>
	JSON.stringify(["account", subject]);
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_READING_POSITIONS = 256;

export const environmentSessionCacheKey = (
	ref: SessionRef,
	namespace?: string,
): SessionId =>
	resourceCacheStorageKey(resourceRefKey(ref), namespace) as SessionId;

export const shouldPersistTimelineCheckpoint = (
	existing: SessionTimelineCacheEntry,
	next: SessionTimelineCacheEntry,
): boolean =>
	existing.cursor.epoch !== next.cursor.epoch ||
	existing.cursor.version <= next.cursor.version;

export function resolveReadingPositionKeysToPrune(
	values: ReadonlyArray<unknown>,
	maxEntries = DEFAULT_MAX_READING_POSITIONS,
): SessionId[] {
	const valid: TimelineReadingPosition[] = [];
	const invalidKeys: SessionId[] = [];
	for (const value of values) {
		const decoded = decodeTimelineReadingPosition(value);
		if (decoded !== null) {
			valid.push(decoded);
			continue;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			"sessionId" in value &&
			typeof value.sessionId === "string"
		) {
			invalidKeys.push(value.sessionId as SessionId);
		}
	}
	valid.sort(
		(left, right) =>
			right.updatedAt - left.updatedAt ||
			left.sessionId.localeCompare(right.sessionId),
	);
	return [
		...invalidKeys,
		...valid
			.slice(Math.max(0, maxEntries))
			.map((position) => position.sessionId),
	];
}

const cloudHeads = new Map<
	string,
	{ epoch: string; firstId: string | undefined; olderSequence: number | null }
>();
export const rememberCloudTimelineHead = (
	ref: SessionRef,
	projection: SessionTimelineProjection,
	cursor: SessionStreamCursor,
	namespace?: string,
): void => {
	cloudHeads.set(environmentSessionCacheKey(ref, namespace), {
		epoch: cursor.epoch,
		firstId: projection.messages[0]?.id,
		olderSequence: projection.olderMessageSequence ?? null,
	});
};
const cloudHeadEntry = (
	entry: SessionTimelineCacheEntry,
	namespace?: string,
): SessionTimelineCacheEntry => {
	const head = cloudHeads.get(environmentSessionCacheKey(entry.ref, namespace));
	if (!head || head.epoch !== entry.cursor.epoch) return entry;
	const index = entry.projection.messages.findIndex(
		(message) => message.id === head.firstId,
	);
	if (index < 0) return entry;
	return {
		...entry,
		projection: SessionTimelineProjection.make({
			...entry.projection,
			messages: entry.projection.messages.slice(index),
			olderMessageSequence: head.olderSequence,
		}),
	};
};
const HistoryPage = Schema.Struct({
	messages: Schema.Array(Message),
	olderMessageSequence: Schema.NullOr(Schema.Number),
});
type HistoryPage = typeof HistoryPage.Type;
const historyPageKey = (
	ref: SessionRef,
	cursor: SessionStreamCursor,
	before: number,
	namespace?: string,
) =>
	JSON.stringify([
		environmentSessionCacheKey(ref, namespace),
		cursor.epoch,
		cursor.version,
		before,
	]);

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});

const cachedHistoryKeys = async (
	store: IDBObjectStore,
	resource: string,
	cursor: SessionStreamCursor,
): Promise<Map<number, string>> => {
	const keys = await requestResult(
		store.index("resource").getAllKeys(resource),
	);
	const latest = new Map<number, { key: string; version: number }>();
	for (const key of keys) {
		if (typeof key !== "string") continue;
		try {
			const parts: unknown = JSON.parse(key);
			if (
				!Array.isArray(parts) ||
				parts.length !== 4 ||
				parts[0] !== resource ||
				parts[1] !== cursor.epoch ||
				typeof parts[2] !== "number" ||
				!Number.isSafeInteger(parts[2]) ||
				parts[2] < 0 ||
				parts[2] > cursor.version ||
				typeof parts[3] !== "number" ||
				!Number.isSafeInteger(parts[3])
			)
				continue;
			const previous = latest.get(parts[3]);
			if (!previous || previous.version < parts[2])
				latest.set(parts[3], { key, version: parts[2] });
		} catch {
			// Ignore malformed keys without changing other cached pages.
		}
	}
	return new Map([...latest].map(([before, entry]) => [before, entry.key]));
};

const decodeHistoryPage = (record: unknown): HistoryPage | null => {
	if (typeof record !== "object" || record === null || !("page" in record))
		return null;
	try {
		return Schema.decodeUnknownSync(HistoryPage)(record.page);
	} catch {
		return null;
	}
};

const openDatabase = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.open(
			hostedCacheDatabaseName(DATABASE_NAME),
			DATABASE_VERSION,
		);
		request.onupgradeneeded = (event) => {
			const database = request.result;
			if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
				const pages = database.createObjectStore(HISTORY_STORE_NAME, {
					keyPath: "key",
				});
				pages.createIndex("resource", "resource");
			}
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
			}
			if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
				database.createObjectStore(METADATA_STORE_NAME, {
					keyPath: "sessionId",
				});
			}
			if (!database.objectStoreNames.contains(READING_POSITION_STORE_NAME)) {
				database.createObjectStore(READING_POSITION_STORE_NAME, {
					keyPath: "sessionId",
				});
			}
			if (!database.objectStoreNames.contains(CLOUD_CATALOG_STORE_NAME)) {
				database.createObjectStore(CLOUD_CATALOG_STORE_NAME);
			}
			// Versions before 4 used an ambient active-environment value when
			// reading/writing. Those keys cannot be migrated safely because a late
			// async write may have been attributed to the wrong environment.
			if (event.oldVersion > 0 && event.oldVersion < 4) {
				for (const name of [
					STORE_NAME,
					METADATA_STORE_NAME,
					READING_POSITION_STORE_NAME,
				]) {
					request.transaction?.objectStore(name).clear();
				}
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Unable to open timeline cache"));
	});

class IndexedDbSessionTimelineCache implements SessionTimelineCache {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	async load(
		ref: SessionRef,
		namespace?: string,
	): Promise<SessionTimelineCacheEntry | null> {
		const storageKey = environmentSessionCacheKey(ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const raw = await requestResult(store.get(storageKey));
		if (raw === undefined) {
			await transactionComplete(transaction);
			return null;
		}
		let decoded: SessionTimelineCacheEntry;
		try {
			decoded = decodeSessionTimelineCacheEntry(raw);
		} catch {
			store.delete(storageKey);
			transaction.objectStore(METADATA_STORE_NAME).delete(storageKey);
			await transactionComplete(transaction);
			return null;
		}
		const pages = transaction.objectStore(HISTORY_STORE_NAME);
		const history: ReadonlyArray<Message>[] = [];
		let before = decoded.projection.olderMessageSequence ?? null;
		// Reopening a paused chat must not require an API checkpoint before its
		// already cached history is readable. Scan keys once, then load only the
		// contiguous pages belonging to this checkpoint's account and epoch.
		const keys =
			decoded.projection.olderMessageSequence == null
				? new Map<number, string>()
				: await cachedHistoryKeys(pages, storageKey, decoded.cursor);
		while (before !== null) {
			const key = keys.get(before);
			if (key === undefined) break;
			const page = decodeHistoryPage(await requestResult(pages.get(key)));
			if (
				page === null ||
				(page.olderMessageSequence !== null &&
					page.olderMessageSequence >= before)
			)
				break;
			history.push(page.messages);
			before = page.olderMessageSequence;
		}
		const projection =
			history.length === 0
				? decoded.projection
				: (prependSessionTimelineMessages(
						restoreSessionTimelineState(decoded.projection, decoded.cursor),
						history.reverse().flat(),
						before,
					).projection ?? decoded.projection);
		const touched = {
			...decoded,
			ref,
			projection,
			accessedAt: Date.now(),
		};
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: storageKey,
			accessedAt: touched.accessedAt,
			estimatedBytes: touched.estimatedBytes,
		});
		await transactionComplete(transaction);
		return touched;
	}

	async save(
		fullEntry: SessionTimelineCacheEntry,
		namespace?: string,
	): Promise<void> {
		const entry = cloudHeadEntry(fullEntry, namespace);
		const storageKey = environmentSessionCacheKey(entry.ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const existingRaw = await requestResult(store.get(storageKey));
		if (existingRaw !== undefined) {
			try {
				const existing = decodeSessionTimelineCacheEntry(existingRaw);
				// Delayed checkpoint writes are serialized by ClientBus, but a second
				// app surface or old process can still race this IndexedDB record. Only
				// an explicit epoch reset may move the durable cursor backwards.
				if (!shouldPersistTimelineCheckpoint(existing, entry)) {
					await transactionComplete(transaction);
					return;
				}
			} catch {
				// Replace malformed cache data with the current validated checkpoint.
			}
		}
		const encoded = encodeSessionTimelineCacheEntry(entry);
		const persisted = {
			...(encoded as Record<string, unknown>),
			sessionId: storageKey,
			estimatedBytes: JSON.stringify(encoded).length,
		};
		store.put(persisted);
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: storageKey,
			accessedAt: entry.accessedAt,
			estimatedBytes: persisted.estimatedBytes,
		});
		await transactionComplete(transaction);
	}

	async loadHistoryPage(
		ref: SessionRef,
		cursor: SessionStreamCursor,
		before: number,
		namespace?: string,
		options?: { readonly allowEarlierVersion?: boolean },
	): Promise<HistoryPage | null> {
		const database = await this.db();
		const transaction = database.transaction(HISTORY_STORE_NAME, "readonly");
		const store = transaction.objectStore(HISTORY_STORE_NAME);
		let record = await requestResult(
			store.get(historyPageKey(ref, cursor, before, namespace)),
		);
		if (!record && options?.allowEarlierVersion === true) {
			// An unavailable server must not make previously read history disappear.
			// Inspect keys only; loading every page here can consume the entire cache.
			const resource = environmentSessionCacheKey(ref, namespace);
			const latestKey = (await cachedHistoryKeys(store, resource, cursor)).get(
				before,
			);
			if (latestKey !== undefined)
				record = await requestResult(store.get(latestKey));
		}
		await transactionComplete(transaction);
		return decodeHistoryPage(record);
	}
	async saveHistoryPage(
		ref: SessionRef,
		cursor: SessionStreamCursor,
		before: number,
		page: HistoryPage,
		namespace?: string,
	): Promise<void> {
		const database = await this.db();
		const encoded = Schema.encodeSync(HistoryPage)(page);
		const transaction = database.transaction(
			[HISTORY_STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		const key = historyPageKey(ref, cursor, before, namespace);
		const bytes = JSON.stringify(encoded).length;
		transaction.objectStore(HISTORY_STORE_NAME).put({
			key,
			resource: environmentSessionCacheKey(ref, namespace),
			page: encoded,
		});
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: `history:${key}`,
			historyKey: key,
			accessedAt: Date.now(),
			estimatedBytes: bytes,
		});
		await transactionComplete(transaction);
	}

	async remove(ref: SessionRef, namespace?: string): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		cloudHeads.delete(storageKey);
		const pages = transaction.objectStore(HISTORY_STORE_NAME);
		const pageKeys = await requestResult(
			pages.index("resource").getAllKeys(storageKey),
		);
		for (const key of pageKeys) {
			pages.delete(key);
			transaction
				.objectStore(METADATA_STORE_NAME)
				.delete(`history:${String(key)}`);
		}
		transaction.objectStore(STORE_NAME).delete(storageKey);
		transaction.objectStore(METADATA_STORE_NAME).delete(storageKey);
		await transactionComplete(transaction);
	}

	async prune(
		limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
	): Promise<void> {
		const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
		const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
		const entries = (await requestResult(metadataStore.getAll())) as Array<{
			readonly sessionId: string;
			readonly historyKey?: string;
			readonly accessedAt: number;
			readonly estimatedBytes: number;
		}>;
		entries.sort((left, right) => right.accessedAt - left.accessedAt);
		let retainedBytes = 0;
		let headCount = 0;
		for (const entry of entries) {
			if (entry.historyKey === undefined) headCount++;
			retainedBytes += entry.estimatedBytes;
			if (
				(entry.historyKey === undefined && headCount > maxEntries) ||
				retainedBytes > maxBytes
			) {
				if (entry.historyKey !== undefined)
					transaction.objectStore(HISTORY_STORE_NAME).delete(entry.historyKey);
				else store.delete(entry.sessionId);
				metadataStore.delete(entry.sessionId);
			}
		}
		await transactionComplete(transaction);
	}
}

class IndexedDbTimelineReadingPositionStore
	implements TimelineReadingPositionStore
{
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	async load(
		ref: SessionRef,
		namespace?: string,
	): Promise<TimelineReadingPosition | null> {
		const storageKey = environmentSessionCacheKey(ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		const store = transaction.objectStore(READING_POSITION_STORE_NAME);
		const raw = await requestResult(store.get(storageKey));
		const decoded = decodeTimelineReadingPosition(raw);
		if (raw !== undefined && decoded === null) store.delete(storageKey);
		await transactionComplete(transaction);
		return decoded === null ? null : { ...decoded, sessionId: ref.sessionId };
	}

	async save(
		ref: SessionRef,
		position: TimelineReadingPosition,
		namespace?: string,
	): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		const store = transaction.objectStore(READING_POSITION_STORE_NAME);
		store.put(
			encodeTimelineReadingPosition({ ...position, sessionId: storageKey }),
		);
		const values = await requestResult(store.getAll());
		for (const sessionId of resolveReadingPositionKeysToPrune(values)) {
			store.delete(sessionId);
		}
		await transactionComplete(transaction);
	}

	async remove(ref: SessionRef, namespace?: string): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref, namespace);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		transaction.objectStore(READING_POSITION_STORE_NAME).delete(storageKey);
		await transactionComplete(transaction);
	}
}

export const sessionTimelineCache =
	typeof indexedDB === "undefined" ? null : new IndexedDbSessionTimelineCache();

export const timelineReadingPositionStore: TimelineReadingPositionStore | null =
	typeof indexedDB === "undefined"
		? null
		: new IndexedDbTimelineReadingPositionStore();

export const cloudChatCatalogPersistence =
	typeof indexedDB === "undefined"
		? null
		: {
				load: async (subject: string): Promise<unknown | null> => {
					const database = await openDatabase();
					const transaction = database.transaction(
						CLOUD_CATALOG_STORE_NAME,
						"readonly",
					);
					const value = await requestResult(
						transaction
							.objectStore(CLOUD_CATALOG_STORE_NAME)
							.get(cloudCatalogCacheKey(subject)),
					);
					await transactionComplete(transaction);
					return value ?? null;
				},
				save: async (subject: string, value: unknown): Promise<void> => {
					const database = await openDatabase();
					const transaction = database.transaction(
						CLOUD_CATALOG_STORE_NAME,
						"readwrite",
					);
					transaction
						.objectStore(CLOUD_CATALOG_STORE_NAME)
						.put(value, cloudCatalogCacheKey(subject));
					await transactionComplete(transaction);
				},
			};
