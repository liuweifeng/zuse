import { createHash } from "node:crypto";
import { type BigIntStats, createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

const MAX_ENTRIES = 20_000;
const MAX_AGE_MS = 5 * 60_000;
const signature = (info: BigIntStats): string =>
	[info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(
		":",
	);

const digestFile = async (path: string): Promise<string> => {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
};

/** Reuse verified bytes only while their filesystem identity is unchanged. */
export class SyncFileVerifier {
	private readonly verified = new Map<
		string,
		{ signature: string; hash: string; checkedAt: number; stable: boolean }
	>();

	constructor(
		private readonly readDigest = digestFile,
		private readonly now = () => performance.now(),
	) {}

	async digest(path: string): Promise<string> {
		const before = await lstat(path, { bigint: true });
		if (!before.isFile()) {
			this.verified.delete(path);
			throw new Error("Sync verification requires a regular file.");
		}
		const stamp = signature(before);
		const cached = this.verified.get(path);
		if (
			cached?.signature === stamp &&
			cached.stable &&
			this.now() - cached.checkedAt < MAX_AGE_MS
		) {
			this.verified.delete(path);
			this.verified.set(path, cached);
			return cached.hash;
		}
		this.verified.delete(path);

		const safeBefore = BigInt(Date.now() - 1_000) * 1_000_000n;
		const stable = before.ctimeNs < safeBefore && before.mtimeNs < safeBefore;
		const hash = await this.readDigest(path);
		const after = await lstat(path, { bigint: true });
		if (signature(after) !== stamp)
			throw new Error("File changed during sync verification; retrying.");
		if (this.verified.size >= MAX_ENTRIES) {
			const oldest = this.verified.keys().next().value;
			if (oldest !== undefined) this.verified.delete(oldest);
		}
		this.verified.set(path, {
			signature: stamp,
			hash,
			checkedAt: this.now(),
			stable,
		});
		return hash;
	}
}
