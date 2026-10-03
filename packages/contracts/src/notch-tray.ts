/** Desktop tray payload shared by the renderer and native shell. */
export const NOTCH_TRAY_ITEM_STATES = [
	"running",
	"quiet",
	"unavailable",
	"disconnected",
	"checking",
	"completed",
	"failed",
	"planReady",
	"question",
	"permission",
] as const;
export type NotchTrayItemState = (typeof NOTCH_TRAY_ITEM_STATES)[number];

export interface NotchTrayItem {
	readonly id: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly title: string;
	readonly subtitle: string;
	readonly state: NotchTrayItemState;
	readonly label: string;
	readonly updatedAt: number;
}
