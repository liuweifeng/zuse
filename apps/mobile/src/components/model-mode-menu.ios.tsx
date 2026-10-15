import { Host } from "@expo/ui";
import {
	Divider,
	Menu,
	Button as NativeButton,
	Section,
} from "@expo/ui/swift-ui";
import {
	type PermissionMode,
	type ProviderId,
	providerLabel,
	type RuntimeMode,
} from "@zuse/contracts";

import {
	defaultModelOptions,
	modelOptionsForProvider,
	PERMISSION_OPTIONS,
	providerOptions,
	RUNTIME_OPTIONS,
	reasoningValueForModel,
	runtimeOptionFor,
} from "~/lib/model-options";
import { activeModelCatalog } from "~/store/model-catalog";
import { APP_TINT } from "~/theme";

export type ModelModeValue = {
	providerId: ProviderId;
	model: string;
	runtimeMode: RuntimeMode;
	permissionMode: PermissionMode;
	modelOptions?: Record<string, string>;
};

export function ModelModePill({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={modelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
				/>
				<Divider />
				<ModeButtons value={value} editable={editable} onChange={onChange} />
				<PermissionButtons
					value={value}
					editable={editable}
					onChange={onChange}
				/>
			</Menu>
		</Host>
	);
}

export function ComposerModelMenu({
	value,
	editable,
	onChange,
	availableProviders,
	canChangeProvider = true,
	canChangeReasoning = true,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;

	availableProviders?: readonly ProviderId[] | null;

	canChangeProvider?: boolean;

	canChangeReasoning?: boolean;
}) {
	return (
		<Host
			key={`${value.providerId}:${value.model}`}
			matchContents
			seedColor={APP_TINT}
		>
			<Menu
				label={compactModelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
					availableProviders={availableProviders}
					canChangeProvider={canChangeProvider}
				/>
				{canChangeReasoning ? (
					<ReasoningButtons
						value={value}
						editable={editable}
						onChange={onChange}
					/>
				) : null}
			</Menu>
		</Host>
	);
}

export function ComposerSettingsMenu({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu label="" systemImage="gearshape">
				<Menu label="Mode" systemImage="slider.horizontal.3">
					<ModeButtons value={value} editable={editable} onChange={onChange} />
				</Menu>
				<Menu label="Approval" systemImage="hand.raised">
					<PermissionButtons
						value={value}
						editable={editable}
						onChange={onChange}
					/>
				</Menu>
			</Menu>
		</Host>
	);
}

export const ComposerModeMenu = ComposerSettingsMenu;
export const ComposerApprovalMenu = ComposerSettingsMenu;

export function ModePill({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={modeLabel(value)}
				systemImage="chevron.left.forwardslash.chevron.right"
			>
				<ModeButtons value={value} editable={editable} onChange={onChange} />
			</Menu>
		</Host>
	);
}

export function RuntimePill({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu label={runtimeLabel(value)} systemImage="lock.open">
				<PermissionButtons
					value={value}
					editable={editable}
					onChange={onChange}
				/>
			</Menu>
		</Host>
	);
}

export function StaticModelTitle({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={modelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
				/>
			</Menu>
		</Host>
	);
}

export function HeaderModePill({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={modeLabel(value)}
				systemImage="chevron.left.forwardslash.chevron.right"
			>
				<ModeButtons value={value} editable={editable} onChange={onChange} />
			</Menu>
		</Host>
	);
}

export function ProjectPill({
	label,
	options,
	onSelect,
}: {
	label: string;
	options: readonly {
		connectionKey: string;
		connectionLabel: string;
		projects: readonly { id: string; name: string; path: string }[];
	}[];
	onSelect: (connectionKey: string, projectId: string) => void;
}) {
	const projects = options.flatMap((group) =>
		group.projects.map((project) => ({
			...project,
			connectionKey: group.connectionKey,
		})),
	);

	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu label={label} systemImage="folder">
				{projects.length === 0 ? (
					<NativeButton
						label="No projects"
						systemImage="folder"
						onPress={() => {}}
					/>
				) : (
					projects.map((project) => (
						<NativeButton
							key={`${project.connectionKey}:${project.id}`}
							label={project.name}
							systemImage="folder"
							onPress={() => onSelect(project.connectionKey, project.id)}
						/>
					))
				)}
			</Menu>
		</Host>
	);
}

export function SourcePill({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={label}
				systemImage="point.topleft.down.curvedto.point.bottomright.up"
			>
				{children}
			</Menu>
		</Host>
	);
}

export function ProjectMenuRow({
	label,
	subtitle,
	options,
	onSelect,
}: {
	label: string;
	subtitle: string;
	options: readonly {
		connectionKey: string;
		connectionLabel: string;
		projects: readonly { id: string; name: string; path: string }[];
	}[];
	onSelect: (connectionKey: string, projectId: string) => void;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu label={`${label} · ${subtitle}`} systemImage="desktopcomputer">
				{options.map((group) => (
					<Menu
						key={group.connectionKey}
						label={group.connectionLabel}
						systemImage="desktopcomputer"
					>
						{group.projects.length === 0 ? (
							<NativeButton
								label="No projects"
								systemImage="folder"
								onPress={() => {}}
							/>
						) : (
							group.projects.map((project) => (
								<NativeButton
									key={project.id}
									label={project.name}
									systemImage="folder"
									onPress={() => onSelect(group.connectionKey, project.id)}
								/>
							))
						)}
					</Menu>
				))}
			</Menu>
		</Host>
	);
}

export function SourceMenuRow({
	label,
	subtitle,
	children,
}: {
	label: string;
	subtitle: string;
	children: React.ReactNode;
}) {
	return (
		<Host matchContents seedColor={APP_TINT}>
			<Menu
				label={`${label} · ${subtitle}`}
				systemImage="bubble.left.and.bubble.right"
			>
				{children}
			</Menu>
		</Host>
	);
}

export { Divider, Menu, NativeButton, Section };

function ProviderModelMenus({
	value,
	editable,
	onChange,
	availableProviders,
	canChangeProvider = true,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
	availableProviders?: readonly ProviderId[] | null;
	canChangeProvider?: boolean;
}) {
	const providers = providerOptions(activeModelCatalog()).filter((provider) => {
		if (!canChangeProvider) return provider.value === value.providerId;

		if (availableProviders == null) return true;
		return (
			provider.value === value.providerId ||
			availableProviders.includes(provider.value)
		);
	});
	return (
		<Section title="Models">
			{providers.map((provider) => (
				<Menu
					key={provider.value}
					label={provider.label}
					systemImage={providerSystemImage(provider.value)}
				>
					{modelOptionsForProvider(activeModelCatalog(), provider.value).map(
						(model) => (
							<NativeButton
								key={model.value}
								label={model.label}
								systemImage={
									value.providerId === provider.value &&
									value.model === model.value
										? sf("checkmark")
										: undefined
								}
								onPress={() => {
									if (!editable) return;
									onChange({
										...value,
										providerId: provider.value,
										model: model.value,
										modelOptions: defaultModelOptions(
											activeModelCatalog(),
											provider.value,
											model.value,
										),
									});
								}}
							/>
						),
					)}
				</Menu>
			))}
		</Section>
	);
}

const REASONING_GAUGE_ICONS = [
	"gauge.with.dots.needle.0percent",
	"gauge.with.dots.needle.33percent",
	"gauge.with.dots.needle.67percent",
	"gauge.with.dots.needle.100percent",
] as const;

const reasoningLevelIcon = (index: number, count: number): string => {
	if (count <= 1) return REASONING_GAUGE_ICONS[2];
	const ratio = index / (count - 1);
	return (
		REASONING_GAUGE_ICONS[
			Math.round(ratio * (REASONING_GAUGE_ICONS.length - 1))
		] ?? REASONING_GAUGE_ICONS[2]
	);
};

function ReasoningButtons({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	const reasoning = reasoningValueForModel(
		activeModelCatalog(),
		value.providerId,
		value.model,
		value.modelOptions,
	);
	if (reasoning === null) return null;

	const options = reasoning.descriptor.options;
	return (
		<Section title={reasoning.descriptor.label}>
			{options.map((option, index) => (
				<NativeButton
					key={option.id}
					label={option.label}
					systemImage={sf(reasoningLevelIcon(index, options.length))}
					onPress={() => {
						if (!editable) return;
						onChange({
							...value,
							modelOptions: {
								...(value.modelOptions ?? {}),
								[reasoning.descriptor.id]: option.id,
							},
						});
					}}
				/>
			))}
		</Section>
	);
}

function ModeButtons({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	if (value.providerId === "pi") return null;
	return (
		<Section title="Mode">
			{PERMISSION_OPTIONS.map((item) => (
				<NativeButton
					key={item.value}
					label={item.label}
					systemImage={sf(
						value.permissionMode === item.value
							? "checkmark"
							: "wand.and.stars",
					)}
					onPress={() => {
						if (!editable) return;
						onChange({ ...value, permissionMode: item.value });
					}}
				/>
			))}
		</Section>
	);
}

function PermissionButtons({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	if (value.providerId === "pi") return null;
	return (
		<Section title="Approval">
			{RUNTIME_OPTIONS.map((item) => (
				<NativeButton
					key={item.value}
					label={item.label}
					systemImage={sf(
						value.runtimeMode === item.value ? "checkmark" : item.systemImage,
					)}
					role={item.value === "full-access" ? "destructive" : undefined}
					onPress={() => {
						if (!editable) return;
						onChange({ ...value, runtimeMode: item.value });
					}}
				/>
			))}
		</Section>
	);
}

const modelLabel = (value: ModelModeValue): string =>
	modelOptionsForProvider(activeModelCatalog(), value.providerId).find(
		(model) => model.value === value.model,
	)?.label ?? value.model;

const compactModelLabel = (value: ModelModeValue): string =>
	[
		shortModelLabel(modelLabel(value)),
		reasoningValueForModel(
			activeModelCatalog(),
			value.providerId,
			value.model,
			value.modelOptions,
		)?.label,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");

const shortModelLabel = (label: string): string => {
	const trimmed = label
		.replace(/^GPT-?/i, "")
		.replace(/^Claude\s+/i, "")
		.trim();
	return trimmed.length > 0 ? trimmed : label;
};

const modeLabel = (value: ModelModeValue): string =>
	value.providerId === "pi"
		? "Pi permissions"
		: (PERMISSION_OPTIONS.find((item) => item.value === value.permissionMode)
				?.label ?? value.permissionMode);

const runtimeLabel = (value: ModelModeValue): string =>
	value.providerId === "pi"
		? "Pi permissions"
		: runtimeOptionFor(value.runtimeMode).label;

const providerSystemImage = (providerId: ProviderId): string => {
	switch (providerId) {
		case "zuse":
			return "bolt";
		case "claude":
			return "cloud";
		case "codex":
			return "terminal";
		case "grok":
			return "sparkles";
		case "cursor":
			return "cursorarrow";
		case "gemini":
			return "diamond";
		case "opencode":
		case "opencode2":
			return "chevron.left.forwardslash.chevron.right";
		case "pi":
			return "function";
		case "kiro":
			return "face.smiling";
		default:
			return "terminal";
	}
};

const sf = (name: string) => name as never;

export const providerDisplayName = (providerId: ProviderId): string =>
	providerLabel(providerId);
