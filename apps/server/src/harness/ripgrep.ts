import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Reuse the platform ripgrep already shipped with Zuse's bundled Cursor SDK. */
export function resolveHarnessRipgrep(): string {
	try {
		const require = createRequire(import.meta.url);
		const sdkRequire = createRequire(require.resolve("@cursor/sdk"));
		const manifest = sdkRequire.resolve(
			`@cursor/sdk-${process.platform}-${process.arch}/package.json`,
		);
		const binary = join(
			dirname(manifest),
			"bin",
			process.platform === "win32" ? "rg.exe" : "rg",
		).replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
		accessSync(binary, constants.X_OK);
		return binary;
	} catch {
		return "rg";
	}
}
