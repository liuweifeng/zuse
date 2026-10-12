import "@zuse/i18n/english/chat";
import type { Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { useId, useRef } from "react";
import { isToolTreeBranch } from "../lib/chat-timeline-rows.ts";
import { useTranscriptDisclosure } from "../store/transcript-disclosures.ts";
import { MessageRow } from "./message-row.tsx";

/** One disclosure owns the activity between text messages. */
export function ToolActivityTree({
	messages,
	live = false,
	...rowProps
}: {
	readonly messages: readonly Message[];
	readonly live?: boolean;
} & Omit<ComponentProps<typeof MessageRow>, "message">) {
	const { message } = useMessages(["chat"]);
	const [open, toggleOpen] = useTranscriptDisclosure(
		JSON.stringify([
			rowProps.environmentId,
			rowProps.sessionId ?? messages[0]?.sessionId,
			messages[0]?.id,
			"tools",
			live ? "live" : "settled",
		]),
		live,
	);
	const id = useId();
	const reduce = useReducedMotion();
	const initialIds = useRef(new Set(messages.map((item) => item.id)));
	const lastBranchId = messages.findLast(isToolTreeBranch)?.id;
	const count = messages.filter((m) => m.content._tag === "tool_use").length;
	return (
		<div className="py-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					// Opening existing activity should not replay streaming height animations.
					initialIds.current = new Set(messages.map((item) => item.id));
					toggleOpen();
				}}
				className="flex h-7 items-center gap-2 rounded ps-3 pe-4 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronDown
					aria-hidden
					className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
				/>
				<span className="tabular-nums">{count}</span>
				<span>
					{message("chat:turn_summary_tool")}
					{count === 1
						? message("chat:turn_summary_call")
						: message("chat:turn_summary_calls")}
				</span>
			</button>
			<div id={id} hidden={!open} className="tool-activity-tree">
				{open
					? messages
							.filter(
								(item) =>
									item.content._tag !== "assistant" ||
									item.content.text.trim().length > 0,
							)
							.map((item) => (
								<motion.div
									initial={
										reduce || !live || initialIds.current.has(item.id)
											? false
											: { height: 0, y: -6 }
									}
									animate={{ height: "auto", y: 0 }}
									transition={{
										duration: reduce ? 0 : 0.28,
										ease: [0.22, 1, 0.36, 1],
									}}
									key={item.id}
									className={
										isToolTreeBranch(item)
											? `overflow-hidden tool-activity-branch ${item.id === lastBranchId ? "tool-activity-last" : ""}`
											: "overflow-hidden"
									}
								>
									<MessageRow {...rowProps} message={item} />
								</motion.div>
							))
					: null}
			</div>
		</div>
	);
}
