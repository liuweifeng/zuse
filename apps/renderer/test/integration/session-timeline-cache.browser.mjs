import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const result = await build({
	stdin: {
		contents: `
    import { sessionTimelineCache, rememberCloudTimelineHead } from './apps/renderer/src/lib/session-timeline-cache.ts';
    import { makeSessionTimelineCacheEntry } from './packages/client-runtime/src/session-timeline-cache.ts';
    import { SessionTimelineProjection, Message, QueueState } from '@zuse/contracts';
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
	assert.deepEqual(await page.evaluate(() => window.probe()), expected);
	await page.reload();
	await page.waitForFunction(() => typeof window.probe === "function");
	assert.deepEqual(await page.evaluate(() => window.probe(false)), expected);
	console.log(
		"PASS: history survives reload and stream advancement; runtime, account, environment, version and pagination boundaries remain isolated",
	);
} finally {
	await browser?.close();
	server.close();
}
