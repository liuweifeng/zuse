import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const result = await build({
	stdin: {
		contents: `
    import { sessionTimelineCache, rememberCloudTimelineHead, timelineReadingPositionStore } from './apps/renderer/src/lib/session-timeline-cache.ts';
    import { makeSessionTimelineCacheEntry } from './packages/client-runtime/src/session-timeline-cache.ts';
    import { SessionTimelineProjection, Message, QueueState } from '@zuse/contracts';
    window.readingProbe = async () => {
      const ref = { environmentId: 'reading-workspace', sessionId: 'reading-session' };
      const position = { schemaVersion: 1, sessionId: ref.sessionId, userTurnMessageId: 'old-turn', viewportOffset: -50, updatedAt: 1 };
      if (timelineReadingPositionStore.peek(ref, 'account-a') !== undefined) throw new Error('unexpected warm position');
      await timelineReadingPositionStore.load(ref, 'account-a');
      if (timelineReadingPositionStore.peek(ref, 'account-a') !== null) throw new Error('empty position not remembered');
      const saving = timelineReadingPositionStore.save(ref, position, 'account-a');
      if (timelineReadingPositionStore.peek(ref, 'account-a')?.userTurnMessageId !== 'old-turn') throw new Error('warm position unavailable during save');
      await saving;
      if (timelineReadingPositionStore.peek(ref, 'account-b') !== undefined) throw new Error('position leaked across accounts');
      await timelineReadingPositionStore.remove(ref, 'account-a');
      if (timelineReadingPositionStore.peek(ref, 'account-a') !== null) throw new Error('removed position remains cached');
      return true;
    };
    window.probe = async (seed = true) => {
      const ref = { environmentId: 'workspace-cache-repro', sessionId: 'session-cache-repro' };
      const cursor = { epoch: 'same-runtime', version: 10 };
      const message = (id, text) => Message.make({ id, sessionId: ref.sessionId, role: 'user', content: { _tag: 'user', text }, createdAt: new Date(0) });
      const old = message('old', 'Already read history');
      const oldest = message('oldest', 'Earlier cached page');
      const head = message('head', 'Recent message');
      const projection = SessionTimelineProjection.make({ messages: [head], olderMessageSequence: 5, status: 'idle', activeTurn: null, turnCount: 0, queue: QueueState.make({ items: [], paused: false }), permissionMode: 'default', runtimeMode: 'full-access' });
      if (seed) {
      rememberCloudTimelineHead(ref, projection, cursor, 'account-test');
      await sessionTimelineCache.saveHistoryPage(ref, cursor, 5, { messages: [old], olderMessageSequence: 2 }, 'account-test');
      await sessionTimelineCache.saveHistoryPage(ref, cursor, 2, { messages: [oldest], olderMessageSequence: null }, 'account-test');
      await sessionTimelineCache.save(makeSessionTimelineCacheEntry({ ref, cursor: { ...cursor, version: 11 }, projection: SessionTimelineProjection.make({ ...projection, messages: [old, head], olderMessageSequence: null }) }), 'account-test');
      }
      const saved = await sessionTimelineCache.load(ref, 'account-test');
      const originalPage = await sessionTimelineCache.loadHistoryPage(ref, cursor, 5, 'account-test');
      const advancedPage = await sessionTimelineCache.loadHistoryPage(ref, { ...cursor, version: 11 }, 5, 'account-test');
      const fallback = (ref, cursor, namespace = 'account-test', before = 5) => sessionTimelineCache.loadHistoryPage(ref, cursor, before, namespace, { allowEarlierVersion: true });
      return {
        savedMessages: saved.projection.messages.map(m => m.id),
        originalPageMessages: originalPage?.messages.map(m => m.id),
        exactAfterAdvance: advancedPage ?? null,
        fallbackMessages: (await fallback(ref, { ...cursor, version: 11 }))?.messages.map(m => m.id),
        changedEpoch: await fallback(ref, { epoch: 'replacement-runtime', version: 11 }),
        earlierCursor: await fallback(ref, { ...cursor, version: 9 }),
        changedAccount: await fallback(ref, { ...cursor, version: 11 }, 'another-account'),
        changedEnvironment: await fallback({ ...ref, environmentId: 'another-workspace' }, { ...cursor, version: 11 }),
        changedBoundary: await fallback(ref, { ...cursor, version: 11 }, 'account-test', 4),
      };
    };
    window.largeCacheProbe = async (seed) => {
      const ref = { environmentId: 'large-cache', sessionId: 'large-session' };
      const cursor = { epoch: 'large', version: 50000 };
      const message = i => Message.make({ id: 'large-' + i, sessionId: ref.sessionId, role: 'user', content: { _tag: 'user', text: 'message ' + i }, createdAt: new Date(i) });
      if (seed) {
        const messages = Array.from({ length: 10000 }, (_, i) => message(i));
        const projection = SessionTimelineProjection.make({ messages: messages.slice(9900), olderMessageSequence: 9900, status: 'running', activeTurn: null, turnCount: 0, queue: QueueState.make({ items: [], paused: false }), permissionMode: 'default', runtimeMode: 'full-access' });
        rememberCloudTimelineHead(ref, projection, cursor, 'large-account');
        await sessionTimelineCache.saveHistoryPage(ref, cursor, 9900, { messages: messages.slice(0, 9900), olderMessageSequence: null }, 'large-account');
        await sessionTimelineCache.save(makeSessionTimelineCacheEntry({ ref, cursor, projection }), 'large-account');
      } else {
        const restored = await sessionTimelineCache.load(ref, 'large-account');
        if (restored.projection.messages.length !== 10000) throw new Error('cached history missing');
        await sessionTimelineCache.save(makeSessionTimelineCacheEntry({ ref, cursor: { ...cursor, version: 50001 }, projection: SessionTimelineProjection.make({ ...restored.projection, messages: [...restored.projection.messages, message(10000)] }) }), 'large-account');
      }
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('zuse-session-timelines'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const rows = await new Promise((resolve, reject) => { const r = db.transaction('timelines').objectStore('timelines').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      db.close();
      const head = rows.find(row => row.ref.environmentId === ref.environmentId);
      const restored = await sessionTimelineCache.load(ref, 'large-account');
      return { persistedHead: head.projection.messages.length, restoredMessages: restored.projection.messages.length };
    };
    window.coherenceProbe = async (complete) => {
      const ref = { environmentId: 'coherence-workspace', sessionId: 'coherence-' + complete };
      const cursor = { epoch: 'rollback-within-epoch', version: 13 };
      const message = id => Message.make({ id, sessionId: ref.sessionId, role: 'user', content: { _tag: 'user', text: id }, createdAt: new Date(0) });
      const projection = SessionTimelineProjection.make({ messages: [message('head')], olderMessageSequence: 100, status: 'idle', activeTurn: null, turnCount: 0, queue: QueueState.make({ items: [], paused: false }), permissionMode: 'default', runtimeMode: 'full-access' });
      const savePage = (version, before, id, next) => sessionTimelineCache.saveHistoryPage(ref, { ...cursor, version }, before, { messages: [message(id)], olderMessageSequence: next }, 'coherence-account');
      await savePage(10, 100, 'first-v10', 50);
      await savePage(9, 50, 'deleted-v9', null);
      await savePage(12, 50, 'different-v12', null);
      await savePage(13, 50, 'different-v13', null);
      if (complete) await savePage(10, 50, 'matching-v10', null);
      await sessionTimelineCache.save(makeSessionTimelineCacheEntry({ ref, cursor, projection }), 'coherence-account');
      const restored = await sessionTimelineCache.load(ref, 'coherence-account');
      const fallback = before => sessionTimelineCache.loadHistoryPage(ref, cursor, before, 'coherence-account', { allowEarlierVersion: true });
      const hydrationContinuation = complete ? null : await fallback(50);
      const first = await fallback(100);
      const strictContinuation = await sessionTimelineCache.loadHistoryPage(ref, cursor, 50, 'coherence-account');
      const second = await sessionTimelineCache.loadHistoryPage(ref, { ...cursor, version: 14 }, 50, 'coherence-account', { allowEarlierVersion: true });
      return {
        restored: restored.projection.messages.map(m => m.id),
        remaining: restored.projection.olderMessageSequence,
        first: first?.messages.map(m => m.id),
        hydrationContinuation,
        strictContinuation,
        second: second?.messages.map(m => m.id) ?? null,
      };
    };
  `,
		resolveDir: resolve(import.meta.dirname, "../../../.."),
		loader: "ts",
	},
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "esnext",
	define: { "import.meta.env.VITE_ZUSE_HOSTED": '"0"' },
});
const server = createServer((req, res) => {
	if (req.url === "/probe.js") {
		res.setHeader("Content-Type", "text/javascript");
		res.end(result.outputFiles[0].text);
	} else {
		res.setHeader("Content-Type", "text/html");
		res.end('<script src="/probe.js"></script>');
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
	browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH,
		headless: true,
	});
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.waitForFunction(() => typeof window.probe === "function");
	const expected = {
		savedMessages: ["oldest", "old", "head"],
		originalPageMessages: ["old"],
		exactAfterAdvance: null,
		fallbackMessages: ["old"],
		changedEpoch: null,
		earlierCursor: null,
		changedAccount: null,
		changedEnvironment: null,
		changedBoundary: null,
	};
	assert.deepEqual(await page.evaluate(() => window.largeCacheProbe(true)), {
		persistedHead: 100,
		restoredMessages: 10000,
	});
	await page.reload();
	await page.waitForFunction(
		() => typeof window.largeCacheProbe === "function",
	);
	assert.deepEqual(await page.evaluate(() => window.largeCacheProbe(false)), {
		persistedHead: 101,
		restoredMessages: 10001,
	});
	assert.equal(await page.evaluate(() => window.readingProbe()), true);
	assert.deepEqual(await page.evaluate(() => window.probe()), expected);
	await page.reload();
	await page.waitForFunction(() => typeof window.probe === "function");
	assert.deepEqual(await page.evaluate(() => window.probe(false)), expected);
	assert.deepEqual(await page.evaluate(() => window.coherenceProbe(false)), {
		restored: ["first-v10", "head"],
		remaining: 50,
		first: ["first-v10"],
		hydrationContinuation: null,
		strictContinuation: null,
		second: null,
	});
	assert.deepEqual(await page.evaluate(() => window.coherenceProbe(true)), {
		restored: ["matching-v10", "first-v10", "head"],
		remaining: null,
		first: ["first-v10"],
		hydrationContinuation: null,
		strictContinuation: null,
		second: ["matching-v10"],
	});
	console.log(
		"PASS: history survives reload and stream advancement; restored and fallback page chains remain pinned to one snapshot version",
	);
} finally {
	await browser?.close();
	server.close();
}
