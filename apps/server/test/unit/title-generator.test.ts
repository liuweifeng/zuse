import { describe, expect, it } from "vitest";
import {
	buildNamingPrompt,
	cleanTitle,
	fallbackTitle,
	limitNamingMessage,
	MAX_GENERATED_TITLE_LENGTH,
	parseNamingReply,
} from "../../src/provider/title-generator.ts";

describe("generated title length", () => {
	it.each([
		["model title", (text: string) => cleanTitle(text)],
		["fallback title", (text: string) => fallbackTitle(text)],
	])("caps a %s at 60 characters", (_label, makeTitle) => {
		const title = makeTitle("A".repeat(100));
		expect(title).toHaveLength(MAX_GENERATED_TITLE_LENGTH);
		expect(title).toBe("A".repeat(60));
	});

	it("cuts long titles at a word boundary", () => {
		const request =
			"Please look into why the cloud terminal keeps disconnecting after the laptop sleeps";
		const title = fallbackTitle(request);
		expect(title.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
		expect(request.startsWith(`${title} `)).toBe(true);
	});
});

describe("fallbackTitle", () => {
	it("skips links, mentions, and markdown to find a readable subject", () => {
		expect(
			fallbackTitle(
				"https://github.com/o/r/pull/1\n## **Fix** @src/a.ts login flow.",
			),
		).toBe("Fix login flow");
	});

	it("keeps the placeholder when nothing readable remains", () => {
		expect(fallbackTitle("https://example.com")).toBe("New chat");
	});
});

describe("cleanTitle", () => {
	it("strips labels, quotes, markdown, and trailing punctuation", () => {
		expect(cleanTitle('\n**Title:** "Fix Cloud Terminal Reconnect."')).toBe(
			"Fix Cloud Terminal Reconnect",
		);
	});
});

describe("parseNamingReply", () => {
	it("reads JSON wrapped in prose or a code fence", () => {
		expect(
			parseNamingReply(
				'Sure!\n```json\n{"title": "Redesign Setup Card", "branch": "redesign-setup-card"}\n```',
			),
		).toEqual({ title: "Redesign Setup Card", branch: "redesign-setup-card" });
	});

	it("treats a bare line as the title", () => {
		expect(parseNamingReply("Fix Login Redirect")).toEqual({
			title: "Fix Login Redirect",
			branch: "",
		});
	});

	it("does not title a chat after malformed JSON", () => {
		expect(parseNamingReply('{"title": ')).toEqual({ title: "", branch: "" });
	});
});

describe("buildNamingPrompt", () => {
	it("asks only for the names that are still pending", () => {
		const titleOnly = buildNamingPrompt("Fix login", {
			title: true,
			branch: false,
		});
		expect(titleOnly).toContain('keys "title".');
		expect(titleOnly).not.toContain("Branch rules");

		const both = buildNamingPrompt("Fix login", { title: true, branch: true });
		expect(both).toContain('keys "title" and "branch"');
		expect(both).toContain("<message>\nFix login\n</message>");
	});

	it("keeps the head and tail of very long requests", () => {
		const limited = limitNamingMessage(`start ${"x".repeat(10_000)} end`, 100);
		expect(limited.startsWith("start")).toBe(true);
		expect(limited.endsWith("end")).toBe(true);
		expect(limited).toContain("[Content truncated]");
	});
});
