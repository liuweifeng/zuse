import { Context, Effect, Layer } from "effect";

export type MasterToolHandler = (
	sessionId: string,
	commandJson?: string,
	readOnly?: boolean,
	commandId?: string,
) => Promise<unknown>;

/** Late binding lets conversation providers call the orchestrator that owns them. */
export class MasterToolRouter extends Context.Service<
	MasterToolRouter,
	{
		register: (handler: MasterToolHandler) => () => void;
		call: MasterToolHandler;
	}
>()("zuse/MasterToolRouter") {}

export const MasterToolRouterLive = Layer.effect(
	MasterToolRouter,
	Effect.sync(() => {
		let handler: MasterToolHandler | null = null;
		return {
			register(next: MasterToolHandler) {
				handler = next;
				return () => {
					if (handler === next) handler = null;
				};
			},
			call: (
				sessionId: string,
				commandJson?: string,
				readOnly?: boolean,
				commandId?: string,
			) =>
				handler
					? handler(sessionId, commandJson, readOnly, commandId)
					: Promise.resolve({
							ok: false,
							error: "Zot orchestration is unavailable.",
						}),
		};
	}),
);
