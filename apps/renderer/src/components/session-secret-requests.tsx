import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsRuntimeRpc } from "@zuse/client-runtime/legacy-runtime-capabilities";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { SecretRequest } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect, Redacted } from "effect";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getVerifiedRpcClient } from "../lib/rpc-client.ts";
import { startVisibleInterval } from "../lib/visible-interval.ts";
import { Button } from "./ui/button.tsx";

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
				// A feature absent from an older runtime stays absent until reconnect/remount.
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
	return (
		<form
			className="mx-3 my-2 rounded-md bg-muted/40 px-3 py-2 text-xs"
			onSubmit={(event) => {
				event.preventDefault();
				void submit(false);
			}}
		>
			<div className="flex items-center gap-2 font-medium">
				<KeyRound className="size-3.5" aria-hidden="true" />
				<label htmlFor={`secret-${request.id}`}>{request.label}</label>
			</div>
			{request.reason && (
				<p className="mt-1 text-muted-foreground">{request.reason}</p>
			)}
			<p className="mt-1 text-muted-foreground">
				{message("chat:secret_request_availability", {
					name: request.environmentVariable,
				})}
			</p>
			<div className="mt-2 flex items-center gap-2">
				<input
					id={`secret-${request.id}`}
					ref={input}
					type="password"
					autoComplete="off"
					spellCheck={false}
					disabled={busy}
					required
					className="h-7 min-w-0 flex-1 rounded bg-background px-2 outline-none focus:ring-1 focus:ring-ring"
				/>
				<Button type="submit" disabled={busy} className="h-7 px-2 text-xs">
					{message("common:save")}
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={busy}
					className="h-7 px-2 text-xs"
					onClick={() => void submit(true)}
				>
					{message("common:cancel")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-1 text-destructive">
					{error}
				</p>
			)}
		</form>
	);
}
