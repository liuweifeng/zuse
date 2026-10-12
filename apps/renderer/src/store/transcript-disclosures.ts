import { createAtomStore } from "../state/atom-store.ts";

/** Bounded UI state survives virtualized row remounts without touching transcripts. */
export const useTranscriptDisclosures = createAtomStore<{
	readonly byKey: Readonly<Record<string, boolean>>;
	readonly toggle: (key: string, defaultOpen: boolean) => void;
}>((set, get) => ({
	byKey: {},
	toggle: (key, defaultOpen) => {
		const previous = get().byKey;
		const entries = Object.entries(previous).filter(([entry]) => entry !== key);
		set({
			byKey: Object.fromEntries([
				...entries.slice(-2047),
				[key, !(previous[key] ?? defaultOpen)],
			]),
		});
	},
}));

export function useTranscriptDisclosure(key: string, defaultOpen = false) {
	const open = useTranscriptDisclosures(
		(state) => state.byKey[key] ?? defaultOpen,
	);
	return [
		open,
		() => useTranscriptDisclosures.getState().toggle(key, defaultOpen),
	] as const;
}
