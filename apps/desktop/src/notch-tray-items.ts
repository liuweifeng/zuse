import { NOTCH_TRAY_ITEM_STATES, type NotchTrayItem } from "@zuse/contracts";

const isNotchItemState = (value: unknown): value is NotchTrayItem["state"] =>
	NOTCH_TRAY_ITEM_STATES.some((state) => state === value);

export const sanitizeNotchItems = (
	raw: unknown,
): ReadonlyArray<NotchTrayItem> => {
	if (!Array.isArray(raw)) return [];
	const out: NotchTrayItem[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		if (
			typeof obj.id !== "string" ||
			typeof obj.chatId !== "string" ||
			typeof obj.sessionId !== "string" ||
			typeof obj.title !== "string" ||
			typeof obj.subtitle !== "string" ||
			typeof obj.label !== "string" ||
			typeof obj.updatedAt !== "number" ||
			!isNotchItemState(obj.state)
		) {
			continue;
		}
		out.push({
			id: obj.id,
			chatId: obj.chatId,
			sessionId: obj.sessionId,
			title: obj.title.slice(0, 160),
			subtitle: obj.subtitle.slice(0, 180),
			state: obj.state,
			label: obj.label.slice(0, 80),
			updatedAt: obj.updatedAt,
		});
		if (out.length >= 12) break;
	}
	return out;
};
