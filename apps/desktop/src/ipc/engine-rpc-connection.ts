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
export const makeEngineRpcConnection = (options: {
	readonly endpoint: (signal: AbortSignal) => Promise<DesktopEngineEndpoint>;
	readonly message: (id: string, payload: string) => void;
	readonly disconnected: (id: string) => void;
	readonly connect?: typeof connectLocalEngine;
}) => {
	const attachments = new Map<string, Attachment>();
	let disposed = false;
	const close = (attachment: Attachment) => {
		attachment.controller.abort();
		attachment.channel?.close();
		if (attachments.get(attachment.id) !== attachment) return;
		attachments.delete(attachment.id);
		options.disconnected(attachment.id);
	};
	return {
		open: async (id: string): Promise<void> => {
			if (disposed) throw new Error("The desktop window has closed.");
			if (typeof id !== "string" || id.length === 0 || id.length > 128)
				throw new Error("Invalid renderer connection identity.");
			const previous = attachments.get(id);
			if (previous !== undefined) close(previous);
			if (attachments.size >= 4)
				throw new Error("Too many local engine connections.");
			const attachment: Attachment = {
				id,
				controller: new AbortController(),
				channel: null,
			};
			attachments.set(id, attachment);
			try {
				const endpoint = await options.endpoint(attachment.controller.signal);
				attachment.controller.signal.throwIfAborted();
				const channel = await (options.connect ?? connectLocalEngine)(
					endpoint,
					{
						signal: attachment.controller.signal,
						receive: (frame: EngineFrame) => {
							if (attachments.get(id) === attachment && frame._tag === "Rpc")
								options.message(id, frame.payload);
						},
					},
				);
				attachment.channel = channel;
				if (attachments.get(id) !== attachment || disposed) {
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
			const attachment = attachments.get(id);
			if (attachment === undefined) return;
			// A missing channel is not a buffer: the caller must finish open before sending.
			if (
				typeof payload !== "string" ||
				attachment.channel === null ||
				!attachment.channel.send({ _tag: "Rpc", payload })
			)
				close(attachment);
		},
		close: (id: string): void => {
			const attachment = attachments.get(id);
			if (attachment !== undefined) close(attachment);
		},
		reset: (): void => {
			for (const attachment of [...attachments.values()]) close(attachment);
		},
		dispose: (): void => {
			disposed = true;
			for (const attachment of [...attachments.values()]) close(attachment);
		},
	};
};
