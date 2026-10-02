import { makeSessionTimelineCacheEntry } from "@zuse/client-runtime/session-timeline-cache";
import {
	EnvironmentId,
	QueueState,
	type SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	cloudCatalogCacheKey,
	environmentSessionCacheKey,
	resolveReadingPositionKeysToPrune,
	shouldPersistTimelineCheckpoint,
} from "../../src/lib/session-timeline-cache.ts";

const position = (sessionId: string, updatedAt: number) => ({
	schemaVersion: 1 as const,
	sessionId: sessionId as SessionId,
	userTurnMessageId: `turn-${sessionId}`,
	viewportOffset: 16,
	updatedAt,
});

describe("session timeline reading-position cache", () => {
	it("partitions account checkpoints without adopting device-local legacy keys", () => {
		const ref = {
			environmentId: EnvironmentId.make("remote"),
			sessionId: "same" as SessionId,
		};
		const keys = [undefined, "first", "second", 'account:with"separators'].map(
			(namespace) => environmentSessionCacheKey(ref, namespace),
		);
		expect(new Set(keys).size).toBe(keys.length);
		expect(
			JSON.parse(environmentSessionCacheKey(ref, 'account:with"separators')),
		).toEqual(['account:with"separators', keys[0]]);
	});
	it("keeps cloud catalog account keys distinct from each other and legacy history", () => {
		expect(cloudCatalogCacheKey("first")).not.toBe(
			cloudCatalogCacheKey("second"),
		);
		expect(cloudCatalogCacheKey("catalog")).not.toBe("catalog");
		expect(JSON.parse(cloudCatalogCacheKey('account:with"separators'))).toEqual(
			["account", 'account:with"separators'],
		);
	});
	it("prunes corrupt and least-recently-updated records", () => {
		expect(
			resolveReadingPositionKeysToPrune(
				[
					position("recent", 30),
					position("oldest", 10),
					{ sessionId: "corrupt", schemaVersion: 99 },
					position("middle", 20),
				],
				2,
			),
		).toEqual(["corrupt", "oldest"]);
	});

	it("treats a negative limit as an empty cache", () => {
		expect(
			resolveReadingPositionKeysToPrune(
				[position("one", 1), position("two", 2)],
				-1,
			),
		).toEqual(["two", "one"]);
	});

	it("namespaces colliding session IDs by environment", () => {
		expect(
			environmentSessionCacheKey({
				environmentId: EnvironmentId.make("local"),
				sessionId: "same" as SessionId,
			}),
		).not.toBe(
			environmentSessionCacheKey({
				environmentId: EnvironmentId.make("remote"),
				sessionId: "same" as SessionId,
			}),
		);
	});

	it("rejects a delayed same-epoch checkpoint but permits an explicit epoch reset", () => {
		const ref = {
			environmentId: EnvironmentId.make("local"),
			sessionId: "same" as SessionId,
		};
		const projection = SessionTimelineProjection.make({
			messages: [],
			status: "idle",
			activeTurn: null,
			turnCount: 0,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});
		const entry = (epoch: string, version: number) =>
			makeSessionTimelineCacheEntry({
				ref,
				cursor: { epoch, version },
				projection,
				now: version,
			});

		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("a", 7))).toBe(
			false,
		);
		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("a", 8))).toBe(
			true,
		);
		expect(shouldPersistTimelineCheckpoint(entry("a", 8), entry("b", 1))).toBe(
			true,
		);
	});
});
