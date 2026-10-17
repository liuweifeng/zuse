import { expect, test } from "vitest";
import { GitHubClient } from "../../src/github-client.ts";
import { GitHubObservations } from "../../src/github-observations.ts";
import { pr } from "../github-fixture.ts";

test("reads a known PR with no checkout, Git process, or runtime credential", async () => {
	const client = new GitHubClient({
		resolveCredential: async () => ({ token: "user" }),
		fetch: async (_url, init) => {
			const { query } = JSON.parse(String(init?.body));
			expect(query).not.toContain("pullRequests(");
			const data = Object.fromEntries(
				[...query.matchAll(/(p\d+):/g)].map((match) => [
					match[1],
					{ pullRequest: pr() },
				]),
			);
			return Response.json({ data });
		},
	});
	try {
		const target = {
			host: "github.com",
			owner: "acme",
			repo: "app",
			branch: "feature",
			number: 1,
		};
		const result = await new GitHubObservations(client).observe(
			target,
			{ ...target, cwd: "/does-not-exist" },
			new AbortController().signal,
		);
		expect(result.pr).toMatchObject({
			state: "open",
			prCapability: "available",
			stale: false,
		});
		expect(result.pr.observedAt).toBeInstanceOf(Date);
	} finally {
		client.close();
	}
});

test("denied credentials produce an explicit authentication observation", async () => {
	const { GitHubFailure } = await import("../../src/github-client.ts");
	const client = new GitHubClient({
		resolveCredential: async () => {
			throw new GitHubFailure("authentication", "Connect GitHub");
		},
		fetch: async () => {
			throw new Error("must not call GitHub without authentication");
		},
	});
	try {
		const target = {
			host: "github.com",
			owner: "acme",
			repo: "app",
			branch: "feature",
		};
		const result = await new GitHubObservations(client).observe(
			target,
			{ ...target, cwd: "/does-not-exist" },
			new AbortController().signal,
		);
		expect(result.pr).toMatchObject({
			state: "none",
			prCapability: "authentication",
			observationError: "Connect GitHub",
			stale: true,
		});
	} finally {
		client.close();
	}
});

test("catalog fallback never chooses an arbitrary fork with the same branch name", async () => {
	const client = new GitHubClient({
		resolveCredential: async () => ({ token: "user" }),
		fetch: async (_url, init) => {
			const { query } = JSON.parse(String(init?.body));
			const nodes = [
				pr({ headRepositoryOwner: { login: "alice" } }),
				pr({ number: 2, headRepositoryOwner: { login: "bob" } }),
			];
			return Response.json({
				data: Object.fromEntries(
					[...query.matchAll(/(p\d+):/g)].map((match) => [
						match[1],
						{
							pullRequests: {
								nodes,
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					]),
				),
			});
		},
	});
	try {
		const target = {
			host: "github.com",
			owner: "upstream",
			repo: "app",
			branch: "feature",
		};
		const result = await new GitHubObservations(client).observe(
			target,
			{ ...target, cwd: "" },
			new AbortController().signal,
		);
		expect(result.pr).toMatchObject({
			number: null,
			state: "none",
			prCapability: "unknown",
			stale: true,
		});
		expect(result.pr.observationError).toContain("multiple forks");
	} finally {
		client.close();
	}
});

test("a deleted fork does not make the remaining known owner ambiguous", async () => {
	const merged = pr({
		state: "MERGED",
		headRepositoryOwner: { login: "upstream" },
	});
	const client = new GitHubClient({
		resolveCredential: async () => ({ token: "user" }),
		fetch: async (_url, init) => {
			const { query } = JSON.parse(String(init?.body));
			return Response.json({
				data: Object.fromEntries(
					[...query.matchAll(/(p\d+):/g)].map((match) => [
						match[1],
						{
							pullRequest: merged,
							pullRequests: {
								nodes: [
									merged,
									pr({ number: 2, state: "CLOSED", headRepositoryOwner: null }),
								],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					]),
				),
			});
		},
	});
	try {
		const target = {
			host: "github.com",
			owner: "upstream",
			repo: "app",
			branch: "feature",
		};
		const result = await new GitHubObservations(client).observe(
			target,
			{ ...target, cwd: "" },
			new AbortController().signal,
		);
		expect(result.pr).toMatchObject({
			number: 1,
			state: "merged",
			stale: false,
		});
	} finally {
		client.close();
	}
});
