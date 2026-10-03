import {
	connectLocalEngine,
	type DesktopEngineEndpoint,
	type EngineChannel,
	type EngineFrame,
} from "@zusehq/server/desktop-engine";

interface Attachment {
	readonly id: string;
	readonly controller: AbortController;
	channel: EngineChannel | null;
}

/** Each renderer RPC scope gets a fresh server client. Frames never cross scopes or replay. */
export const makeEngineRpcRelay = (options: {
	readonly endpoint: (signal: AbortSignal) => Promise<DesktopEngineEndpoint>;
	readonly message: (id: string, payload: string) => void;
	readonly disconnected: (id: string) => void;
	readonly connect?: typeof connectLocalEngine;
}) => {
	let current: Attachment | null = null;
	let disposed = false;
	const close = (attachment: Attachment) => {
		attachment.controller.abort();
		attachment.channel?.close();
		if (current !== attachment) return;
		current = null;
		options.disconnected(attachment.id);
	};
	return {
		open: async (id: string): Promise<void> => {
			if (disposed) throw new Error("The desktop window has closed.");
			if (typeof id !== "string" || id.length === 0 || id.length > 128)
				throw new Error("Invalid renderer connection identity.");
			if (current !== null) close(current);
			const attachment: Attachment = {
				id,
				controller: new AbortController(),
				channel: null,
			};
			current = attachment;
			try {
				const endpoint = await options.endpoint(attachment.controller.signal);
				attachment.controller.signal.throwIfAborted();
				const channel = await (options.connect ?? connectLocalEngine)(
					endpoint,
					{
						signal: attachment.controller.signal,
						receive: (frame: EngineFrame) => {
							if (current === attachment && frame._tag === "Rpc")
								options.message(id, frame.payload);
						},
					},
				);
				attachment.channel = channel;
				if (current !== attachment || disposed) {
					channel.close();
					throw new Error("Renderer connection was replaced.");
				}
				void channel.closed.then(() => close(attachment));
			} catch (error) {
				close(attachment);
				throw error;
			}
		},
		send: (id: string, payload: unknown): void => {
			const attachment = current;
			if (attachment === null || attachment.id !== id) return;
			// A missing channel is not a buffer: the caller must finish open before sending.
			if (
				typeof payload !== "string" ||
				attachment.channel === null ||
				!attachment.channel.send({ _tag: "Rpc", payload })
			)
				close(attachment);
		},
		close: (id: string): void => {
			if (current?.id === id) close(current);
		},
		reset: (): void => {
			if (current !== null) close(current);
		},
		dispose: (): void => {
			disposed = true;
			if (current !== null) close(current);
		},
	};
};
