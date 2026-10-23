import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsRuntimeRpc } from "@zuse/client-runtime/legacy-runtime-capabilities";
import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { SessionForkConstruction, SessionId } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { getVerifiedRpcClient } from "../lib/rpc-client.ts";
import { Button } from "./ui/button.tsx";

/** Shown on the source so even a fork that failed before creating its tab can be recovered. */
export function SessionForkRecovery({
	sessionRef,
}: {
	readonly sessionRef: SessionRef;
}) {
	const { message } = useMessages(["chat"]);
	const [rows, setRows] = useState<readonly SessionForkConstruction[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const pending = useRef(false);
	const { environmentId, sessionId } = sessionRef;
	useEffect(() => {
		const current = ++generation.current;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setRows([]);
		const refresh = async () => {
			try {
				const client = await getVerifiedRpcClient(environmentId);
				if (
					!supportsRuntimeRpc(
						"session.forkConstructions",
						getClientProtocolVersion(client),
					)
				)
					return;
				if (current !== generation.current) return;
				const rows = await Effect.runPromise(
					client["session.forkConstructions"]({ sessionId }),
				);
				if (current === generation.current) setRows(rows);
			} catch {}
			if (current === generation.current)
				timer = setTimeout(() => void refresh(), 5000);
		};
		void refresh();
		return () => {
			generation.current++;
			clearTimeout(timer);
		};
	}, [environmentId, sessionId]);
	const act = async (forkSessionId: SessionId, action: "retry" | "cancel") => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		const current = generation.current;
		try {
			const client = await getVerifiedRpcClient(environmentId);
			if (current !== generation.current) return;
			await Effect.runPromise(
				action === "retry"
					? client["session.retryFork"]({ sessionId, forkSessionId })
					: client["session.cancelFork"]({ sessionId, forkSessionId }),
			);
			const next = await Effect.runPromise(
				client["session.forkConstructions"]({ sessionId }),
			);
			if (current === generation.current) setRows(next);
		} catch (cause) {
			if (current === generation.current) setError(formatError(cause));
		} finally {
			pending.current = false;
			if (current === generation.current) setBusy(false);
		}
	};
	if (rows.length === 0) return null;
	return (
		<div className="space-y-1 px-3 py-2 text-xs" role="status">
			{rows.map((row) => (
				<div key={row.sessionId} className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-muted-foreground">
						{row.title}:{" "}
						{message(
							row.state === "failed"
								? "chat:fork_recovery_failed"
								: "chat:fork_recovery_pending",
						)}
					</span>
					<Button
						variant="ghost"
						className="h-7 px-2 text-xs"
						disabled={busy}
						onClick={() => void act(row.sessionId, "retry")}
					>
						{message("chat:fork_recovery_retry")}
					</Button>
					<Button
						variant="ghost"
						className="h-7 px-2 text-xs"
						disabled={busy}
						onClick={() => void act(row.sessionId, "cancel")}
					>
						{message("chat:fork_recovery_cancel")}
					</Button>
				</div>
			))}
			{error === null ? null : <p className="text-destructive">{error}</p>}
		</div>
	);
}
