import { randomUUID } from "node:crypto";
import { isOrchestrationToolName } from "@zuse/agents/drivers/orchestration-tools";
import type { HarnessEngine } from "@zuse/agents/harness/engine";
import type { HarnessEvent } from "@zuse/agents/harness/types";
import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import { normalizeNativeToolName } from "@zuse/agents/kernel/native-tool-name";
import { ProviderCheckpointBatcher } from "@zuse/agents/kernel/provider-checkpoint-batcher";
import {
	makeBoundedQuestionCallbackRegistry,
	validateUserQuestionAnswers,
} from "@zuse/agents/kernel/user-question-answer";
import {
	type AgentEvent,
	AgentItemId,
	type AgentSessionId,
	type PermissionMode,
	type UserQuestion,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";
import type { NativeRuntimeOptions } from "./native-runtime.ts";

export interface HarnessSessionOptions {
	readonly sessionId: AgentSessionId;
	readonly rootId: string;
	readonly model: string;
	readonly permissionMode: PermissionMode;
	readonly create: (
		callbacks: Pick<NativeRuntimeOptions["host"], "notify"> &
			Pick<NativeRuntimeOptions["tools"], "question" | "plan">,
	) => Promise<HarnessEngine>;
	readonly prepare: (
		text: string,
		attachments: Parameters<ProviderSessionHandle["send"]>[1],
		files: Parameters<ProviderSessionHandle["send"]>[2],
		skills: Parameters<ProviderSessionHandle["send"]>[3],
	) => Promise<{
		text: string;
		images: Array<{ mediaType: string; data: string }>;
	}>;
	readonly onClose: () => void;
}

/** Bridges the durable engine into the same event and callback protocol as every other driver. */
export const makeHarnessSession = (options: HarnessSessionOptions) =>
	Effect.gen(function* () {
		const queue = yield* Queue.make<AgentEvent, Cause.Done>();
		const emit = (event: AgentEvent) => {
			Queue.offerUnsafe(queue, event);
		};
		const batcher = new ProviderCheckpointBatcher({ emit });
		const texts = new Map<
			string,
			{
				text: string;
				revision: number;
				agentId: string;
				parentItemId?: AgentItemId;
			}
		>();
		const questions = makeBoundedQuestionCallbackRegistry<{
			questions: UserQuestion[];
			resolve: (text: string) => void;
			reject: (error: Error) => void;
		}>();
		let engine: HarnessEngine;
		let closed = false;
		let active = false;
		let stopping = false;
		let turn: Promise<void> | null = null;
		let outcome: "ended" | "interrupted" | "error" = "ended";
		const parent = (id: string) => {
			const item = engine?.agentInfo(id).parentItemId;
			return item ? { parentItemId: AgentItemId.make(item) } : {};
		};
		const flush = (agentId?: string) => {
			for (const [id, value] of texts) {
				if (agentId && value.agentId !== agentId) continue;
				batcher.offer({
					_tag: "AssistantMessage",
					itemId: AgentItemId.make(id),
					text: value.text,
					checkpoint: { revision: value.revision + 1, final: true },
					...(value.parentItemId ? { parentItemId: value.parentItemId } : {}),
				});
				texts.delete(id);
			}
		};
		const notify = (event: HarnessEvent) => {
			if (closed) return;
			const attribution = parent(event.agentId);
			switch (event.type) {
				case "account":
					if (!event.switched) break;
					emit({
						_tag: "AssistantMessage",
						itemId: AgentItemId.make(randomUUID()),
						text: `Switched to connection: ${event.name}`,
						checkpoint: { revision: 1, final: true },
					});
					break;
				case "text": {
					const prior = texts.get(event.itemId);
					const next = {
						agentId: event.agentId,
						text: (prior?.text ?? "") + event.text,
						revision: (prior?.revision ?? 0) + 1,
						...attribution,
					};
					texts.set(event.itemId, next);
					batcher.offer({
						_tag: "AssistantMessage",
						itemId: AgentItemId.make(event.itemId),
						text: next.text,
						checkpoint: { revision: next.revision, final: false },
						...attribution,
					});
					break;
				}
				case "tool-start": {
					flush(event.agentId);
					const args =
						event.call.input && typeof event.call.input === "object"
							? event.call.input
							: {};
					const path = Reflect.get(args, "path");
					emit({
						_tag: "ToolUse",
						itemId: AgentItemId.make(event.call.id),
						tool: isOrchestrationToolName(event.call.name)
							? `mcp__zuse__${event.call.name}`
							: normalizeNativeToolName(event.call.name),
						input: {
							...args,
							...(event.call.name === "spawn_agent"
								? {
										prompt: Reflect.get(args, "message"),
										description: Reflect.get(args, "name"),
									}
								: {}),
							...(typeof path === "string" ? { file_path: path } : {}),
						},
						...attribution,
					});
					break;
				}
				case "tool-result":
					emit({
						_tag: "ToolResult",
						itemId: AgentItemId.make(event.callId),
						output: event.output,
						isError:
							typeof event.output === "string" &&
							event.output.startsWith("Tool failed:"),
						...attribution,
					});
					break;
				case "usage":
					flush(event.agentId);
					emit({
						_tag: "UsageDelta",
						inputTokens: event.usage.inputTokens,
						outputTokens: event.usage.outputTokens,
						cacheReadTokens: event.usage.cachedTokens ?? 0,
						cacheCreationTokens: event.usage.cacheWriteTokens ?? 0,
						model: options.model,
						...attribution,
					});
					break;
				case "context":
					if (event.agentId === options.rootId)
						emit({
							_tag: "ContextUsage",
							providerId: "zuse",
							usedTokens: event.usedTokens,
							windowTokens: event.windowTokens,
							precision: "estimated",
							source: "Zuse context estimate",
						});
					break;
				case "compaction":
					if (event.agentId !== options.rootId) break;
					emit({
						_tag: "ContextCompaction",
						itemId: AgentItemId.make(event.itemId),
						providerId: "zuse",
						startedAt: event.startedAt,
						durationMs: Date.now() - event.startedAt,
						beforeTokens: event.before,
						afterTokens: event.after,
						status: event.status,
					});
					break;
				case "paused":
					flush(event.agentId);
					if (event.agentId === options.rootId) {
						outcome = stopping ? "interrupted" : "error";
						if (!stopping)
							emit({
								_tag: "Error",
								providerId: "zuse",
								message: event.reason,
							});
					}
					break;
				case "completed": {
					flush(event.agentId);
					if (event.agentId !== options.rootId) {
						const child = engine.agentInfo(event.agentId);
						if (child?.parentItemId)
							emit({
								_tag: "SubagentSummary",
								itemId: AgentItemId.make(child.parentItemId),
								agentName: child.name,
								model: options.model,
								turns: child.turns,
								durationMs: 0,
								summary: event.summary,
								isError: false,
								childSessionId: child.id,
								presentation: "inline",
							});
					}
					break;
				}
			}
		};
		const cancelQuestion = (id: string) => {
			const pending = questions.get(id);
			if (!pending) return;
			questions.delete(id);
			pending.reject(new Error("Question cancelled"));
			emit({
				_tag: "UserQuestionResolved",
				itemId: AgentItemId.make(id),
				resolution: "cancelled",
			});
		};
		engine = yield* Effect.tryPromise(async (signal) => {
			const created = await options.create({
				notify,
				question: (input, context) =>
					new Promise<string>((resolve, reject) => {
						context.signal.throwIfAborted();
						const abort = () => cancelQuestion(context.callId);
						const finish = (fn: () => void) => {
							context.signal.removeEventListener("abort", abort);
							fn();
						};
						const qs = [
							{ question: input.question, options: input.options ?? [] },
						];
						const accepted = questions.register(context.callId, {
							questions: qs,
							resolve: (text) => finish(() => resolve(text)),
							reject: (error) => finish(() => reject(error)),
						});
						if (accepted !== "accepted") {
							reject(new Error("Question callback capacity reached"));
							return;
						}
						context.signal.addEventListener("abort", abort, { once: true });
						emit({
							_tag: "UserQuestion",
							itemId: AgentItemId.make(context.callId),
							questions: qs,
							...parent(context.agentId),
						});
					}),
				plan: async (steps, context) => {
					emit({
						_tag: "ToolUse",
						itemId: AgentItemId.make(context.callId),
						tool: "TodoWrite",
						input: {
							todos: steps.map((s) => ({
								content: s.step,
								status: s.status,
								activeForm: s.step,
							})),
						},
						...parent(context.agentId),
					});
				},
			});
			if (signal.aborted) {
				await created.close();
				options.onClose?.();
				signal.throwIfAborted();
			}
			return created;
		});
		engine.setPermissionMode(options.permissionMode);
		emit({
			_tag: "Started",
			sessionId: options.sessionId,
			providerId: "zuse",
			mode: "sdk",
		});
		emit({
			_tag: "SessionCursor",
			cursor: options.rootId,
			strategy: "zuse-execution-id",
		});
		emit({ _tag: "Auth", sdkConfigured: true });
		const attempt = (fn: () => Promise<void>) =>
			Effect.tryPromise(fn).pipe(
				Effect.catch(() =>
					Effect.sync(() =>
						emit({
							_tag: "Error",
							providerId: "zuse",
							message:
								"Zuse could not complete this operation. Check the connection and retry.",
						}),
					),
				),
			);
		const handle: ProviderSessionHandle = {
			events: Stream.fromQueue(queue),
			send: (text, attachments, files, skills) =>
				attempt(async () => {
					if (closed || active)
						throw new Error("Zuse session is closed or busy");
					active = true;
					stopping = false;
					outcome = "ended";
					try {
						const prepared = await options.prepare(
							text,
							attachments,
							files,
							skills,
						);
						if (closed || stopping) {
							active = false;
							emit({ _tag: "Interrupted" });
							return;
						}
						turn = engine
							.send(prepared.text, prepared.images)
							.catch(() => {
								outcome = "error";
								emit({
									_tag: "Error",
									providerId: "zuse",
									message:
										"Execution could not be persisted. Reopen this chat before continuing.",
								});
							})
							.finally(() => {
								flush();
								active = false;
								turn = null;
								if (!closed)
									emit(
										outcome === "interrupted"
											? { _tag: "Interrupted" }
											: { _tag: "Completed", reason: outcome },
									);
							});
					} catch (error) {
						active = false;
						throw error;
					}
				}),
			interrupt: () =>
				attempt(async () => {
					stopping = true;
					outcome = "interrupted";
					for (const [id, pending] of questions.drain()) {
						pending.reject(new Error("Interrupted"));
						emit({
							_tag: "UserQuestionResolved",
							itemId: AgentItemId.make(id),
							resolution: "cancelled",
						});
					}
					await engine.interrupt();
					await turn;
				}),
			close: () =>
				attempt(async () => {
					if (closed) return;
					stopping = true;
					for (const [, pending] of questions.drain())
						pending.reject(new Error("Closed"));
					await engine.close();
					await turn;
					flush();
					closed = true;
					options.onClose();
					await Effect.runPromise(Queue.end(queue));
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					engine.setPermissionMode(mode);
					emit({ _tag: "PermissionModeChanged", mode });
				}),
			answerQuestion: (id, answers) =>
				Effect.try({
					try: () => {
						const pending = questions.get(id);
						if (!pending) throw new Error("Question is no longer pending");
						const issue = validateUserQuestionAnswers(
							pending.questions,
							answers,
						);
						if (issue) throw new Error(`Invalid answer: ${issue.code}`);
						questions
							.take(id)
							.resolve(formatAnswer(pending.questions, answers));
					},
					catch: (error) =>
						error instanceof Error ? error : new Error("Invalid answer"),
				}),
			cancelQuestion: (id) => Effect.sync(() => cancelQuestion(id)),
		};
		return handle;
	});
function formatAnswer(
	questions: UserQuestion[],
	answers: ReadonlyArray<UserQuestionAnswer>,
): string {
	return answers
		.map((a) =>
			[
				...a.selected.map((i) => questions[a.questionIndex]?.options[i] ?? ""),
				a.other ?? "",
			]
				.filter(Boolean)
				.join(", "),
		)
		.join("\n");
}
