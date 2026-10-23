import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import type {
	Master,
	MasterAction,
	MasterAvatar,
	MasterSettings,
	MasterSnapshot,
} from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { prepareChatTab } from "../lib/prepare-chat-tab.ts";
import { getRendererClientBus } from "../lib/session-timeline-client-bus.ts";
import { createAtomStore } from "../state/atom-store.ts";

/** Width bounds for the resizable Details panel, in CSS pixels. */
export const DETAILS_WIDTH = { min: 280, default: 320, max: 560 } as const;

export type MasterSelection = {
	environmentId: string;
	masterId: string | null;
};
export const useMastersStore = createAtomStore<{
	selection: MasterSelection | null;
	masters: readonly Master[];
	/** `null` follows the Master: the rail opens while it has slaves. */
	railOpen: boolean | null;
	/** Details panel width in CSS pixels (clamped by `setDetailsWidth`). */
	detailsWidth: number;
	select: (selection: MasterSelection | null) => void;
	setRailOpen: (open: boolean) => void;
	setDetailsWidth: (width: number) => void;
}>((set) => ({
	selection: null,
	masters: [],
	railOpen: null,
	detailsWidth: DETAILS_WIDTH.default,
	setDetailsWidth: (width) =>
		set({
			detailsWidth: Math.round(
				Math.min(DETAILS_WIDTH.max, Math.max(DETAILS_WIDTH.min, width)),
			),
		}),
	setRailOpen: (railOpen) => set({ railOpen }),
	select: (selection) => set({ selection }),
}));

/** Replace (or add) one Master in the directory list. */
const upsertMaster = (master: Master) =>
	useMastersStore.setState((state) => ({
		masters: [
			...state.masters.filter((value) => value.id !== master.id),
			master,
		],
	}));

export const readMaster = async (environmentId: string, masterId: string) => {
	const snapshot = await masterCommand<{ masterId: string }, MasterSnapshot>(
		environmentId,
		"masters.get",
		{ masterId },
	);
	getRendererClientBus().overlay(
		makeResourceKey<MasterSnapshot>("master-summary", {
			environmentId: EnvironmentId.make(environmentId),
			masterId,
		}),
		{
			initialData: snapshot,
			update: (current) =>
				current.master.revision > snapshot.master.revision ? current : snapshot,
		},
	);
	return snapshot;
};

export const masterCommand = async <Payload, Result>(
	environmentId: string,
	kind: string,
	payload: Payload,
	requestId?: string,
): Promise<Result> => {
	const commandId = CommandId.make(
		requestId ?? `master-ui:${crypto.randomUUID()}`,
	);
	return (
		await dispatchEnvironmentShellCommand<
			Payload & { commandId: string },
			Result
		>({
			environmentId: EnvironmentId.make(environmentId),
			kind,
			commandId,
			payload: { ...payload, commandId },
		})
	).result;
};

export const executeMaster = async (
	selection: MasterSelection,
	action: MasterAction,
) => {
	if (!selection.masterId) throw new Error("Select a Zot first.");
	const master = await masterCommand<
		{ masterId: string; action: MasterAction },
		Master
	>(selection.environmentId, "masters.execute", {
		masterId: selection.masterId,
		action,
	});
	upsertMaster(master);
	return master;
};

const MASTER_NAMES = [
	"pip",
	"nib",
	"echo",
	"moss",
	"memo",
	"bit",
	"fizz",
	"dot",
	"loop",
	"pixel",
	"noodle",
	"glitch",
	"widget",
	"sprocket",
	"tofu",
	"biscuit",
] as const;

/** A short name no existing Master uses yet (falls back to a numbered one). */
const freshMasterName = (taken: ReadonlySet<string>) => {
	const free = MASTER_NAMES.filter((name) => !taken.has(name));
	const pick = free[Math.floor(Math.random() * free.length)];
	if (pick) return pick;
	let index = 2;
	while (taken.has(`pip ${index}`)) index++;
	return `pip ${index}`;
};

/**
 * Creates a Master immediately with a generated name and mascot and the
 * signed-in provider and model a new chat would get, then opens it. Returns
 * null when no agent is signed in. Everything else is edited in its Details.
 */
export const quickCreateMaster = async (
	environmentId: string,
	avatar: MasterAvatar,
) => {
	// Same signed-in provider and default model a new chat would get.
	const defaults = await prepareChatTab(
		EnvironmentId.make(environmentId),
		null,
	);
	if (defaults === null) return null;
	const { providerId, model } = defaults;
	const taken = new Set(
		useMastersStore.getState().masters.map((master) => master.settings.name),
	);
	const master = await masterCommand<
		{ settings: MasterSettings; repositories: readonly [] },
		Master
	>(environmentId, "masters.create", {
		settings: {
			name: freshMasterName(taken),
			instructions: "",
			skills: [],
			modelGuidance: "",
			maxConcurrent: 4,
			maxFollowUps: 3,
			providerId,
			model,
			avatar,
		},
		repositories: [],
	});
	upsertMaster(master);
	useMastersStore.getState().select({
		environmentId: master.homeEnvironmentId,
		masterId: master.id,
	});
	return master;
};
