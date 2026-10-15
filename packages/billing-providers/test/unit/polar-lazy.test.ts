import { Effect, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";

const loads = vi.hoisted(() => ({
	sdk: 0,
	webhooks: 0,
	clients: [] as Array<{ readonly server?: string }>,
	checkouts: 0,
}));

vi.mock("@polar-sh/sdk", () => {
	loads.sdk += 1;
	class Polar {
		readonly checkouts = {
			create: async () => {
				loads.checkouts += 1;
				return { url: "https://sandbox.example/checkout" };
			},
		};
		constructor(options: { readonly server?: string }) {
			loads.clients.push(options);
		}
	}
	return { Polar };
});

vi.mock("@polar-sh/sdk/webhooks", () => {
	loads.webhooks += 1;
	class WebhookVerificationError extends Error {}
	return {
		WebhookVerificationError,
		validateEvent: (
			_body: string,
			headers: Record<string, string>,
			secret: string,
		) => {
			if (
				secret !== "polar_webhook_secret" ||
				headers["webhook-signature"] !== "v1,good"
			)
				throw new WebhookVerificationError("bad signature");
			return { type: "subscription.active", data: { id: "subscription_1" } };
		},
	};
});

import { makePolarBillingProvider } from "../../src/polar.ts";

const config = {
	accessToken: Redacted.make("polar_token"),
	environment: "sandbox" as const,
	webhookSecret: Redacted.make("polar_webhook_secret"),
	offerProducts: { pro: "product_pro" },
};

const webhook = (signature: string) =>
	new Request("https://api.test/v1/billing/webhook/polar", {
		method: "POST",
		headers: {
			"webhook-id": "event_1",
			"webhook-signature": signature,
			"webhook-timestamp": "0",
		},
		body: "{}",
	});

describe("Polar SDK lazy loading", () => {
	test("constructing the provider loads neither the SDK nor the webhook verifier", () => {
		makePolarBillingProvider(config);
		makePolarBillingProvider(config);
		expect(loads.sdk).toBe(0);
		expect(loads.webhooks).toBe(0);
		expect(loads.clients).toHaveLength(0);
	});

	test("the first real call loads the SDK once and constructs one client per provider", async () => {
		const provider = makePolarBillingProvider(config);
		const checkout = () =>
			Effect.runPromise(
				provider.checkout({
					accountId: "account_1",
					offerId: "pro",
					successUrl: "https://app.test/done",
					fulfillmentMetadata: {},
				}),
			);
		const [first, second] = await Promise.all([checkout(), checkout()]);
		expect(JSON.stringify(first)).toContain("https://sandbox.example/checkout");
		expect(JSON.stringify(second)).toContain(
			"https://sandbox.example/checkout",
		);
		expect(loads.sdk).toBe(1);
		expect(loads.clients).toHaveLength(1);
		expect(loads.clients[0]).toMatchObject({ server: "sandbox" });
		expect(loads.checkouts).toBe(2);
		expect(loads.webhooks).toBe(0);
	});

	test("webhook verification loads the verifier on first use and keeps rejecting bad signatures", async () => {
		const provider = makePolarBillingProvider(config);
		const invalid = await Effect.runPromise(
			provider.verifyEvent(webhook("v1,bad")).pipe(Effect.flip),
		);
		expect(invalid.code).toBe("invalid-event");
		expect(loads.webhooks).toBe(1);
		const verified = await Effect.runPromise(
			provider.verifyEvent(webhook("v1,good")),
		);
		expect(verified).toEqual({
			eventId: "event_1",
			subscriptionId: "subscription_1",
		});
		expect(loads.webhooks).toBe(1);
	});

	test("an injected verifier may be synchronous or asynchronous", async () => {
		const sync = makePolarBillingProvider(config, {
			verifyWebhook: () => ({ subscriptionId: "sync_1" }),
		});
		const async = makePolarBillingProvider(config, {
			verifyWebhook: async () => ({ subscriptionId: "async_1" }),
		});
		const rejecting = makePolarBillingProvider(config, {
			verifyWebhook: async () => {
				throw new Error("tampered");
			},
		});
		expect(
			await Effect.runPromise(sync.verifyEvent(webhook("v1,any"))),
		).toMatchObject({ subscriptionId: "sync_1" });
		expect(
			await Effect.runPromise(async.verifyEvent(webhook("v1,any"))),
		).toMatchObject({ subscriptionId: "async_1" });
		expect(
			(
				await Effect.runPromise(
					rejecting.verifyEvent(webhook("v1,any")).pipe(Effect.flip),
				)
			).code,
		).toBe("invalid-event");
	});
});
