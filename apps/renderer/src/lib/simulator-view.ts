import "@zuse/i18n/english/simulators";
import type {
	SimulatorRequirement,
	SimulatorState,
	SimulatorSummary,
} from "@zuse/contracts";
import { message } from "@zuse/i18n";

/**
 * Presentation model shared by the dock pane and Settings so both describe
 * one simulator host the same way.
 */
export type SimulatorPhase =
	| "loading"
	| "offline"
	| "setup"
	| "preparing"
	| "failed"
	| "ready";

export function simulatorPhase(
	state: SimulatorState | null,
	sync: string,
): SimulatorPhase {
	if (!state) return sync === "failed" ? "offline" : "loading";
	if (
		!state.enabled ||
		(state.status === "unavailable" &&
			state.requirements.some((item) => item.id === "android-java" && !item.ok))
	)
		return "setup";
	if (state.status === "ready") return "ready";
	if (state.status === "error" || state.status === "unavailable")
		return "failed";
	return "preparing";
}

/** Labels resolve at call time so they follow the current interface language. */
export function requirementLabel(id: SimulatorRequirement["id"]): string {
	switch (id) {
		case "xcode":
			return message("simulators:requirement_xcode");
		case "runtime":
			return message("simulators:requirement_runtime");
		case "android-java":
			return message("simulators:requirement_android_java");
		case "android-sdk":
			return message("simulators:requirement_android_sdk");
		case "android-avd":
			return message("simulators:requirement_android_avd");
		case "node":
			return message("simulators:requirement_node");
	}
}

export function platformLabel(
	platform: SimulatorRequirement["platform"],
): string {
	return message(
		platform === "ios"
			? "simulators:platform_ios"
			: platform === "android"
				? "simulators:platform_android"
				: "simulators:platform_all",
	);
}

/** Requirements in display order, grouped by the platform they serve. */
export function requirementSections(
	requirements: ReadonlyArray<SimulatorRequirement>,
): ReadonlyArray<{
	readonly platform: SimulatorRequirement["platform"];
	readonly items: ReadonlyArray<SimulatorRequirement>;
}> {
	return (["ios", "android", "all"] as const)
		.map((platform) => ({
			platform,
			items: requirements.filter((item) => item.platform === platform),
		}))
		.filter((section) => section.items.length > 0);
}

const platformReady = (state: SimulatorState, id: "xcode" | "android-sdk") =>
	state.requirements.some((item) => item.id === id && item.ok);

/**
 * Setup needs Node and at least one platform. A missing iOS runtime or
 * Android emulator is not blocking; the device list explains it instead.
 */
export const requirementsBlocked = (state: SimulatorState) =>
	// An unchecked host is pending, not blocked.
	state.requirements.length > 0 &&
	(state.requirements.some((item) => item.id === "node" && !item.ok) ||
		(!platformReady(state, "xcode") && !platformReady(state, "android-sdk")));

/** Which platforms this host can run right now. */
export function readyPlatforms(state: SimulatorState) {
	return {
		ios: platformReady(state, "xcode"),
		android: platformReady(state, "android-sdk"),
	};
}

export type SetupStepState = "done" | "active" | "pending" | "failed";
export type SetupStep = {
	readonly label: string;
	readonly state: SetupStepState;
};

const HUB_STEPS = ["checking", "installing", "starting", "ready"] as const;

/** Linear setup progress derived from the host status; nothing is tracked client-side. */
export function setupSteps(state: SimulatorState): ReadonlyArray<SetupStep> {
	const failed = state.status === "error" || state.status === "unavailable";
	const current = HUB_STEPS.indexOf(state.status as (typeof HUB_STEPS)[number]);
	// A failure belongs to the first step that had not completed.
	const failedAt = failed
		? requirementsBlocked(state) || state.requirements.length === 0
			? 0
			: 1
		: -1;
	const step = (index: number, label: string): SetupStep => ({
		label,
		state:
			failedAt === index
				? "failed"
				: failedAt >= 0
					? index < failedAt
						? "done"
						: "pending"
					: index < current || state.status === "ready"
						? "done"
						: index === current
							? "active"
							: "pending",
	});
	const steps = [
		step(0, message("simulators:step_check")),
		step(
			1,
			message("simulators:step_install_hub", { version: state.tools.hub }),
		),
		step(2, message("simulators:step_start_hub")),
		step(3, message("simulators:step_find")),
	];
	if (!state.agentAccessEnabled) return steps;
	return [
		...steps,
		{
			label: message("simulators:step_install_agent", {
				version: state.tools.agent,
			}),
			state:
				state.agentStatus === "ready"
					? "done"
					: state.agentStatus === "error"
						? "failed"
						: state.agentStatus === "installing"
							? "active"
							: "pending",
		},
	];
}

export type SimulatorGroup = {
	readonly platform: SimulatorSummary["platform"];
	readonly runtime: string;
	readonly devices: ReadonlyArray<SimulatorSummary>;
};

const versionNumbers = (runtime: string) =>
	(runtime.match(/\d+/gu) ?? []).map(Number);

/** iOS before Android, newest runtime first; running devices lead their group. */
export function groupSimulators(
	devices: ReadonlyArray<SimulatorSummary>,
): ReadonlyArray<SimulatorGroup> {
	const groups = new Map<string, SimulatorSummary[]>();
	for (const device of devices) {
		const key = `${device.platform}\u0000${device.version}`;
		const list = groups.get(key) ?? [];
		list.push(device);
		groups.set(key, list);
	}
	const platformOrder = { ios: 0, android: 1 };
	return [...groups]
		.map(([, list]) => list)
		.sort((x, y) => {
			const [a, b] = [x[0], y[0]];
			if (!a || !b) return 0;
			if (a.platform !== b.platform)
				return platformOrder[a.platform] - platformOrder[b.platform];
			const left = versionNumbers(a.version),
				right = versionNumbers(b.version);
			for (let i = 0; i < Math.max(left.length, right.length); i++) {
				const delta = (right[i] ?? 0) - (left[i] ?? 0);
				if (delta !== 0) return delta;
			}
			return a.version.localeCompare(b.version);
		})
		.map((list) => ({
			platform: list[0]?.platform ?? "ios",
			runtime: list[0]?.version ?? "",
			devices: list.sort(
				(a, b) =>
					Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name),
			),
		}));
}

/** One-line host summary used by Settings and status rows. */
export function simulatorSummary(state: SimulatorState): string {
	switch (simulatorPhase(state, "live")) {
		case "setup":
			return message("simulators:status_off");
		case "preparing":
			return state.status === "idle"
				? message("simulators:summary_idle")
				: state.detail;
		case "failed":
			return state.detail;
		case "ready": {
			const running = state.devices.filter((device) => device.booted).length;
			const devices = message("simulators:summary_devices", {
				count: state.devices.length,
			});
			return running
				? message("simulators:summary_running", { devices, count: running })
				: devices;
		}
		default:
			return "";
	}
}
