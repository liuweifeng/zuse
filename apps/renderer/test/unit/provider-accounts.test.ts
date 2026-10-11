import { describe, expect, it } from "vitest";
import { suggestAccountName } from "../../src/lib/provider-accounts.ts";

const account = (name: string) => ({
	id: name,
	providerId: "claude" as const,
	name,
	preferred: false,
});
const label = (index: number) => `Account ${index}`;

describe("suggestAccountName", () => {
	it("numbers after the default login", () => {
		expect(suggestAccountName([], label)).toBe("Account 2");
		expect(suggestAccountName([account("Work")], label)).toBe("Account 3");
	});
	it("skips names already in use", () => {
		expect(
			suggestAccountName([account("Account 3"), account("Personal")], label),
		).toBe("Account 4");
	});
});
