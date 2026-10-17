import type { GitPrInfo, GitStackResult } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { chatPullRequests } from "../../src/lib/chat-pull-requests.ts";

const pr = (number: number): GitPrInfo =>
	({
		state: "open",
		branch: `layer-${number}`,
		baseBranch: null,
		additions: 0,
		deletions: 0,
		number,
		url: `https://github.com/acme/app/pull/${number}`,
		isDraft: false,
		checks: "success",
		mergeable: "clean",
		checksTotal: 0,
		checksRunning: 0,
		checksPassing: 0,
		checksFailing: 0,
		autoMergeEnabled: false,
	}) as GitPrInfo;

const layer = (name: string, number: number | null, isCurrent = false) => ({
	name,
	isCurrent,
	isMerged: false,
	needsRebase: false,
	...(number === null
		? {}
		: {
				pr: {
					number,
					url: `https://github.com/acme/app/pull/${number}`,
					title: `Layer ${number}`,
					state: "open" as const,
					isDraft: false,
				},
			}),
});

/** gh stack lists the top of the stack first. */
const stack = (
	branches: ReadonlyArray<ReturnType<typeof layer>>,
): GitStackResult =>
	({ output: "", trunk: "main", branches }) as GitStackResult;

describe("chatPullRequests", () => {
	it("lists a stack base first and marks the checkout's PR", () => {
		const result = chatPullRequests({
			pr: pr(12),
			title: "Live title",
			stack: stack([layer("c", 13), layer("b", 12, true), layer("a", 11)]),
		});
		expect(result.map((item) => item.number)).toEqual([11, 12, 13]);
		expect(result.find((item) => item.isCurrent)?.title).toBe("Live title");
	});

	it("places the checkout's PR at its branch when the stack has not linked it yet", () => {
		const result = chatPullRequests({
			pr: pr(12),
			title: null,
			stack: stack([layer("c", 13), layer("b", null, true), layer("a", 11)]),
		});
		expect(result.map((item) => item.number)).toEqual([11, 12, 13]);
		expect(result[1]?.isCurrent).toBe(true);
	});

	it("returns the lone PR when there is no stack", () => {
		const result = chatPullRequests({ pr: pr(7), title: null, stack: null });
		expect(result.map((item) => item.number)).toEqual([7]);
	});
});
