import "@zuse/i18n/english/simulators";
import { EnvironmentId, type SimulatorState } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useRef } from "react";
import { getLocalEnvironmentId } from "~/lib/rpc-client.ts";
import {
	useSimulatorActions,
	useSimulatorState,
} from "~/lib/simulator-client-bus.ts";
import {
	requirementSections,
	requirementsBlocked,
	simulatorSummary,
} from "~/lib/simulator-view.ts";
import {
	type RequirementFix,
	RequirementRow,
	RequirementSectionLabel,
	RequirementsChecking,
	useRequirementFix,
} from "../simulator/simulator-parts.tsx";
import { Button } from "../ui/button.tsx";
import {
	SettingsGroup,
	SettingsNote,
	SettingsRow,
} from "../ui/settings-panel.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Switch } from "../ui/switch.tsx";

/** Simulator host settings for this computer's environment. */
export function SimulatorSettingsPane() {
	const environmentId = EnvironmentId.make(getLocalEnvironmentId());
	const view = useSimulatorState(environmentId);
	const { message } = useMessages(["simulators"]);
	const actions = useSimulatorActions(environmentId);
	const state = view.data;
	const fix = useRequirementFix(actions, state?.requirements ?? []);
	const checked = useRef(false);
	useEffect(() => {
		if (checked.current || !state || state.requirements.length > 0) return;
		checked.current = true;
		void actions.run("simulators.refresh", {}, "check");
	}, [state, actions.run]);
	if (!state)
		return (
			<SettingsGroup title={message("simulators:settings_title")}>
				<SettingsNote>
					{view.sync === "failed" ? (
						message("simulators:settings_unavailable")
					) : (
						<>
							<Spinner className="size-3" /> {message("simulators:loading")}
						</>
					)}
				</SettingsNote>
			</SettingsGroup>
		);
	const blocked = !state.enabled && requirementsBlocked(state);
	const configure = (patch: Record<string, boolean>, label: string) =>
		void actions.run(
			"simulators.configure",
			{ ...patch, onboardingCompleted: true },
			label,
		);
	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title={message("simulators:settings_title")}
				description={message("simulators:settings_description")}
			>
				<SettingsRow
					title={message("simulators:settings_title")}
					description={simulatorSummary(state)}
					action={
						<Switch
							aria-label={message("simulators:settings_title")}
							checked={state.enabled}
							disabled={blocked || actions.pending !== null}
							onCheckedChange={(enabled) => configure({ enabled }, "enabled")}
						/>
					}
				/>
				<SettingsRow
					title={message("simulators:agent_access")}
					description={message("simulators:agent_access_description")}
					action={
						<Switch
							aria-label={message("simulators:agent_access")}
							checked={state.agentAccessEnabled}
							disabled={!state.enabled || actions.pending !== null}
							onCheckedChange={(agentAccessEnabled) =>
								configure({ agentAccessEnabled }, "agents")
							}
						/>
					}
				/>
				{state.agentAccessEnabled && state.agentDetail ? (
					<SettingsNote
						tone={state.agentStatus === "error" ? "error" : "muted"}
					>
						{state.agentStatus === "installing" ? (
							<Spinner className="size-3" />
						) : null}
						{state.agentDetail}
					</SettingsNote>
				) : null}
				{actions.error ? (
					<SettingsNote tone="error">{actions.error}</SettingsNote>
				) : null}
			</SettingsGroup>
			<SettingsGroup
				title={message("simulators:requirements")}
				description={message("simulators:requirements_description")}
				action={
					<Button
						size="sm"
						variant="settings"
						loading={actions.pending === "check"}
						onClick={() => void actions.run("simulators.refresh", {}, "check")}
					>
						{message("simulators:check_again")}
					</Button>
				}
			>
				<RequirementRows state={state} fix={fix} />
			</SettingsGroup>
			<SettingsGroup
				title={message("simulators:tools")}
				footer={message("simulators:tools_footer")}
			>
				<SettingsRow
					title={message("simulators:device_hub")}
					description={message("simulators:device_hub_description", {
						version: state.tools.hub,
					})}
					action={<ToolStatus label={hubStatus(state)} />}
				/>
				<SettingsRow
					title={message("simulators:agent_tools")}
					description={message("simulators:agent_tools_description", {
						version: state.tools.agent,
					})}
					action={<ToolStatus label={agentStatus(state)} />}
				/>
			</SettingsGroup>
		</div>
	);
}

function RequirementRows({
	state,
	fix,
}: {
	state: SimulatorState;
	fix: RequirementFix;
}) {
	if (state.requirements.length === 0)
		return <RequirementsChecking className="px-3" />;
	const sections = requirementSections(state.requirements);
	return sections.map((section) => (
		<div key={section.platform} className="flex flex-col px-3 py-2">
			{sections.length > 1 ? (
				<RequirementSectionLabel platform={section.platform} className="pb-1" />
			) : null}
			{section.items.map((item) => (
				<RequirementRow key={item.id} item={item} fix={fix} className="py-1" />
			))}
		</div>
	));
}

function ToolStatus({ label }: { label: string }) {
	return <span className="text-[11px] text-muted-foreground">{label}</span>;
}

function hubStatus(state: SimulatorState) {
	switch (state.status) {
		case "disabled":
			return uiMessage("simulators:status_off");
		case "idle":
			return uiMessage("simulators:status_on_demand");
		case "checking":
			return uiMessage("simulators:status_checking");
		case "installing":
			return uiMessage("simulators:status_installing");
		case "starting":
			return uiMessage("simulators:status_starting");
		case "ready":
			return uiMessage("simulators:status_running");
		default:
			return uiMessage("simulators:status_stopped");
	}
}

function agentStatus(state: SimulatorState) {
	if (!state.enabled || !state.agentAccessEnabled)
		return uiMessage("simulators:status_off");
	switch (state.agentStatus) {
		case "installing":
			return uiMessage("simulators:status_installing");
		case "ready":
			return uiMessage("simulators:status_ready");
		case "error":
			return uiMessage("simulators:status_failed");
		default:
			return uiMessage("simulators:status_first_use");
	}
}
