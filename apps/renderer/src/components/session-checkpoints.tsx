import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { SessionCheckpointSummary } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
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

/** Every action stays pinned to the environment and session that opened the dialog. */
export function SessionCheckpoints({
	sessionRef,
}: {
	readonly sessionRef: SessionRef;
}) {
	const { message } = useMessages(["chat"]);
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<readonly SessionCheckpointSummary[]>([]);
	const [preview, setPreview] = useState<{
		previewId: string;
		files: readonly string[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);
	const { environmentId, sessionId } = sessionRef;
	useEffect(() => {
		generation.current++;
		setOpen(false);
		setRows([]);
		setPreview(null);
		setError(null);
		setBusy(false);
		return () => {
			generation.current++;
		};
	}, [environmentId, sessionId]);
	const run = async (
		action: (
			client: Awaited<ReturnType<typeof getVerifiedRpcClient>>,
		) => Promise<void>,
	) => {
		const current = generation.current;
		setBusy(true);
		setError(null);
		try {
			const client = await getVerifiedRpcClient(environmentId);
			if (current !== generation.current) return;
			await action(client);
		} catch (cause) {
			if (current === generation.current) setError(formatError(cause));
		} finally {
			if (current === generation.current) setBusy(false);
		}
	};
	const refresh = () =>
		run(async (client) => {
			const current = generation.current;
			const result = await Effect.runPromise(
				client["session.checkpoints.list"]({ sessionId }),
			);
			if (current === generation.current) setRows(result);
		});
	const restore = (previewId: string) =>
		run(async (client) => {
			const current = generation.current;
			await Effect.runPromise(
				client["session.checkpoints.restore"]({ sessionId, previewId }),
			);
			if (current !== generation.current) return;
			setPreview(null);
			const result = await Effect.runPromise(
				client["session.checkpoints.list"]({ sessionId }),
			);
			if (current === generation.current) setRows(result);
		});
	const status = (row: SessionCheckpointSummary) => {
		switch (row.status) {
			case "capturing":
				return message("chat:checkpoints_status_capturing");
			case "ready":
				return message("chat:checkpoints_status_ready");
			case "error":
				return message("chat:checkpoints_status_error");
			case "stale":
				return message("chat:checkpoints_status_stale");
			case "unsupported":
				return message("chat:checkpoints_status_unsupported");
		}
	};
	return (
		<>
			<div className="flex justify-end px-3">
				<Button
					variant="ghost"
					className="h-7 px-2 text-xs text-muted-foreground"
					onClick={() => {
						setOpen(true);
						void refresh();
					}}
				>
					{message("chat:checkpoints_title")}
				</Button>
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogPopup className="max-w-md">
					<DialogHeader>
						<DialogTitle>{message("chat:checkpoints_title")}</DialogTitle>
						<DialogDescription>
							{message("chat:checkpoints_description")}
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
						{error !== null ? (
							<p role="alert" className="text-destructive text-xs">
								{error}
							</p>
						) : null}
						{preview !== null ? (
							<>
								<p className="text-xs text-muted-foreground">
									{message("chat:checkpoints_confirm")}
								</p>
								{preview.files.length === 0 ? (
									<p className="text-xs">
										{message("chat:checkpoints_no_files")}
									</p>
								) : (
									<ul className="space-y-1 text-xs">
										{preview.files.map((file) => (
											<li className="break-all" key={file}>
												{file}
											</li>
										))}
									</ul>
								)}
								<div className="flex justify-end gap-2">
									<Button
										variant="ghost"
										className="h-7"
										disabled={busy}
										onClick={() => setPreview(null)}
									>
										{message("chat:checkpoints_back")}
									</Button>
									<Button
										className="h-7"
										disabled={busy}
										onClick={() => void restore(preview.previewId)}
									>
										{message("chat:checkpoints_restore")}
									</Button>
								</div>
							</>
						) : (
							<>
								<div className="flex justify-end">
									<Button
										variant="ghost"
										className="h-7"
										disabled={busy}
										onClick={() => void refresh()}
									>
										{message("chat:checkpoints_refresh")}
									</Button>
								</div>
								{rows.length === 0 ? (
									<p className="text-xs text-muted-foreground">
										{message("chat:checkpoints_empty")}
									</p>
								) : (
									rows.map((row) => (
										<div
											key={row.id}
											className="flex items-center justify-between gap-3 py-1"
										>
											<div className="min-w-0 text-xs">
												<div>
													{row.phase === "baseline"
														? message("chat:checkpoints_before")
														: message("chat:checkpoints_after")}{" "}
													{row.turnOrdinal}
												</div>
												<div className="text-muted-foreground">
													{status(row)}
												</div>
												{row.error !== null ? (
													<p className="text-destructive">{row.error}</p>
												) : null}
											</div>
											{row.restoreId !== null ? (
												<Button
													className="h-7"
													disabled={busy}
													onClick={() => {
														if (row.restoreId !== null)
															void restore(row.restoreId);
													}}
												>
													{message("chat:checkpoints_resume")}
												</Button>
											) : row.status === "ready" ? (
												<Button
													variant="ghost"
													className="h-7"
													disabled={busy}
													onClick={() =>
														void run(async (client) => {
															const current = generation.current;
															const value = await Effect.runPromise(
																client["session.checkpoints.preview"]({
																	sessionId,
																	checkpointId: row.id,
																}),
															);
															if (current === generation.current)
																setPreview(value);
														})
													}
												>
													{message("chat:checkpoints_review")}
												</Button>
											) : row.status === "error" ? (
												<Button
													className="h-7"
													disabled={busy}
													onClick={() =>
														void run(async (client) => {
															await Effect.runPromise(
																client["session.checkpoints.retry"]({
																	sessionId,
																}),
															);
															setRows(
																await Effect.runPromise(
																	client["session.checkpoints.list"]({
																		sessionId,
																	}),
																),
															);
														})
													}
												>
													{message("chat:checkpoints_retry")}
												</Button>
											) : null}
										</div>
									))
								)}
							</>
						)}
					</DialogPanel>
				</DialogPopup>
			</Dialog>
		</>
	);
}
