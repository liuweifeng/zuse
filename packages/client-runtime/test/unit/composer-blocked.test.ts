import { expect, it } from "vitest";
import { composerSendBlocked } from "../../src/plan-interactions.ts";

it("blocks ordinary drafts while permitting an actual plan response and normal active queueing", () => {
	expect(composerSendBlocked("blocked")).toBe(true);
	expect(composerSendBlocked("blocked", true)).toBe(false);
	expect(composerSendBlocked("healthy")).toBe(false);
	expect(composerSendBlocked("stalled")).toBe(false);
});
