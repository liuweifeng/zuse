import { setTimeout as delay } from "node:timers/promises";
import { HarnessModelError } from "./model.ts";
import type { HarnessModelInput, HarnessModelOutput } from "./types.ts";

export interface HarnessConnection {
	readonly id: string;
	readonly authorized: boolean;
	readonly preferred: boolean;
}
export interface ConnectionHealth {
	readonly reason: "exhausted" | "authentication" | "disconnected";
	readonly resetsAt?: number;
}
export interface AccountBrokerHost {
	/** Stable saved order; metadata only. */
	readonly connections: (
		input?: HarnessModelInput,
	) => Promise<readonly HarnessConnection[]>;
	readonly request: (
		connectionId: string,
		input: HarnessModelInput,
	) => Promise<HarnessModelOutput>;
	readonly switched: (
		rootId: string,
		previous: string | null,
		next: string,
	) => void;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly now?: () => number;
}
export class AccountsUnavailable extends Error {
	constructor() {
		super(
			"No eligible connection for this model. Reconnect or retry in connection settings.",
		);
	}
}
/** One shared broker for all roots and children. Token renewal never changes affinity. */
export class AccountBroker {
	private health = new Map<string, ConnectionHealth>();
	private affinity = new Map<string, string>();
	constructor(private readonly host: AccountBrokerHost) {}
	invalidate(
		id: string,
		reason: ConnectionHealth = { reason: "disconnected" },
	): void {
		this.health.set(id, reason);
	}
	removeRoot(rootId: string): void {
		this.affinity.delete(rootId);
	}
	forget(id: string): void {
		this.health.delete(id);
		for (const [root, active] of this.affinity)
			if (active === id) this.affinity.delete(root);
	}
	private eligible(id: string): boolean {
		const health = this.health.get(id);
		if (!health) return true;
		if (
			health.reason === "exhausted" &&
			health.resetsAt !== undefined &&
			health.resetsAt <= (this.host.now?.() ?? Date.now())
		) {
			this.health.delete(id);
			return true;
		}
		return false;
	}
	async request(input: HarnessModelInput): Promise<HarnessModelOutput> {
		const attempted = new Set<string>();
		let physicalRequests = 0;
		while (true) {
			input.signal.throwIfAborted();
			const connections = (await this.host.connections(input)).filter(
				(connection) =>
					connection.authorized &&
					!attempted.has(connection.id) &&
					this.eligible(connection.id),
			);
			const previous = this.affinity.get(input.rootId) ?? null;
			const connection =
				connections.find((c) => c.id === previous) ??
				connections.find((c) => c.preferred) ??
				connections[0];
			if (!connection) throw new AccountsUnavailable();
			attempted.add(connection.id);
			this.affinity.set(input.rootId, connection.id);
			if (previous !== connection.id)
				this.host.switched(input.rootId, previous, connection.id);
			for (let retry = 0; retry < 3; retry++) {
				try {
					if (physicalRequests++ > 0) await input.beforeRetry?.();
					input.signal.throwIfAborted();

					return await this.host.request(connection.id, {
						...input,
						messages: portableHistory(input.messages),
					});
				} catch (error) {
					input.signal.throwIfAborted();
					if (!(error instanceof HarnessModelError)) throw error;
					if (error.code === "subscription_sharing_usage_limit_exceeded") {
						this.invalidate(connection.id, { reason: "exhausted" });
						break;
					}
					if (error.status === 401) {
						this.invalidate(connection.id, { reason: "authentication" });
						throw error;
					}

					if (
						error.status !== 503 &&
						error.status !== 502 &&
						error.code !== "subscription_sharing_unavailable"
					)
						throw error;
					if (retry === 2) throw error;
					await (this.host.sleep?.(250 * 2 ** retry, input.signal) ??
						delay(250 * 2 ** retry, undefined, { signal: input.signal }));
				}
			}
		}
	}
}
/** Provider metadata may include account-bound encrypted reasoning or item IDs. */
export function portableHistory(
	messages: HarnessModelInput["messages"],
): HarnessModelInput["messages"] {
	return messages.map((message) => {
		const { providerOptions: _, ...rest } = message;
		if (!Array.isArray(rest.content)) return rest;
		return {
			...rest,
			content: rest.content
				.filter((part) => part.type !== "reasoning")
				.map((part) => {
					if (!("providerOptions" in part)) return part;
					const { providerOptions: _, ...portable } = part;
					return portable;
				}),
		} as typeof message;
	});
}
