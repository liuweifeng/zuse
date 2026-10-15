import { NodeServices } from "@effect/platform-node";
import { GitFolderNotFoundError } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { GitService } from "../../src/git-service.ts";
import { GitServiceLive } from "../../src/git-service-live.ts";
import { GitHubClient, GitHubClientService } from "../../src/github-client.ts";
import { RepositoryLocator } from "../../src/repository-locator.ts";

const readStatus = async (repository: unknown) => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response(JSON.stringify({ data: { repository } })));
	const client = new GitHubClient({
		resolveCredential: async () => ({ token: "test-token" }),
		fetch,
	});
	const layer = GitServiceLive.pipe(
		Layer.provide(
			Layer.succeed(RepositoryLocator, {
				root: (folderId) =>
					Effect.fail(new GitFolderNotFoundError({ folderId })),
				worktreePath: () => Effect.succeed(null),
				resolve: (folderId) =>
					Effect.fail(new GitFolderNotFoundError({ folderId })),
			}),
		),
		Layer.provide(NodeServices.layer),
	);
	try {
		const result = await Effect.runPromise(
			Effect.flatMap(GitService, (service) => service.zuseStarStatus()).pipe(
				Effect.provide(layer),
				Effect.provideService(GitHubClientService, client),
			),
		);
		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body.variables).toEqual({ owner: "swarajbachu", name: "zuse" });
		expect(body.query).toContain("viewerHasStarred");
		return result;
	} finally {
		client.close();
	}
};
it.each([
	true,
	false,
])("returns GitHub's actual star status (%s)", async (viewerHasStarred) => {
	expect(await readStatus({ viewerHasStarred })).toBe(viewerHasStarred);
});
it("does not treat a missing repository as unstarred", async () => {
	await expect(readStatus(null)).rejects.toMatchObject({
		_tag: "GitHubStarError",
	});
});
