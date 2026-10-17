import "@zuse/i18n/english/simulators";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId, SimulatorState } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useId, useRef, useState } from "react";
import {
	useSimulatorActions,
	useSimulatorState,
} from "~/lib/simulator-client-bus.ts";
import {
	requirementsBlocked,
	setupSteps,
	simulatorPhase,
} from "~/lib/simulator-view.ts";
import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Switch } from "../ui/switch.tsx";
import {
	RequirementList,
	SimulatorError,
	SimulatorStage,
	StepList,
	useRequirementFix,
} from "./simulator-parts.tsx";
import { SimulatorPicker } from "./simulator-picker.tsx";
import { SimulatorViewer } from "./simulator-viewer.tsx";

/**
 * One dock tab. Without a `deviceId` the tab is a picker; choosing a simulator
 * turns it into that simulator's viewer. Setup states replace both until the
 * environment's simulator host is ready.
 */
export function SimulatorPane({
	refTarget,
	panelRef = refTarget,
	panelId,
	deviceId,
	active,
}: {
	refTarget: ChatRef;
	panelRef?: ChatRef;
	panelId: string;
	deviceId?: string;
	active: boolean;
}) {
	const { message } = useMessages(["simulators"]);
	const view = useSimulatorState(refTarget.environmentId);
	const state = view.data;
	const phase = simulatorPhase(state, view.sync);
	switch (phase) {
		case "loading":
			return (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-4 text-muted-foreground" />
				</div>
			);
		case "offline":
			return (
				<SimulatorStage
					title={message("simulators:offline_title")}
					description={message("simulators:offline_description")}
				/>
			);
	}
	if (!state) return null;
	if (phase === "setup")
		return (
			<SimulatorSetup environmentId={refTarget.environmentId} state={state} />
		);
	if (phase === "preparing")
		return (
			<SimulatorPreparing
				environmentId={refTarget.environmentId}
				state={state}
				active={active}
			/>
		);
	if (phase === "failed")
		return (
			<SimulatorFailed environmentId={refTarget.environmentId} state={state} />
		);
	const session = deviceId
		? state.sessions.find(
				(item) =>
					item.chatId === refTarget.chatId && item.deviceId === deviceId,
			)
		: undefined;
	const device = state.devices.find((item) => item.id === deviceId);
	return session && device ? (
		<SimulatorViewer
			refTarget={refTarget}
			panelRef={panelRef}
			panelId={panelId}
			device={device}
			state={state}
			active={active}
		/>
	) : (
		<SimulatorPicker
			refTarget={refTarget}
			panelRef={panelRef}
			panelId={panelId}
			state={state}
			reopening={deviceId !== undefined}
		/>
	);
}

