/** Normal checkout and prepaid activation must subscribe to the same price items. */
export const stripeSubscriptionItems = (
	basePriceId: string,
	overagePriceId?: string,
): Array<{ price: string; quantity?: number }> => [
	{ price: basePriceId, quantity: 1 },
	...(overagePriceId ? [{ price: overagePriceId }] : []),
];
