import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const script = new URL("../workspace-archive.sh", import.meta.url).pathname;
const run = (config, dataPath) =>
	new Promise((resolve, reject) => {
		const child = spawn("bash", [script], {
			env: {
				...process.env,
				ZUSE_USER_DATA: dataPath,
				ZUSE_ARCHIVE_CONFIG: JSON.stringify(config),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (bytes) => {
			stderr += bytes;
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, stderr }));
	});

test("populated workspace survives removal of its source, with fresh runtime identity", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-archive-"));
	t.after(async () => {
		await chmod(directory, 0o755);
		await rm(directory, { recursive: true, force: true });
	});
	const home = join(directory, "home");
	const dataPath = join(home, ".zuse-data");
	const repositoriesPath = join(directory, "repos");
	const repositoryPath = join(repositoriesPath, "owner/app");
	await mkdir(dataPath, { recursive: true });
	// Boat mounts its repository storage behind an absolute root symlink.
	await mkdir(`${repositoriesPath}-backing`, { recursive: true });
	await symlink(`${repositoriesPath}-backing`, repositoriesPath);
	await mkdir(repositoryPath, { recursive: true });
	await mkdir(join(home, ".claude/projects/project"), { recursive: true });
	await mkdir(join(home, ".codex/sessions"), { recursive: true });
	const database = new DatabaseSync(join(dataPath, "zuse.sqlite"));
	database.exec(
		"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE chats(id TEXT); CREATE TABLE sessions(id TEXT, provider_id TEXT); CREATE TABLE messages(id INTEGER, content TEXT); CREATE TABLE harness_executions(state TEXT); INSERT INTO chats VALUES('chat-original'); INSERT INTO sessions VALUES('session-original', 'codex'); INSERT INTO harness_executions VALUES('engine-mailbox-tool-receipt');",
	);
	for (let i = 0; i < 350; i++)
		database
			.prepare("INSERT INTO messages VALUES(?, ?)")
			.run(i, `original message ${i}`);
	// Keep a read-only connection open so committed WAL remains during backup.
	const reader = new DatabaseSync(join(dataPath, "zuse.sqlite"), {
		readOnly: true,
	});
	database.close();
	t.after(() => reader.close());
	await writeFile(
		join(dataPath, "attachment.png"),
		randomBytes(9 * 1024 * 1024),
	);
	const attachment = await readFile(join(dataPath, "attachment.png"));
	await writeFile(
		join(dataPath, "cloud-runtime-identity.json"),
		"old-machine-private-key",
	);
	await writeFile(join(dataPath, "cloud-runtime-credential"), "old-bearer");
	await writeFile(
		join(repositoryPath, "untracked.txt"),
		"not pushed to GitHub",
	);
	await writeFile(
		join(home, ".claude/projects/project/session.jsonl"),
		"native Claude history",
	);
	await writeFile(
		join(home, ".codex/sessions/rollout.jsonl"),
		"native Codex history",
	);
	await writeFile(
		join(home, ".codex/auth.json"),
		"refresh-token-must-not-be-copied",
	);
	const objects = new Map();
	let failUploads = true;
	const server = createServer(async (request, response) => {
		if (failUploads && request.method === "PUT") {
			request.resume();
			response.writeHead(503).end();
			return;
		}
		if (request.headers.authorization !== "Bearer scoped-test-capability") {
			response.writeHead(401).end();
			return;
		}
		const object = request.url.split("/").at(-1);
		if (request.method === "PUT") {
			const bytes = [];
			for await (const chunk of request) bytes.push(chunk);
			objects.set(object, Buffer.concat(bytes).toString());
			response.writeHead(204).end();
		} else if (objects.has(object)) response.end(objects.get(object));
		else response.writeHead(404).end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const config = {
		mode: "backup",
		operationId: "recovery-test",
		workspaceId: "workspace-test",
		chatId: "chat-original",
		sessionId: "session-original",
		home,
		repositoryPath,
		repositoriesPath,
		url: `http://127.0.0.1:${server.address().port}`,
		token: "scoped-test-capability",
		key: randomBytes(32).toString("base64url"),
	};
	const externalLink = join(repositoryPath, "external-link");
	await symlink(dataPath, externalLink);
	assert.equal(
		(await run(config, dataPath)).code,
		1,
		"resolving a managed root must not permit external links inside it",
	);
	assert.equal(objects.size, 0);
	await rm(externalLink);
	assert.equal(
		(await run(config, dataPath)).code,
		1,
		"interrupted uploads must not acknowledge a backup",
	);
	assert.equal(objects.has("manifest"), false);
	assert.equal(
		await readFile(join(repositoryPath, "untracked.txt"), "utf8"),
		"not pushed to GitHub",
	);
	failUploads = false;
	assert.equal((await run(config, dataPath)).code, 0);
	const manifest = JSON.parse(objects.get("manifest"));
	assert.ok(manifest.chunks.length >= 3);
	assert.ok(![...objects.values()].join("").includes("original message 349"));
	await rename(home, `${home}-deleted-source`);
	await rename(repositoriesPath, `${repositoriesPath}-deleted-source`);
	await mkdir(dataPath, { recursive: true });
	// Exercise the provider layout: the parent of /home/repos is root-owned.
	await mkdir(repositoriesPath, { recursive: true });
	await writeFile(
		join(repositoriesPath, "image-only.txt"),
		"preserve original image",
	);
	await chmod(directory, 0o555);
	const digest = manifest.chunks[0];
	const originalChunk = objects.get(digest);
	objects.set(digest, "corrupted transport");
	assert.equal((await run({ ...config, mode: "restore" }, dataPath)).code, 1);
	await assert.rejects(
		access(join(dataPath, "zuse.sqlite")),
		"corruption must not install a database",
	);
	objects.set(digest, originalChunk);
	const restored = await run({ ...config, mode: "restore" }, dataPath);
	assert.equal(restored.code, 0, restored.stderr);
	await chmod(directory, 0o755);
	const recovered = new DatabaseSync(join(dataPath, "zuse.sqlite"), {
		readOnly: true,
	});
	assert.equal(
		recovered.prepare("SELECT count(*) AS n FROM messages").get().n,
		350,
	);
	assert.equal(
		recovered.prepare("SELECT state FROM harness_executions").get().state,
		"engine-mailbox-tool-receipt",
	);
	recovered.close();
	assert.deepEqual(
		await readFile(join(dataPath, "attachment.png")),
		attachment,
	);
	assert.equal(
		await readFile(join(repositoryPath, "untracked.txt"), "utf8"),
		"not pushed to GitHub",
	);
	assert.equal(
		await readFile(
			join(
				repositoriesPath,
				".zuse-archive/recovery-test/previous/image-only.txt",
			),
			"utf8",
		),
		"preserve original image",
	);
	assert.equal(
		await readFile(
			join(home, ".claude/projects/project/session.jsonl"),
			"utf8",
		),
		"native Claude history",
	);
	assert.equal(
		await readFile(join(home, ".codex/sessions/rollout.jsonl"), "utf8"),
		"native Codex history",
	);
	await assert.rejects(access(join(dataPath, "cloud-runtime-identity.json")));
	await assert.rejects(access(join(dataPath, "cloud-runtime-credential")));
	await assert.rejects(access(join(home, ".codex/auth.json")));
	assert.equal(
		(await run({ ...config, mode: "restore" }, dataPath)).code,
		0,
		"restore retry is idempotent",
	);
	// A different attempt must not overwrite an authoritative database.
	await rm(join(home, ".zuse-recovery/recovery-test"), { recursive: true });
	assert.equal((await run({ ...config, mode: "restore" }, dataPath)).code, 1);
	assert.equal(
		await readFile(join(repositoryPath, "untracked.txt"), "utf8"),
		"not pushed to GitHub",
	);
});
