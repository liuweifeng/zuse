import { NodeRuntime } from "@effect/platform-node";
import { CredentialsServiceLive } from "@zusehq/server";
import {
	readDesktopEngineConfig,
	runDesktopEngine,
} from "@zusehq/server/desktop-engine/runtime";
import { secureStorageMasterKey } from "@zusehq/server/secure-storage-master-key";
import { Effect } from "effect";

const boot = Effect.gen(function* () {
	const path = process.argv[2];
	if (path === undefined)
		return yield* Effect.fail(
			new Error("Missing private engine configuration path."),
		);
	const config = yield* Effect.tryPromise(() => readDesktopEngineConfig(path));
	process.env.ZUSE_APP_VERSION = config.appVersion;
	yield* runDesktopEngine(config, {
		credentialsLayer: CredentialsServiceLive,
		modelConnectionMasterKey: secureStorageMasterKey,
	});
});
// A lost supervisor cannot leave a second unsupervised engine holding the database indefinitely.
if (process.send !== undefined)
	process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
NodeRuntime.runMain(boot);
