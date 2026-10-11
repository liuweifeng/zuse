import { expect, test } from "vitest";
import { sanitizeNotchItems } from "../src/notch-tray-items.ts";

test("native IPC preserves truthful attention states while rejecting malformed rows", () => {
	const item = {
		id: "item",
		chatId: "chat",
		sessionId: "session",
		title: "Agent",
		subtitle: "Workspace",
		label: "Quiet",
		updatedAt: 1,
	};
	const states = ["quiet", "unavailable", "disconnected", "checking"];
	expect(
		sanitizeNotchItems(states.map((state) => ({ ...item, state }))).map(
			(row) => row.state,
		),
	).toEqual(states);
	expect(
		sanitizeNotchItems([
			{ ...item, state: "not-a-state" },
			{ ...item, state: "quiet", sessionId: null },
		]),
	).toEqual([]);
});
