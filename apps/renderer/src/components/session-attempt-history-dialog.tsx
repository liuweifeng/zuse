import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { createSessionAttemptHistory } from "@zuse/client-runtime/session-attempt-history";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { formatError } from "../lib/format-error.ts";
import { getVerifiedRpcClient } from "../lib/rpc-client.ts";
import { Button } from "./ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";

export default function SessionAttemptHistoryDialog({
	sessionRef,
	open,
	onOpenChange,
}: {
	readonly sessionRef: SessionRef;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	const { message } = useMessages(["chat"]);
	const { environmentId, sessionId } = sessionRef;
	const history = useMemo(
		() =>
			createSessionAttemptHistory(async (before) => {
				const client = await getVerifiedRpcClient(environmentId);
				return Effect.runPromise(
					client["session.attempts.list"]({
						sessionId,
						...(before === undefined ? {} : { before }),
					}),
				);
			}),
		[environmentId, sessionId],
	);
	const state = useSyncExternalStore(
		history.subscribe,
		history.snapshot,
		history.snapshot,
	);
	useEffect(() => {
		if (open) void history.refresh();
		return history.cancel;
	}, [history, open]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>{message("chat:attempts_title")}</DialogTitle>
					<DialogDescription>
						{message("chat:attempts_description")}
					</DialogDescription>
				</DialogHeader>
				<DialogPanel
					className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto"
					aria-busy={state.loading}
				>
					<div className="flex items-center justify-end gap-2">
						{state.loading ? (
							<span role="status" className="text-xs text-muted-foreground">
								{message("chat:attempts_loading")}
							</span>
						) : null}
						<Button
							variant="ghost"
							className="h-7"
							disabled={state.loading}
							onClick={() => void history.refresh()}
						>
							{message("chat:attempts_refresh")}
						</Button>
					</div>
					{state.error !== null ? (
						<p role="alert" className="text-xs text-destructive">
							{formatError(state.error)}
						</p>
					) : null}
					{state.loaded &&
					!state.loading &&
					state.error === null &&
					state.items.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							{message("chat:attempts_empty")}
						</p>
					) : null}
					{state.items.map((item) => (
						<div
							key={item.id}
							className="rounded-md bg-muted/30 px-3 py-2 text-xs"
						>
							<div className="flex justify-between gap-3">
								<span>
									{message("chat:attempts_turn")} {item.turnOrdinal} ·{" "}
									{message("chat:attempts_attempt")} {item.ordinal}
								</span>
								<span className="text-muted-foreground">
									{message(`chat:attempts_${item.status}`)}
								</span>
							</div>
							<div className="mt-1 text-muted-foreground">
								{message(
									`chat:attempts_${item.reason === "provider_recovery" ? "recovery" : item.reason}`,
								)}
								{item.rolledBack
									? ` · ${message("chat:attempts_rolled_back")}`
									: ""}
							</div>
							<div className="mt-1 text-muted-foreground">
								{new Date(item.startedAt).toLocaleString()}
								{item.completedAt === null
									? ""
									: ` — ${new Date(item.completedAt).toLocaleString()}`}
							</div>
						</div>
					))}
					{state.nextCursor === null ? null : (
						<Button
							variant="ghost"
							className="h-7"
							disabled={state.loading}
							onClick={() => void history.more()}
						>
							{message("chat:attempts_more")}
						</Button>
					)}
				</DialogPanel>
			</DialogPopup>
		</Dialog>
	);
}
