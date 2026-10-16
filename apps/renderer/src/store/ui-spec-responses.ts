import { createAtomStore as create } from "../state/atom-store.ts";

type ResponseStatus = "sending" | "sent";

type UiSpecResponsesState = {
	readonly byMessageId: Readonly<Record<string, ResponseStatus>>;

	readonly begin: (messageId: string) => boolean;

	readonly settle: (messageId: string, accepted: boolean) => void;
};

export const useUiSpecResponses = create<UiSpecResponsesState>((set, get) => ({
	byMessageId: {},
	begin: (messageId) => {
		if (get().byMessageId[messageId] !== undefined) return false;
		set({ byMessageId: { ...get().byMessageId, [messageId]: "sending" } });
		return true;
	},
	settle: (messageId, accepted) => {
		const next = { ...get().byMessageId };
		if (accepted) next[messageId] = "sent";
		else delete next[messageId];
		set({ byMessageId: next });
	},
}));
