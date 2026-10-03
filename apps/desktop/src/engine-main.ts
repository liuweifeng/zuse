import { NodeRuntime } from "@effect/platform-node";
import { CredentialsServiceLive } from "@zusehq/server";
import {
	readDesktopEngineConfig,
	runDesktopEngine,
} from "@zusehq/server/desktop-engine/runtime";
import { secureStorageMasterKey } from "@zusehq/server/secure-storage-master-key";
import { Effect } from "effect";
import { ComputerAwakeController } from "./computer-awake-controller.ts";
import {
	readComputerAwakePreference,
	watchComputerAwakePreference,
} from "./computer-awake-preference.ts";

const boot = Effect.gen(function* () {
	const path = process.argv[2];
	if (path === undefined)
		return yield* Effect.fail(
			new Error("Missing private engine configuration path."),
		);
	const config = yield* Effect.tryPromise(() => readDesktopEngineConfig(path));
	process.env.ZUSE_APP_VERSION = config.appVersion;
	const initialMode = yield* Effect.promise(() =>
		readComputerAwakePreference(config.userData),
	);
	const awake = yield* Effect.acquireRelease(
		Effect.sync(() => new ComputerAwakeController({ initialMode })),
		(controller) => Effect.sync(() => controller.dispose()),
	);
	if (process.platform === "darwin")
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				watchComputerAwakePreference(config.userData, (mode) =>
					awake.setMode(mode),
				),
			),
			(stop) => Effect.sync(stop),
		);
	let remoteClients = 0;
	yield* runDesktopEngine(config, {
		credentialsLayer: CredentialsServiceLive,
		modelConnectionMasterKey: secureStorageMasterKey,
		onActiveTurns: (count) => awake.setActiveAgents(count),
		onRemoteConnection: () => {
			awake.setRemoteClients(++remoteClients);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				awake.setRemoteClients(--remoteClients);
			};
		},
	});
});
// A lost supervisor cannot leave a second unsupervised engine holding the database indefinitely.
if (process.send !== undefined)
	process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
NodeRuntime.runMain(Effect.scoped(boot));
