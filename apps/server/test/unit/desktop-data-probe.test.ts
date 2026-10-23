import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
	new URL("../../scripts/desktop-data-probe.ts", import.meta.url),
);
const probe = (directory: string, stage: string) =>
	spawnSync(process.execPath, ["--import", "tsx", script, directory, stage], {
		encoding: "utf8",
		timeout: 20_000,
	});
const pass = (directory: string, stage: string) => {
	const result = probe(directory, stage);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain(`${stage} passed`);
};

it("round-trips coordinator state, versions and receipts and writes after returning to Preview", () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-desktop-compat-"));
	try {
		for (const stage of [
			"stable-create",
			"preview",
			"stable-return",
			"preview-return",
		])
			pass(directory, stage);
		const db = new DatabaseSync(join(directory, "zuse.sqlite"));
		try {
			expect(
				db
					.prepare(
						"SELECT version FROM master_artifacts WHERE artifact_id = 'memory/testing.md' ORDER BY version",
					)
					.all()
					.map((row) => row.version),
			).toEqual([1, 2, 3]);
			expect(
				db
					.prepare(
						"SELECT phase FROM master_commands WHERE command_id = 'compat-master-return-write'",
					)
					.get()?.phase,
			).toBe("done");
			expect(
				db
					.prepare("SELECT title FROM chats WHERE id = 'compat-stable-return'")
					.get()?.title,
			).toBe("stable-return");
		} finally {
			db.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 30_000);

it.each([
	"UPDATE master_artifacts SET content = 'lost evidence' WHERE artifact_id = 'memory/testing.md' AND version = 1",
	"DELETE FROM master_commands WHERE command_id = 'compat-master-publish'",
	"DELETE FROM master_revisions WHERE revision = 1",
])("rejects lost Preview data before Stable writes ordinary chats: %s", (mutation) => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-desktop-compat-loss-"));
	try {
		pass(directory, "stable-create");
		pass(directory, "preview");
		const db = new DatabaseSync(join(directory, "zuse.sqlite"));
		try {
			db.exec(mutation);
		} finally {
			db.close();
		}
		const result = probe(directory, "stable-return");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"Preview Master data changed while using Stable",
		);
		const checked = new DatabaseSync(join(directory, "zuse.sqlite"));
		try {
			expect(
				checked
					.prepare("SELECT id FROM chats WHERE id = 'compat-stable-return'")
					.get(),
			).toBeUndefined();
		} finally {
			checked.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 30_000);
