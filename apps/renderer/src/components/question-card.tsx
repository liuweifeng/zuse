import "@zuse/i18n/english/chat";
import type { SessionInteractionSubmission } from "@zuse/client-runtime/session-presentation";
import type {
	AgentItemId,
	EnvironmentId,
	SessionId,
	UserQuestion,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useSessionsStore } from "../store/sessions.ts";
import { Button } from "./ui/button.tsx";

interface QuestionCardProps {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;

	readonly disabled?: boolean;
	readonly expired?: boolean;

	readonly submission?: SessionInteractionSubmission;
	readonly submissionError?: string | null;

	readonly answer?: ReadonlyArray<UserQuestionAnswer>;
}

interface DraftAnswer {
	readonly selected: ReadonlyArray<number>;
	readonly other: string;
}

const emptyDraft = (): DraftAnswer => ({ selected: [], other: "" });

const isComplete = (
	questions: ReadonlyArray<UserQuestion>,
	drafts: ReadonlyArray<DraftAnswer>,
): boolean =>
	questions.every((_q, i) => {
		const d = drafts[i];
		if (d === undefined) return false;
		return d.selected.length > 0 || d.other.trim().length > 0;
	});

export function QuestionCard({
	environmentId,
	sessionId,
	itemId,
	questions,
	disabled = false,
	expired = false,
	submission = "pending",
	submissionError = null,
	answer,
}: QuestionCardProps) {
	if (answer !== undefined) {
		return <AnsweredQuestionCard questions={questions} answer={answer} />;
	}
	return (
		<InteractiveQuestionCard
			environmentId={environmentId}
			key={itemId}
			sessionId={sessionId}
			itemId={itemId}
			questions={questions}
			disabled={disabled}
			expired={expired}
			submission={submission}
			submissionError={submissionError}
		/>
	);
}

