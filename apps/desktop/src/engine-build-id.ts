import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";

/** Include both executables and the native runtime ABI, independently of release labels. */
export const readEngineBuildId = async (
	supervisorPath: string,
): Promise<string> => {
	const hash = createHash("sha256");
	hash.update(
		`${process.platform}\0${process.arch}\0${process.versions.modules}\0`,
	);
	for (const path of [
		supervisorPath,
		join(dirname(supervisorPath), "engine-main.cjs"),
	]) {
		const file = createHash("sha256");
		for await (const chunk of createReadStream(path)) file.update(chunk);
		hash.update(file.digest());
	}
	return hash.digest("hex");
};

export const verifyEngineBuild = async (
	expected: string | undefined,
	supervisorPath: string,
): Promise<void> => {
	if (
		expected !== undefined &&
		(await readEngineBuildId(supervisorPath)) !== expected
	)
		throw new Error(
			"The engine files changed since launch was prepared. Restart the desktop to load this build.",
		);
};
