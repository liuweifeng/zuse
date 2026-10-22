import "@zuse/i18n/english/projects";
import { MasterAction, type MasterSnapshot } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Schema } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { masterCapabilities } from "../../lib/master-capabilities.ts";
import { masterScreenDocument } from "../../lib/master-screen.ts";
import { Button } from "../ui/button.tsx";

type PendingAction = {
	id: number;
	action:
		| MasterAction
		| { _tag: "openChat"; environmentId: string; chatId: string };
	port: MessagePort;
};
type MasterScreenProps = {
	content: string;
	snapshot: MasterSnapshot;
	execute: (action: MasterAction) => Promise<void>;
	openChat: (environmentId: string, chatId: string) => void;
};

/**
 * A Zot-generated screen. Its HTML only runs, in a sandboxed iframe, when the
 * server enables `generatedScreens`; otherwise the source is shown as inert
 * text. Keep this the only entry point so no caller can mount the iframe.
 */
export function MasterScreen(props: MasterScreenProps) {
	const { message } = useMessages("projects");
	if (masterCapabilities(props.snapshot).generatedScreens)
		return <SandboxedScreen {...props} />;
	return (
		<>
			<p className="py-2 text-[11px] text-muted-foreground">
				{message("projects:masters_generated_screen_unavailable")}
			</p>
			<pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-4 text-muted-foreground">
				{props.content}
			</pre>
		</>
	);
}

function SandboxedScreen({
	content,
	snapshot,
	execute,
	openChat,
}: MasterScreenProps) {
	const { message } = useMessages("projects");

	const frame = useRef<HTMLIFrameElement>(null);
	const port = useRef<MessagePort | null>(null);
	const connected = useRef(new WeakSet<HTMLIFrameElement>());
	const [failed, setFailed] = useState(false);
	const executing = useRef(false);
	const [running, setRunning] = useState(false);
	const currentSnapshot = useRef(snapshot);
	currentSnapshot.current = snapshot;
	const [pending, setPending] = useState<PendingAction | null>(null);
	const pendingRef = useRef(false);
	const [hidden, setHidden] = useState(false);
	const document = useMemo(() => masterScreenDocument(content), [content]);
	useEffect(() => () => port.current?.close(), []);
	const connect = () => {
		const element = frame.current;
		if (!element || connected.current.has(element)) {
			port.current?.close();
			setFailed(true);
			setPending(null);
			return;
		}
		connected.current.add(element);
		port.current?.close();
		pendingRef.current = false;
		setPending(null);
		const channel = new MessageChannel();
		port.current = channel.port1;
		channel.port1.onmessage = (event: MessageEvent<unknown>) => {
			const data = event.data;
			if (
				!data ||
				typeof data !== "object" ||
				!("id" in data) ||
				!("kind" in data) ||
				!("payload" in data) ||
				typeof data.id !== "number"
			)
				return;
			const reply = (result: unknown, error?: string) =>
				channel.port1.postMessage({ id: data.id, result, error });
			if (data.kind === "read") {
				reply(currentSnapshot.current);
				return;
			}
			if (data.kind === "openChat") {
				const payload = data.payload;
				if (
					payload &&
					typeof payload === "object" &&
					"environmentId" in payload &&
					"chatId" in payload
				) {
					const chat = currentSnapshot.current.chats.find(
						(chat) =>
							chat.repository.environmentId === payload.environmentId &&
							chat.chat.id === payload.chatId,
					);
					if (chat) {
						if (pendingRef.current) {
							reply(null, "An action is already awaiting your decision.");
							return;
						}
						pendingRef.current = true;
						setPending({
							id: data.id,
							action: {
								_tag: "openChat",
								environmentId: chat.repository.environmentId,
								chatId: chat.chat.id,
							},
							port: channel.port1,
						});
						return;
					}
				}
				reply(null, "Chat is outside this Zot.");
				return;
			}
			if (data.kind !== "action") {
				reply(null, "Unsupported request.");
				return;
			}
			try {
				const action = Schema.decodeUnknownSync(MasterAction)(data.payload);
				if (!["message", "interrupt", "entry", "worker"].includes(action._tag))
					throw new Error(
						"This action is available through the native Zot controls.",
					);
				if (pendingRef.current)
					throw new Error("An action is already awaiting your decision.");
				pendingRef.current = true;
				setPending({ id: data.id, action, port: channel.port1 });
			} catch (cause) {
				reply(null, cause instanceof Error ? cause.message : "Invalid action.");
			}
		};
		frame.current?.contentWindow?.postMessage("zuse-master-connect", "*", [
			channel.port2,
		]);
	};
	const decide = async (allow: boolean) => {
		if (!pending || executing.current) return;
		executing.current = true;
		setRunning(true);
		try {
			if (allow) {
				if (pending.action._tag === "openChat")
					openChat(pending.action.environmentId, pending.action.chatId);
				else await execute(pending.action);
			}
			pending.port.postMessage({
				id: pending.id,
				result: allow,
				error: allow ? undefined : "Action declined.",
			});
		} catch (cause) {
			pending.port.postMessage({
				id: pending.id,
				error: cause instanceof Error ? cause.message : "Action failed.",
			});
		} finally {
			pendingRef.current = false;
			executing.current = false;
			setRunning(false);
			setPending(null);
		}
	};
	const pendingLabel =
		pending === null
			? null
			: pending.action._tag === "entry" || pending.action._tag === "message"
				? pending.action.text
				: pending.action._tag === "interrupt"
					? message("projects:masters_stop_agent")
					: pending.action._tag === "openChat"
						? message("projects:masters_open_chat")
						: pending.action._tag === "worker" &&
								pending.action.state === "done"
							? message("projects:masters_mark_done")
							: message("projects:masters_resume");
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="flex h-7 items-center justify-between text-[11px] text-muted-foreground">
				<span>{message("projects:masters_generated_screen")}</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						port.current?.close();
						setPending(null);
						pendingRef.current = false;
						setFailed(false);
						setHidden(!hidden);
					}}
				>
					{hidden
						? message("projects:masters_show_screen")
						: message("projects:masters_hide_screen")}
				</Button>
			</div>
			{pending && (
				<div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/35 px-3 py-2">
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium text-foreground">
							{message("projects:masters_this_screen_requests_an_action")}
						</p>
						<p className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
							{pendingLabel}
						</p>
					</div>
					<div className="flex shrink-0 gap-1.5">
						<Button
							variant="ghost"
							disabled={running}
							onClick={() => void decide(false)}
						>
							{message("projects:masters_decline")}
						</Button>
						<Button
							loading={running}
							disabled={running}
							onClick={() => void decide(true)}
						>
							{message("projects:masters_run_action")}
						</Button>
					</div>
				</div>
			)}
			{failed && (
				<p role="alert" className="text-xs text-destructive">
					{message("projects:masters_screen_failed")}
				</p>
			)}
			{!hidden && !failed && (
				<iframe
					ref={frame}
					title={message("projects:masters_master_generated_screen")}
					sandbox="allow-scripts"
					referrerPolicy="no-referrer"
					srcDoc={document}
					onLoad={connect}
					className="min-h-80 w-full flex-1 rounded-lg border-0 bg-muted/20"
				/>
			)}
		</div>
	);
}
