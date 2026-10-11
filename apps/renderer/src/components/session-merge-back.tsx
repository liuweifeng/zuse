import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsRuntimeRpc } from "@zuse/client-runtime/legacy-runtime-capabilities";
import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { getVerifiedRpcClient } from "../lib/rpc-client.ts";
import { Button } from "./ui/button.tsx";
import { toastManager } from "./ui/toast.tsx";

/** A lost acknowledgement retries the same merge; it never creates a second context message. */
export function SessionMergeBack({
	sessionRef,
}: {
	readonly sessionRef: SessionRef;
}) {
	const { message } = useMessages(["chat"]);
	const [busy, setBusy] = useState(false);
	const [supported, setSupported] = useState(false);
	useEffect(() => {
		let disposed = false;
		setSupported(false);
		void getVerifiedRpcClient(sessionRef.environmentId)
			.then((client) => {
				if (!disposed)
					setSupported(
						supportsRuntimeRpc(
							"session.mergeBack",
							getClientProtocolVersion(client),
						),
					);
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, [sessionRef.environmentId]);
	const pending = useRef(false);
	const command = useRef<string | null>(null);
	const merge = async () => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		command.current ??= `merge-back:${crypto.randomUUID()}`;
		try {
			const client = await getVerifiedRpcClient(sessionRef.environmentId);
			await Effect.runPromise(
				client["session.mergeBack"]({
					commandId: command.current,
					sessionId: sessionRef.sessionId,
				}),
			);
			command.current = null;
			toastManager.add({
				title: message("chat:merge_back_complete"),
				description: message("chat:merge_back_next_turn"),
				type: "success",
			});
		} catch (error) {
			toastManager.add({
				title: message("chat:merge_back_failed"),
				description: formatError(error),
				type: "error",
			});
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	if (!supported) return null;
	return (
		<div className="flex justify-end px-3">
			<Button
				variant="ghost"
				className="h-7 px-2 text-xs text-muted-foreground"
				disabled={busy}
				onClick={() => void merge()}
			>
				{message("chat:merge_back_action")}
			</Button>
		</div>
	);
}
