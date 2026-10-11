import type { ProviderSummary, WhoamiResult } from "./orchestration-tools.ts";

export const ORCHESTRATION_READ_LIMIT = 100;
export const ORCHESTRATION_TEXT_LIMIT = 32_000;

export interface OrchestrationReadInput {
	readonly sessionId: string;
	readonly limit?: number;
	/** Empty string starts at the beginning; omission requests recent messages. */
	readonly afterMessageId?: string;
	/** Read one message, including subsequent chunks of a large result. */
	readonly messageId?: string;
	readonly textOffset?: number;
	readonly maxTextChars?: number;
	readonly view?: "messages" | "activity";
}

export interface OrchestrationProviderSummary extends ProviderSummary {
	readonly enabled: boolean;
	readonly appTools: boolean;
	readonly planMode: boolean;
	/** Inventory freshness is not proof of successful authentication. */
	readonly inventoryStatus: string;
}

export type OrchestrationCapabilitiesResult =
	| {
			readonly ok: true;
			readonly session: WhoamiResult;
			readonly providers: ReadonlyArray<ProviderSummary>;
			readonly tools: ReadonlyArray<string>;
			readonly limits: {
				readonly readMessages: number;
				readonly readTextChars: number;
			};
			readonly context: { readonly automaticParentHistory: false };
	  }
	| { readonly ok: false; readonly error: string };
