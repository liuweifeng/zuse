import { Effect, Redacted, Schema } from "effect";
import { boxProcessScript } from "./box-process.ts";
import { discardResponseBody } from "./http-response.ts";
import {
	type ProviderSandbox,
	type SandboxNetworkPolicy,
	type SandboxProviderAdapter,
	SandboxProviderError,
} from "./index.ts";
import { processShellQuote as quote } from "./process-activation.ts";
import {
	processGroupCommand,
	processGroupInspectionCommand,
} from "./process-group.ts";
import { providerError, validatedEnv } from "./provider-input.ts";

export const DAYTONA_PROVIDER_ID = "daytona";
export interface DaytonaSandboxConfig {
	readonly apiKey: Redacted.Redacted<string>;
	readonly templateId: string;
	readonly templateVersion: string;
	readonly target?: string;
	readonly apiBaseUrl?: string;
	readonly resources?: {
		readonly vcpuCount: number;
		readonly memoryMib: number;
	};
}
const Detail = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	state: Schema.String,
});
const Snapshot = Schema.Struct({ id: Schema.String, state: Schema.String });
const Url = Schema.Struct({
	url: Schema.String.check(
		Schema.makeFilter((value) => {
			if (!URL.canParse(value)) return false;
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password;
		}),
	),
});
const Execution = Schema.Struct({
	exitCode: Schema.optionalKey(Schema.Number),
	code: Schema.optionalKey(Schema.Number),
	result: Schema.optionalKey(Schema.String),
});
// Ordinary placements use provider-default egress. Live machine forks, which
// require quarantine, are not supported by this adapter.
const validateNetwork = (network: SandboxNetworkPolicy) =>
	network.kind === "open"
		? Effect.void
		: Effect.fail(providerError("rejected"));
const statusError = (status: number) =>
	providerError(
		status === 404
			? "not-found"
			: status === 408 || status === 409 || status === 429 || status >= 500
				? "transient"
				: "rejected",
	);

