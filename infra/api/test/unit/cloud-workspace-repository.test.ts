import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const script = new URL(
	"../../../cloud-sandboxes/workspace-repository.sh",
	import.meta.url,
);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "zuse cloud branch-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(root, "file"), "original");
	git("add", ".");
	git("commit", "-m", "initial");
	// The image checkout points at a reachable origin; an unreachable path
	// stands in for network failure without waiting on DNS or TLS.
	const remote = join(root, "origin.git");
	execFileSync("git", ["init", "--bare", "-b", "main", remote], {
		stdio: "pipe",
	});
	git("remote", "add", "origin", remote);
	git("push", "origin", "main");
	const unreachable = "/nonexistent/zuse-unreachable/repo.git";
	/** Advance origin's main from a separate clone, leaving the checkout stale. */
	const advanceRemoteMain = (content: string): string => {
		const clone = mkdtempSync(join(tmpdir(), "zuse cloud remote-"));
		roots.push(clone);
		const cloneGit = (...args: string[]) =>
			execFileSync("git", ["-C", clone, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		execFileSync("git", ["clone", "-q", remote, clone], { stdio: "pipe" });
		cloneGit("config", "user.name", "Test");
		cloneGit("config", "user.email", "test@example.com");
		writeFileSync(join(clone, "file"), content);
		cloneGit("commit", "-am", "remote work");
		cloneGit("push", "-q", "origin", "main");
		return cloneGit("rev-parse", "HEAD");
	};
	const run = (
		base = "main",
		repositoryUrl = remote,
		fork = false,
		native = false,
		extraEnv: Record<string, string> = {},
	) =>
		execFileSync("bash", [script.pathname], {
			env: {
				...process.env,
				ZUSE_CLOUD_WORKSPACE_ROOT: root,
				ZUSE_WORKSPACE_RUNTIME_STATUS_DIR: root,
				ZUSE_BRANCH: "vileplume",
				ZUSE_BASE_REF: base,
				ZUSE_FORK_CHECKOUT: fork ? "1" : "",
				ZUSE_SNAPSHOT_NATIVE: native ? "1" : "",
				ZUSE_REPOSITORY_URL: repositoryUrl,
				...extraEnv,
			},
			stdio: "pipe",
		});
	return { root, git, run, remote, unreachable, advanceRemoteMain };
};
describe("cloud workspace branch initialization", () => {
	test("initial organization fetch carries its creator identity only in the repository process", () => {
		const { root, run } = fixture();
		const context = {
			actor: { subject: "member", membershipId: "membership" },
		};
		const bin = join(root, "bin");
		execFileSync("mkdir", [bin]);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/bash
if [[ "$*" == *" fetch "* ]]; then
  cat "$ZUSE_GITHUB_CONTEXT_DIR/request.json" > "$CAPTURE_CONTEXT"
fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		run("main", undefined, false, false, {
			PATH: `${bin}:${process.env.PATH}`,
			ZUSE_USER_DATA: root,
			ZUSE_GITHUB_STARTUP_CONTEXT: JSON.stringify(context),
			CAPTURE_CONTEXT: join(root, "captured.json"),
		});
		expect(
			JSON.parse(readFileSync(join(root, "captured.json"), "utf8")),
		).toEqual(context);
	});
	test("machine forks preserve detached commits, staged edits and untracked files", () => {
		const { root, git, run, unreachable } = fixture();
		git("checkout", "--detach");
		writeFileSync(join(root, "file"), "fork commit");
		git("commit", "-am", "local commit");
		const head = git("rev-parse", "HEAD");
		writeFileSync(join(root, "file"), "staged");
		git("add", "file");
		writeFileSync(join(root, "file"), "unstaged");
		writeFileSync(join(root, "untracked"), "keep");
		run("main", unreachable, true);
		run("main", unreachable, true);
		expect(git("rev-parse", "HEAD")).toBe(head);
		expect(git("show", ":file")).toBe("staged");
		expect(readFileSync(join(root, "file"), "utf8")).toBe("unstaged");
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
		expect(git("branch", "--show-current")).toBe("vileplume");
	});

	test("creates the requested branch and preserves edits across recovery retries", () => {
		const { root, git, run } = fixture();
		writeFileSync(join(root, "file"), "user edits");
		writeFileSync(join(root, "untracked"), "keep");
		run();
		expect(readFileSync(join(root, "repository-progress"), "utf8").trim()).toBe(
			"switching-branch",
		);
		run();
		expect(readFileSync(join(root, "repository-progress"), "utf8").trim()).toBe(
			"checking-repository",
		);
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(readFileSync(join(root, "file"), "utf8")).toBe("user edits");
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
	});
	test("a fresh managed branch starts from the latest fetched base, not the cached checkout", () => {
		const { root, git, run, advanceRemoteMain } = fixture();
		const stale = git("rev-parse", "HEAD");
		const latest = advanceRemoteMain("remote progress");
		expect(latest).not.toBe(stale);
		writeFileSync(join(root, "untracked"), "keep");
		run();
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(git("rev-parse", "HEAD")).toBe(latest);
		expect(git("rev-parse", "origin/main")).toBe(latest);
		expect(git("config", "--get", "branch.vileplume.remote")).toBe("origin");
		expect(git("rev-parse", "main")).toBe(stale);
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
		expect(readFileSync(join(root, "file"), "utf8")).toBe("remote progress");
	});
	test("an origin-qualified base fetches the same branch and tracks it", () => {
		const { git, run, advanceRemoteMain } = fixture();
		const latest = advanceRemoteMain("origin qualified");
		run("origin/main");
		expect(git("rev-parse", "HEAD")).toBe(latest);
		expect(git("config", "--get", "branch.vileplume.merge")).toBe(
			"refs/heads/main",
		);
	});
	test("a recovered branch never fetches again, even when origin is unreachable", () => {
		const { root, git, run, unreachable, advanceRemoteMain } = fixture();
		run();
		const created = git("rev-parse", "HEAD");
		advanceRemoteMain("later remote work");
		writeFileSync(join(root, "file"), "local edits");
		run("main", unreachable);
		expect(git("rev-parse", "HEAD")).toBe(created);
		expect(readFileSync(join(root, "file"), "utf8")).toBe("local edits");
		expect(readFileSync(join(root, "repository-progress"), "utf8").trim()).toBe(
			"checking-repository",
		);
	});
	test("a failed base fetch fails visibly and a retry starts from the fresh fetch", () => {
		const { root, git, run, unreachable, advanceRemoteMain } = fixture();
		writeFileSync(join(root, "untracked"), "keep");
		expect(() => run("main", unreachable)).toThrow();
		expect(readFileSync(join(root, "repository-progress"), "utf8").trim()).toBe(
			"fetching-repository",
		);
		// Nothing was created from the stale cache, and local files are intact.
		expect(git("branch", "--show-current")).toBe("main");
		expect(() => git("rev-parse", "--verify", "vileplume")).toThrow();
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
		const latest = advanceRemoteMain("after outage");
		run();
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(git("rev-parse", "HEAD")).toBe(latest);
	});
	test("an unreachable origin with no cached base still fails", () => {
		const { git, run, unreachable } = fixture();
		expect(() => run("missing", unreachable)).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
	});
	test("does not reset existing branch commits", () => {
		const { root, git, run } = fixture();
		run();
		writeFileSync(join(root, "file"), "committed work");
		git("commit", "-am", "work");
		const head = git("rev-parse", "HEAD");
		run();
		expect(git("rev-parse", "HEAD")).toBe(head);
	});
	test("fails when the base is missing instead of starting on main", () => {
		const { git, run } = fixture();
		expect(() => run("missing")).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
	});
	test("fetches a fork PR head and preserves the checkout on retry", () => {
		const { root, git, run } = fixture();
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
		writeFileSync(join(root, "file"), "fork PR commit\n");
		git("commit", "-am", "fork PR");
		const prHead = git("rev-parse", "HEAD");
		git("push", remote, "HEAD:refs/pull/656/head");
		git("reset", "--hard", "HEAD~1");

		run("refs/pull/656/head", remote);
		expect(git("rev-parse", "HEAD")).toBe(prHead);
		expect(() => git("config", "--get", "branch.vileplume.remote")).toThrow();
		expect(readFileSync(join(root, "file"), "utf8")).toBe("fork PR commit\n");
		writeFileSync(join(root, "file"), "local work\n");
		run("refs/pull/656/head", remote);
		expect(git("rev-parse", "HEAD")).toBe(prHead);
		expect(readFileSync(join(root, "file"), "utf8")).toBe("local work\n");
	});
	test("fails when a fork PR head no longer exists", () => {
		const { root, git, run } = fixture();
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
		expect(() => run("refs/pull/656/head", remote)).toThrow();
		expect(readFileSync(join(root, "repository-progress"), "utf8").trim()).toBe(
			"fetching-repository",
		);
		expect(git("branch", "--show-current")).toBe("main");
	});
	test("recovers the target branch with conflicting edits intact", () => {
		const { root, git, run, remote } = fixture();
		run();
		writeFileSync(join(root, "file"), "target branch work\n");
		git("commit", "-am", "target work");
		const target = git("rev-parse", "HEAD");
		git("switch", "main");
		writeFileSync(join(root, "file"), "local edits\n");
		writeFileSync(join(root, "untracked"), "keep");
		git("remote", "set-url", "origin", "https://example.com/old.git");
		run();
		run();
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(git("rev-parse", "HEAD")).toBe(target);
		const content = readFileSync(join(root, "file"), "utf8");
		expect(content).toContain("<<<<<<<");
		expect(content).toContain("target branch work");
		expect(content).toContain("local edits");
		expect(git("ls-files", "--unmerged")).not.toBe("");
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
		expect(git("remote", "get-url", "origin")).toBe(remote);
	});
	test("does not discard staged edits when switching would conflict", () => {
		const { root, git, run } = fixture();
		run();
		writeFileSync(join(root, "file"), "target work\n");
		git("commit", "-am", "target work");
		git("switch", "main");
		writeFileSync(join(root, "file"), "staged work\n");
		git("add", "file");
		const index = git("diff", "--cached");
		expect(() => run()).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
		expect(git("diff", "--cached")).toBe(index);
		expect(readFileSync(join(root, "file"), "utf8")).toBe("staged work\n");
	});
});

test("custom snapshot startup preserves native remotes, staged and untracked files on repeated launch", () => {
	const { root, git, run } = fixture();
	git("remote", "set-url", "origin", "git@github.com:acme/repo.git");
	git("config", "credential.helper", "native-helper");
	writeFileSync(join(root, "file"), "staged");
	git("add", "file");
	writeFileSync(join(root, "file"), "working");
	writeFileSync(join(root, "untracked"), "keep");
	const head = git("rev-parse", "HEAD");
	run("HEAD", "https://github.com/acme/repo.git", false, true);
	run("HEAD", "https://github.com/acme/repo.git", false, true);
	expect(git("rev-parse", "HEAD")).toBe(head);
	expect(git("remote", "get-url", "origin")).toBe(
		"git@github.com:acme/repo.git",
	);
	expect(git("config", "credential.helper")).toBe("native-helper");
	expect(git("show", ":file")).toBe("staged");
	expect(readFileSync(join(root, "file"), "utf8")).toBe("working");
	expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
});
test("custom snapshot rejects a mismatched repository without mutating its checkout", () => {
	const { git, run } = fixture();
	const head = git("rev-parse", "HEAD");
	expect(() =>
		run("HEAD", "https://github.com/acme/other.git", false, true),
	).toThrow();
	expect(git("rev-parse", "HEAD")).toBe(head);
	expect(git("branch", "--show-current")).toBe("main");
});
