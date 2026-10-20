import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetupCardView } from "../../src/components/worktree-setup-card.tsx";
import setupCardSource from "../../src/components/worktree-setup-card.tsx?raw";
import { workspaceCreationProgressIsActive } from "../../src/lib/setup-card-visibility.ts";

describe("setup card startup handoff", () => {
	it("does not use chat creation or agent activity to keep workspace progress mounted", () => {
		expect(setupCardSource).not.toContain(
			"creationPending: pendingCreation !== null",
		);
		expect(setupCardSource).not.toContain("agentStarting !== undefined");
		expect(setupCardSource).not.toContain("Starting agent…");
	});

	it("hands stale creation state off once the worktree itself is ready", () => {
		expect(
			workspaceCreationProgressIsActive({
				workspaceRequested: true,
				setupStatus: "skipped",
				creationPhase: "persisted",
			}),
		).toBe(false);
		expect(
			workspaceCreationProgressIsActive({
				workspaceRequested: true,
				setupStatus: null,
				creationPhase: "starting_agent",
			}),
		).toBe(false);
	});

	it("does not leave an interrupted or cancelled setup looking active", () => {
		for (const creationPhase of ["failed", "cancelled"] as const) {
			expect(
				workspaceCreationProgressIsActive({
					workspaceRequested: true,
					setupStatus: "running",
					creationPhase,
				}),
			).toBe(false);
		}
	});
});

it("keeps failed background setup collapsed with optional logs and retry", () => {
	const html = renderToStaticMarkup(
		createElement(SetupCardView, {
			data: {
				repoName: "zuse",
				hasWorktree: true,
				worktreePending: false,
				worktreeName: "test",
				branch: "test",
				baseBranch: "main",
				setupStatus: "failed",
				setupOutput: "install failed\n".repeat(500),
				onRerun: () => {},
			},
		}),
	);
	expect(html).toContain("Environment setup failed");
	expect(html).toContain("Rerun setup");
	expect(html).not.toMatch(/<details[^>]*\bopen=/);
});