/** REST transport keeps the adapter usable inside Workers without a Node SDK. */
export const makeDaytonaSandboxProvider = (
	config: DaytonaSandboxConfig,
	http: Pick<typeof globalThis, "fetch"> = globalThis,
): SandboxProviderAdapter => {
	const base = (config.apiBaseUrl ?? "https://app.daytona.io/api").replace(
		/\/+$/,
		"",
	);
	const path = (id: string) => `/sandbox/${encodeURIComponent(id)}`;
	const send = Effect.fn("Daytona.send")(function* (
		method: string,
		url: string,
		body?: unknown,
	) {
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				http.fetch(url, {
					method,
					signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
					// Workers supports manual, but not error. Reject 3xx below without
					// forwarding the API key to a redirect target.
					redirect: "manual",
					headers: {
						Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => providerError("transient"),
		});
		if (!response.ok) {
			if (response.status === 400) {
				const body = yield* Effect.tryPromise({
					try: (): Promise<unknown> => response.json(),
					catch: () => providerError("transient"),
				}).pipe(Effect.orElseSucceed(() => null));
				const message =
					typeof body === "object" && body !== null && "message" in body
						? body.message
						: undefined;
				if (
					typeof message === "string" &&
					message.startsWith(
						"Network access is restricted and cannot be overridden",
					)
				)
					return yield* new SandboxProviderError({
						code: "rejected",
						diagnostic: "daytona-network-controls-unavailable",
					});
				if (
					typeof message === "string" &&
					message.includes("does not have a default region")
				)
					return yield* new SandboxProviderError({
						code: "rejected",
						diagnostic: "daytona-default-region-required",
					});
			}
			yield* discardResponseBody(response);
			return yield* statusError(response.status);
		}
		return response;
	});
	const request = <A, I>(
		method: string,
		route: string,
		schema: Schema.Codec<A, I>,
		body?: unknown,
	) =>
		send(method, `${base}${route}`, body).pipe(
			Effect.flatMap((response) =>
				Effect.tryPromise({
					try: (): Promise<unknown> => response.json(),
					catch: () => providerError("transient"),
				}),
			),
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
			Effect.mapError((error) =>
				error instanceof SandboxProviderError
					? error
					: providerError("transient"),
			),
		);
	const requestVoid = (method: string, route: string, body?: unknown) =>
		send(method, `${base}${route}`, body).pipe(
			Effect.flatMap(discardResponseBody),
		);
	const missingAsNull = <A>(effect: Effect.Effect<A, SandboxProviderError>) =>
		effect.pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed(null) : Effect.fail(error),
			),
		);
	const detail = (id: string) => request("GET", path(id), Detail);
	const observed = (
		d: typeof Detail.Type,
	): Effect.Effect<ProviderSandbox | null, SandboxProviderError> => {
		if (d.state === "destroyed") return Effect.succeed(null);
		const state =
			d.state === "started"
				? "running"
				: ["stopped", "paused", "archived"].includes(d.state)
					? "paused"
					: undefined;
		return state === undefined
			? Effect.fail(providerError("transient"))
			: Effect.succeed({
					providerSandboxId: d.id,
					providerLabel: d.name,
					state,
				});
	};
	const inspect = (id: string) =>
		missingAsNull(detail(id).pipe(Effect.flatMap(observed)));
	const waitState = Effect.fn("Daytona.waitState")(function* (
		id: string,
		expected: string,
	) {
		for (let attempt = 0; attempt < 120; attempt++) {
			const d = yield* detail(id);
			if (d.state === expected) return d;
			if (["error", "build_failed", "destroyed"].includes(d.state))
				return yield* providerError("rejected");
			yield* Effect.sleep("1 second");
		}
		return yield* providerError("transient");
	});
	const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
	const timer = Effect.fn("Daytona.timer")(function* (
		id: string,
		seconds: number,
		onTimeout?: "pause" | "terminate",
	) {
		if (!Number.isFinite(seconds) || seconds <= 0)
			return yield* providerError("rejected");
		yield* requestVoid("POST", `${path(id)}/autostop/${minutes(seconds)}`);
		if (onTimeout !== undefined)
			yield* requestVoid(
				"POST",
				`${path(id)}/autodelete/${onTimeout === "terminate" ? 1 : -1}`,
			);
		yield* requestVoid("POST", `${path(id)}/last-activity`);
	});
	const allocate = Effect.fn("Daytona.allocate")(function* (
		input: Parameters<SandboxProviderAdapter["create"]>[0],
		snapshot: string,
	) {
		yield* validatedEnv(input.env);
		yield* validateNetwork(input.network);
		if (input.sizeId !== undefined && input.sizeId !== "standard")
			return yield* providerError("rejected");
		if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0)
			return yield* providerError("rejected");
		const created = yield* request("POST", "/sandbox", Detail, {
			name: input.providerLabel,
			snapshot,
			target: config.target,
			user: "root",
			env: input.env,
			labels: { ...input.metadata, "zuse-sandbox-id": input.sandboxId },
			public: false,
			autoStopInterval: minutes(input.timeoutSeconds),
			autoPauseInterval: 0,
			// Zero makes the sandbox irreversibly ephemeral, preventing image capture.
			autoDeleteInterval: input.onTimeout === "terminate" ? 1 : -1,
		});
		const ready = yield* waitState(created.id, "started");
		return {
			providerSandboxId: ready.id,
			providerLabel: ready.name,
			state: "running" as const,
		};
	});
	const execute = Effect.fn("Daytona.execute")(function* (
		id: string,
		command: string,
	) {
		const proxy = yield* request("GET", `${path(id)}/toolbox-proxy-url`, Url);
		const response = yield* send(
			"POST",
			`${proxy.url.replace(/\/+$/, "")}/${encodeURIComponent(id)}/process/execute`,
			{ command, timeout: 60 },
		);
		const data = yield* Effect.tryPromise({
			try: (): Promise<unknown> => response.json(),
			catch: () => providerError("transient"),
		});
		const result = yield* Schema.decodeUnknownEffect(Execution)(data).pipe(
			Effect.mapError(() => providerError("transient")),
		);
		const exitCode = result.exitCode ?? result.code;
		if (exitCode === undefined) return yield* providerError("transient");
		return { exitCode, stdout: result.result ?? "" };
	});
	const checked = (id: string, command: string) =>
		execute(id, command).pipe(
			Effect.flatMap((result) =>
				result.exitCode === 0
					? Effect.succeed(result.stdout)
					: Effect.fail(providerError("transient")),
			),
		);
	const asUser = (command: string, user = "zuse") =>
		`sudo -n -H -u ${quote(user)} bash -c ${quote(command)}`;
	const runProcess: NonNullable<SandboxProviderAdapter["runProcess"]> = (
		id,
		input,
	) =>
		validatedEnv(input.env ?? {}).pipe(
			Effect.flatMap(() =>
				execute(id, asUser(boxProcessScript(input), input.user)),
			),
			Effect.flatMap((result) =>
				new TextEncoder().encode(result.stdout).length <= 65_536
					? Effect.succeed(result)
					: Effect.fail(providerError("transient")),
			),
		);
	const managed = Effect.fn("Daytona.managed")(function* (
		id: string,
		input: Parameters<SandboxProviderAdapter["startProcess"]>[1],
		selector?: Parameters<SandboxProviderAdapter["replaceProcess"]>[1],
	) {
		yield* validatedEnv(input.env ?? {});
		const command = yield* Effect.try({
			try: () =>
				processGroupCommand(
					{
						...input,
						user: input.user ?? "zuse",
						tag: input.tag ?? `zuse-${crypto.randomUUID()}`,
					},
					selector,
				),
			catch: () => providerError("rejected"),
		});
		yield* checked(id, command);
	});
	const pause = Effect.fn("Daytona.pause")(function* (id: string) {
		const d = yield* detail(id);
		if (["stopped", "archived"].includes(d.state)) return;
		// Explicit pause and image capture must preserve disk even for builders
		// configured to delete themselves after an inactivity timeout.
		yield* requestVoid("POST", `${path(id)}/autodelete/-1`);
		if (d.state !== "stopping") yield* requestVoid("POST", `${path(id)}/stop`);
		yield* waitState(id, "stopped");
	});
	const snapshotState = (id: string) =>
		missingAsNull(
			request("GET", `/snapshots/${encodeURIComponent(id)}`, Snapshot),
		);
	const resources = config.resources ?? { vcpuCount: 2, memoryMib: 4096 };
	return {
		providerId: DAYTONA_PROVIDER_ID,
		displayName: "Daytona",
		templateVersion: config.templateVersion,
		resources,
		sizes: [{ sizeId: "standard", displayName: "Standard", ...resources }],
		preservesProcessesOnResume: false,
		supportsFencedProcessReplacement: true,
		withCredentials: (credentials) =>
			makeDaytonaSandboxProvider(
				{
					...config,
					apiKey: credentials.apiKey,
					templateId: credentials.templateId ?? config.templateId,
				},
				http,
			),
		create: (input) => allocate(input, config.templateId),
		fork: (input) => allocate(input, input.snapshotId),
		inspect,
		recoverByLabel: inspect,
		runProcess,
		startProcess: (id, input) =>
			input.tag === undefined
				? runProcess(id, input).pipe(
						Effect.flatMap((result) =>
							result.exitCode === 0
								? Effect.void
								: Effect.fail(providerError("transient")),
						),
					)
				: managed(id, input),
		replaceProcess: (id, selector, input) => managed(id, input, selector),
		inspectProcess: (id, selector, user = "zuse") =>
			execute(id, processGroupInspectionCommand(selector, user)).pipe(
				Effect.map((result) =>
					result.exitCode === 0 &&
					(result.stdout === "active" || result.stdout === "inactive")
						? result.stdout
						: "unknown",
				),
			),
		pathExists: (id, file, user) =>
			execute(
				id,
				asUser(
					`if test -e ${quote(file)}; then printf present; else printf missing; fi`,
					user,
				),
			).pipe(
				Effect.flatMap((result) =>
					result.exitCode === 0 &&
					["present", "missing"].includes(result.stdout)
						? Effect.succeed(result.stdout === "present")
						: Effect.fail(providerError("transient")),
				),
			),
		readTextFile: (id, file, user) =>
			checked(
				id,
				asUser(
					`test "$(wc -c < ${quote(file)})" -le 65536 && cat -- ${quote(file)}`,
					user,
				),
			),
		writeTextFile: (id, file, contents, user) =>
			new TextEncoder().encode(contents).length > 65536
				? Effect.fail(providerError("rejected"))
				: checked(
						id,
						asUser(
							`umask 077; printf %s ${quote(contents)} > ${quote(file)}`,
							user,
						),
					).pipe(Effect.asVoid),
		resolveEndpoint: (id, port) =>
			request(
				"GET",
				`${path(id)}/ports/${port}/signed-preview-url?expiresInSeconds=3600`,
				Url,
			).pipe(
				Effect.map(({ url }) => ({
					httpBaseUrl: url,
					wsBaseUrl: url.replace(/^https:/, "wss:"),
				})),
			),
		pause,
		resume: Effect.fn("Daytona.resume")(
			function* (id, seconds, onTimeout, sizeId) {
				if (sizeId !== undefined && sizeId !== "standard")
					return yield* providerError("rejected");
				const d = yield* detail(id);
				yield* timer(id, seconds, onTimeout);
				if (d.state !== "started")
					yield* requestVoid("POST", `${path(id)}/start`);
				const ready = yield* waitState(id, "started");
				return {
					providerSandboxId: ready.id,
					providerLabel: ready.name,
					state: "running" as const,
					processContinuity:
						d.state === "started" ? ("unknown" as const) : ("lost" as const),
				};
			},
		),
		extendTimeout: (id, seconds) => timer(id, seconds),
		setNetwork: (_id, network) => validateNetwork(network),
		snapshot: Effect.fn("Daytona.snapshot")(function* (id, name) {
			const existing = yield* snapshotState(name);
			if (existing === null) {
				yield* pause(id);
				yield* requestVoid("POST", `${path(id)}/snapshot`, { name });
			}
			for (let attempt = 0; attempt < 120; attempt++) {
				const current = yield* snapshotState(name);
				if (current?.state === "active") return current.id;
				if (current?.state === "error" || current?.state === "build_failed")
					return yield* providerError("rejected");
				yield* Effect.sleep("1 second");
			}
			return yield* providerError("transient");
		}),
		inspectSnapshot: (id) =>
			snapshotState(id).pipe(
				Effect.map((s) =>
					s === null
						? null
						: s.state === "active"
							? "ready"
							: ["error", "build_failed"].includes(s.state)
								? "failed"
								: "saving",
				),
			),
		kill: (id) =>
			missingAsNull(requestVoid("DELETE", path(id))).pipe(Effect.asVoid),
		deleteSnapshot: Effect.fn("Daytona.deleteSnapshot")(function* (id) {
			// Reads accept names, but Daytona's DELETE endpoint requires the UUID.
			const snapshot = yield* snapshotState(id);
			if (snapshot === null) return;
			yield* missingAsNull(
				requestVoid("DELETE", `/snapshots/${encodeURIComponent(snapshot.id)}`),
			);
		}),
	};
};