function InteractiveQuestionCard({
	environmentId,
	sessionId,
	itemId,
	questions,
	disabled,
	expired,
	submission,
	submissionError,
}: {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly disabled: boolean;
	readonly expired: boolean;
	readonly submission: SessionInteractionSubmission;
	readonly submissionError: string | null;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const answerQuestion = useSessionsStore((s) => s.answerQuestion);
	const cancelQuestion = useSessionsStore((s) => s.cancelQuestion);
	const [activeIdx, setActiveIdx] = useState(0);
	const [drafts, setDrafts] = useState<ReadonlyArray<DraftAnswer>>(() =>
		questions.map(() => emptyDraft()),
	);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const authoritativeSubmitting = submission === "submitting";
	const interactionDisabled =
		disabled || expired || submitting || authoritativeSubmitting;
	useEffect(() => {
		if (!interactionDisabled) otherInputRef.current?.focus();
	}, [interactionDisabled]);
	const submitAnswers = async (
		answers: ReadonlyArray<UserQuestionAnswer>,
	): Promise<void> => {
		if (disabled || expired || authoritativeSubmitting || submittingRef.current)
			return;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			await answerQuestion(environmentId, sessionId, itemId, answers);
		} catch {
			submittingRef.current = false;
			setSubmitting(false);
		}
	};
	const cancel = async (): Promise<void> => {
		if (authoritativeSubmitting || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			await cancelQuestion(environmentId, sessionId, itemId);
		} catch {
			submittingRef.current = false;
			setSubmitting(false);
		}
	};
	const complete = useMemo(
		() => isComplete(questions, drafts),
		[questions, drafts],
	);

	const active = questions[activeIdx];
	if (active === undefined) return null;
	const draft = drafts[activeIdx] ?? emptyDraft();
	const multi = active.multiSelect === true;

	const setDraft = (idx: number, next: DraftAnswer): void => {
		setDrafts((prev) => prev.map((d, i) => (i === idx ? next : d)));
	};

	const submitWith = async (
		finalDrafts: ReadonlyArray<DraftAnswer>,
	): Promise<void> => {
		if (interactionDisabled) return;
		if (!isComplete(questions, finalDrafts)) return;
		const answers: ReadonlyArray<UserQuestionAnswer> = finalDrafts.map(
			(d, i) => ({
				questionIndex: i,
				selected: d.selected,
				...(d.other.trim().length > 0 ? { other: d.other.trim() } : {}),
			}),
		);
		await submitAnswers(answers);
	};

	const commitAndAdvance = (next: DraftAnswer): void => {
		const nextDrafts = drafts.map((d, i) => (i === activeIdx ? next : d));
		setDrafts(nextDrafts);
		const isLast = activeIdx === questions.length - 1;
		if (isLast) {
			void submitWith(nextDrafts);
		} else {
			setActiveIdx(activeIdx + 1);
		}
	};

	const toggleOption = (optionIdx: number): void => {
		if (multi) {
			const has = draft.selected.includes(optionIdx);
			const selected = has
				? draft.selected.filter((i) => i !== optionIdx)
				: [...draft.selected, optionIdx];
			setDraft(activeIdx, { ...draft, selected });
			return;
		}

		if (draft.selected.length === 1 && draft.selected[0] === optionIdx) {
			setDraft(activeIdx, { ...draft, selected: [] });
			return;
		}
		commitAndAdvance({ ...draft, selected: [optionIdx], other: "" });
	};

	const setOther = (text: string): void => {
		setDraft(activeIdx, { ...draft, other: text });
	};

	const onOtherKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		const trimmed = draft.other.trim();
		if (trimmed.length === 0) return;
		e.preventDefault();
		commitAndAdvance({ selected: [], other: trimmed });
	};

	const submit = (): void => {
		void submitWith(drafts);
	};

	return (
		<div
			className="rounded-xl bg-card/95 p-3 shadow-overlay-sm ring-1 ring-border/70"
			aria-busy={submitting || authoritativeSubmitting || undefined}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="text-[13px] font-medium leading-5 text-foreground">
					{active.question}
				</div>
				<button
					type="button"
					className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					aria-label={uiMessage("chat:question_card_dismiss")}
					disabled={submitting || authoritativeSubmitting}
					onClick={() => {
						void cancel();
					}}
				>
					<X size={16} strokeWidth={1.8} />
				</button>
			</div>
			{disabled || expired ? (
				<div className="mt-2 text-xs text-muted-foreground" role="status">
					{uiMessage(
						expired ? "chat:question_expired" : "chat:question_reconnecting",
					)}
				</div>
			) : null}
			{submission === "submitting" ? (
				<div className="mt-2 text-xs text-muted-foreground" role="status">
					{uiMessage("chat:answer_submitting")}
				</div>
			) : null}
			{submission === "failed" ? (
				<div className="mt-2 text-xs text-danger-text" role="alert">
					{uiMessage("chat:answer_submit_failed")}
					{submissionError === null ? null : `: ${submissionError}`}
				</div>
			) : null}

			<div className="mt-2 flex flex-col gap-0.5">
				{active.options.map((opt, i) => {
					const picked = draft.selected.includes(i);
					return (
						<button
							key={`${activeIdx}-${i}`}
							type="button"
							disabled={interactionDisabled}
							className={cn(
								"flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
								picked
									? "bg-accent/70 text-foreground"
									: "hover:bg-accent/40 text-foreground/90",
							)}
							onClick={() => toggleOption(i)}
						>
							<span
								className={cn(
									"grid size-3.5 shrink-0 place-items-center border border-muted-foreground/45",
									multi ? "rounded-[3px]" : "rounded-full",
									picked && "border-primary text-primary",
								)}
							>
								{picked ? (
									multi ? (
										<Check className="size-2.5" strokeWidth={2.5} />
									) : (
										<span className="size-1.5 rounded-full bg-primary" />
									)
								) : null}
							</span>
							<span className="text-xs leading-4">{opt}</span>
						</button>
					);
				})}

				<label className="mt-1 flex h-7 items-center gap-2 rounded-md bg-muted/35 px-2 focus-within:ring-1 focus-within:ring-ring/60">
					<span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/45" />
					<input
						ref={otherInputRef}
						type="text"
						value={draft.other}
						disabled={interactionDisabled}
						onChange={(e) => setOther(e.target.value)}
						onKeyDown={onOtherKeyDown}
						placeholder={uiMessage("chat:question_card_other_answer")}
						className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
					/>
				</label>
			</div>

			<div className="mt-2 flex items-center justify-between">
				{questions.length > 1 ? (
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<button
							type="button"
							aria-label={uiMessage("chat:question_card_previous_question")}
							disabled={interactionDisabled || activeIdx === 0}
							onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
							className="rounded p-1 hover:text-foreground disabled:opacity-30"
						>
							<ChevronLeft size={14} />
						</button>
						{questions.map((_, i) => {
							const answered =
								(drafts[i]?.selected.length ?? 0) > 0 ||
								(drafts[i]?.other.trim().length ?? 0) > 0;
							return (
								<span
									key={i}
									className={cn(
										"h-1.5 w-1.5 rounded-full",
										i === activeIdx
											? "bg-foreground"
											: answered
												? "bg-foreground/60"
												: "bg-muted-foreground/40",
									)}
								/>
							);
						})}
						<button
							type="button"
							aria-label={uiMessage("chat:question_card_next_question")}
							disabled={
								interactionDisabled || activeIdx === questions.length - 1
							}
							onClick={() =>
								setActiveIdx((i) => Math.min(questions.length - 1, i + 1))
							}
							className="rounded p-1 hover:text-foreground disabled:opacity-30"
						>
							<ChevronRight size={14} />
						</button>
					</div>
				) : (
					<span />
				)}
				<Button
					size="xs"
					aria-label={uiMessage("chat:question_card_submit_answer")}
					disabled={!complete || interactionDisabled}
					onClick={submit}
					loading={interactionDisabled}
				>
					{uiMessage("chat:question_card_submit_answer")}
				</Button>
			</div>
		</div>
	);
}

function AnsweredQuestionCard({
	questions,
	answer,
}: {
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly answer: ReadonlyArray<UserQuestionAnswer>;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	return (
		<div className="rounded-lg bg-card/80 p-3 text-xs text-foreground/90 ring-1 ring-border/60">
			{questions.map((q, i) => {
				const a = answer.find((x) => x.questionIndex === i);
				const picks = (a?.selected ?? []).map(
					(idx) => q.options[idx] ?? `#${idx}`,
				);
				const other = a?.other?.trim() ?? "";
				return (
					<div key={i} className={i === 0 ? "" : "mt-2"}>
						<div className="text-foreground/70">{q.question}</div>
						<div className="mt-0.5 text-foreground">
							{picks.length > 0 ? picks.join(", ") : null}
							{picks.length > 0 && other.length > 0 ? " · " : null}
							{other.length > 0 ? (
								<span className="italic">{other}</span>
							) : null}
							{picks.length === 0 && other.length === 0 ? (
								<span className="italic text-muted-foreground">
									{uiMessage("chat:question_card_cancelled")}
								</span>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}