function SimulatorSetup({
	environmentId,
	state,
}: {
	environmentId: EnvironmentId;
	state: SimulatorState;
}) {
	const { message } = useMessages(["simulators"]);
	const actions = useSimulatorActions(environmentId);
	const [agents, setAgents] = useState(state.agentAccessEnabled);
	const agentsSwitchId = useId();
	const checked = useRef(false);
	// The host check is read-only: it never installs or starts helpers.
	useEffect(() => {
		if (checked.current || state.requirements.length > 0) return;
		checked.current = true;
		void actions.run("simulators.refresh", {}, "check");
	}, [actions.run, state.requirements.length]);
	const fix = useRequirementFix(actions, state.requirements);
	const checking = state.requirements.length === 0 && !actions.error;
	const blocked = requirementsBlocked(state);
	// iOS rows exist only on a Mac, so other hosts describe Android alone.
	const ios =
		state.requirements.length === 0 ||
		state.requirements.some((item) => item.platform === "ios");
	return (
		<SimulatorStage
			title={message("simulators:setup_title")}
			description={message(
				ios
					? "simulators:setup_description_both"
					: "simulators:setup_description_android",
			)}
		>
			<RequirementList requirements={state.requirements} fix={fix} />
			<label
				htmlFor={agentsSwitchId}
				className="flex cursor-pointer items-start gap-3 px-1"
			>
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium text-foreground">
						{message("simulators:agents_toggle")}
					</p>
					<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
						{message("simulators:agents_toggle_description")}
					</p>
				</div>
				<Switch
					id={agentsSwitchId}
					checked={agents}
					onCheckedChange={setAgents}
					aria-label={message("simulators:agents_toggle")}
				/>
			</label>
			<div className="flex flex-col gap-2">
				{blocked ? (
					<Button
						variant="outline"
						className="w-full"
						loading={actions.pending === "check"}
						onClick={() => void actions.run("simulators.refresh", {}, "check")}
					>
						{message("simulators:check_again")}
					</Button>
				) : (
					<Button
						className="w-full"
						disabled={checking}
						loading={actions.pending === "enable"}
						onClick={() =>
							void actions.run(
								"simulators.configure",
								{
									enabled: true,
									agentAccessEnabled: agents,
									onboardingCompleted: true,
								},
								"enable",
							)
						}
					>
						{message("simulators:turn_on")}
					</Button>
				)}
				<p className="text-center text-[11px] leading-4 text-muted-foreground">
					{blocked
						? message("simulators:recheck_on_return")
						: agents
							? message("simulators:installs_hub_and_agent", {
									hub: state.tools.hub,
									agent: state.tools.agent,
								})
							: message("simulators:installs_hub", { hub: state.tools.hub })}
				</p>
				{actions.error ? (
					<SimulatorError>{actions.error}</SimulatorError>
				) : null}
			</div>
		</SimulatorStage>
	);
}

function SimulatorPreparing({
	environmentId,
	state,
	active,
}: {
	environmentId: EnvironmentId;
	state: SimulatorState;
	active: boolean;
}) {
	const { message } = useMessages(["simulators"]);
	const actions = useSimulatorActions(environmentId);
	// Helpers start lazily: an idle host starts when its pane is first shown.
	useEffect(() => {
		if (active && state.status === "idle")
			void actions.run("simulators.refresh", {}, "start");
	}, [active, state.status, actions.run]);
	return (
		<SimulatorStage
			title={message("simulators:preparing_title")}
			description={message("simulators:preparing_description")}
		>
			<StepList steps={setupSteps(state)} />
			<Button
				variant="ghost"
				size="sm"
				className="self-center text-muted-foreground"
				loading={actions.pending === "cancel"}
				onClick={() =>
					void actions.run("simulators.configure", { enabled: false }, "cancel")
				}
			>
				{message("simulators:cancel")}
			</Button>
		</SimulatorStage>
	);
}

function SimulatorFailed({
	environmentId,
	state,
}: {
	environmentId: EnvironmentId;
	state: SimulatorState;
}) {
	const { message } = useMessages(["simulators"]);
	const actions = useSimulatorActions(environmentId);
	const fix = useRequirementFix(actions, state.requirements);
	const blocked = requirementsBlocked(state);
	return (
		<SimulatorStage
			title={message("simulators:failed_title")}
			description={blocked ? undefined : state.detail}
		>
			{blocked ? (
				<RequirementList requirements={state.requirements} fix={fix} />
			) : null}
			<div className="flex flex-col gap-2">
				<Button
					className="w-full"
					loading={actions.pending === "retry"}
					onClick={() => void actions.run("simulators.refresh", {}, "retry")}
				>
					{message("simulators:try_again")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="self-center text-muted-foreground"
					disabled={actions.pending !== null}
					onClick={() =>
						void actions.run("simulators.configure", { enabled: false }, "off")
					}
				>
					{message("simulators:turn_off")}
				</Button>
				{actions.error && actions.error !== state.detail ? (
					<SimulatorError>{actions.error}</SimulatorError>
				) : null}
			</div>
		</SimulatorStage>
	);
}
