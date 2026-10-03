import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { useMessages } from "@zuse/i18n/react";
import { lazy, Suspense, useState } from "react";
import { Button } from "./ui/button.tsx";

const AttemptHistoryDialog = lazy(
	() => import("./session-attempt-history-dialog.tsx"),
);

/** History paging code loads only when requested, keeping the chat startup path small. */
export function SessionAttemptHistory({
	sessionRef,
}: {
	readonly sessionRef: SessionRef;
}) {
	const { message } = useMessages(["chat"]);
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				variant="ghost"
				className="h-7 px-2 text-xs text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				{message("chat:attempts_title")}
			</Button>
			{open ? (
				<Suspense
					fallback={
						<span role="status" className="text-xs text-muted-foreground">
							{message("chat:attempts_loading")}
						</span>
					}
				>
					<AttemptHistoryDialog
						sessionRef={sessionRef}
						open={open}
						onOpenChange={setOpen}
					/>
				</Suspense>
			) : null}
		</>
	);
}
