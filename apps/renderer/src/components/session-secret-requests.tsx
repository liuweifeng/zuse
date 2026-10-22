import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsRuntimeRpc } from "@zuse/client-runtime/legacy-runtime-capabilities";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { SecretRequest } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect, Redacted } from "effect";
import { KeyRound, Lock, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getVerifiedRpcClient } from "../lib/rpc-client.ts";
import { startVisibleInterval } from "../lib/visible-interval.ts";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/** Secret values live only in the password input and the private response RPC. */
export function SessionSecretRequests({
	sessionRef,
}: {
	readonly sessionRef: SessionRef;
}) {
	const [snapshot, setSnapshot] = useState<{
		scope: string;
		requests: readonly SecretRequest[];
	}>({ scope: "", requests: [] });
	const { environmentId, sessionId } = sessionRef;
	const scope = `${environmentId}:${sessionId}`;
	const requests = snapshot.scope === scope ? snapshot.requests : [];
	useEffect(() => {
		let stopped = false;
		let unsupported = false;
		let loading = false;
		const refresh = async () => {
			if (stopped || unsupported || loading) return;
			loading = true;
			try {
				const client = await getVerifiedRpcClient(environmentId);
				if (
					!supportsRuntimeRpc("secrets.list", getClientProtocolVersion(client))
				) {
					unsupported = true;
					return;
				}
				if (stopped) return;
				const rows = await Effect.runPromise(
					client["secrets.list"]({ sessionId }),
				);
				if (!stopped)
					setSnapshot({
						scope,
						requests: rows.filter((request) => request.status === "pending"),
					});
			} catch (cause) {
				unsupported =
					/unknown request tag|method not found|not implemented|unsupported.*rpc/i.test(
						String(cause),
					);
			} finally {
				loading = false;
			}
		};
		const stop = startVisibleInterval(() => void refresh(), 3000);
		return () => {
			stopped = true;
			stop();
		};
	}, [environmentId, sessionId, scope]);
	return requests.map((request) => (
		<SecretRequestCard
			key={`${environmentId}:${request.id}`}
			request={request}
			sessionRef={sessionRef}
			onResolved={() =>
				setSnapshot((previous) =>
					previous.scope === scope
						? {
								...previous,
								requests: previous.requests.filter(
									(row) => row.id !== request.id,
								),
							}
						: previous,
				)
			}
		/>
	));
}
function SecretRequestCard({
	request,
	sessionRef,
	onResolved,
}: {
	readonly request: SecretRequest;
	readonly sessionRef: SessionRef;
	readonly onResolved: () => void;
}) {
	const { message } = useMessages(["chat", "common"]);
	const input = useRef<HTMLInputElement>(null);
	const pending = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (cancel: boolean) => {
		if (pending.current) return;
		const value = cancel ? undefined : input.current?.value;
		if (!cancel && !value) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		try {
			const client = await getVerifiedRpcClient(sessionRef.environmentId);
			await Effect.runPromise(
				client["secrets.respond"]({
					sessionId: sessionRef.sessionId,
					requestId: request.id,
					...(value === undefined ? {} : { value: Redacted.make(value) }),
				}),
			);
			if (input.current) input.current.value = "";
			onResolved();
		} catch {
			setError(message("chat:secret_request_save_failed"));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	const noteId = `secret-note-${request.id}`;
	return (
		<form
			aria-busy={busy || undefined}
			aria-describedby={noteId}
			className="border-b border-border/35 py-2 pl-3 pr-2 text-xs last:border-b-0"
			onSubmit={(event) => {
				event.preventDefault();
				void submit(false);
			}}
		>
			<div className="flex min-w-0 items-center gap-2">
				<KeyRound
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<label
					className="min-w-0 flex-1 truncate"
					htmlFor={`secret-${request.id}`}
				>
					<span className="font-medium text-foreground">{request.label}</span>
					{request.reason ? (
						<span className="text-muted-foreground"> · {request.reason}</span>
					) : null}
				</label>
				<button
					type="button"
					aria-label={message("common:cancel")}
					disabled={busy}
					className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
					onClick={() => void submit(true)}
				>
					<X size={14} />
				</button>
			</div>
			<div className="mt-1 flex items-center gap-1.5">
				<div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/50 px-2 focus-within:ring-1 focus-within:ring-ring/50">
					<Tooltip>
						<TooltipTrigger
							render={<span />}
							className="shrink-0 text-muted-foreground"
						>
							<Lock className="size-3" aria-hidden="true" />
						</TooltipTrigger>
						<TooltipPopup className="max-w-64">
							{message("chat:secret_request_availability", {
								name: request.environmentVariable,
							})}
						</TooltipPopup>
					</Tooltip>
					<input
						id={`secret-${request.id}`}
						ref={input}
						type="password"
						autoComplete="off"
						autoCapitalize="none"
						autoCorrect="off"
						data-1p-ignore
						data-lpignore="true"
						data-bwignore
						aria-invalid={error !== null || undefined}
						aria-describedby={noteId}
						placeholder={message("chat:secret_request_placeholder")}
						spellCheck={false}
						disabled={busy}
						required
						className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
					/>
				</div>
				<Button
					type="submit"
					disabled={busy}
					loading={busy}
					className="h-7 px-2.5 text-xs"
				>
					{message("common:save")}
				</Button>
			</div>
			<span id={noteId} className="sr-only">
				{message("chat:secret_request_availability", {
					name: request.environmentVariable,
				})}
			</span>
			{error && (
				<p role="alert" className="mt-1 text-[11px] text-danger-text">
					{error}
				</p>
			)}
		</form>
	);
}
