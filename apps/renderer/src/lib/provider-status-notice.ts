import "@zuse/i18n/english/shell";
import type { AgentAvailability } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

// Startup uses notices without loading the provider settings presentation helpers.
export interface ProviderStatusNotice {
	readonly key: string;
	readonly title: string;
	readonly description: string;
}

/**
 * Return a global notice only when the Codex binary exists but its app-server
 * status probe could not produce a definitive auth result. Install, update,
 * and sign-in states already have dedicated provider-card treatments.
 */
export function getProviderStatusNotice(
	availability: ReadonlyArray<AgentAvailability>,
): ProviderStatusNotice | null {
	const codex = availability.find((item) => item.providerId === "codex");
	if (
		codex?.authStatus !== "unknown" ||
		codex.statusMessage === undefined ||
		codex.statusMessage.trim().length === 0
	) {
		return null;
	}

	const statusMessage = codex.statusMessage.trim();
	const description = /tim(?:e|ed) ?out|timeout/i.test(statusMessage)
		? "Timed out while checking Codex app-server provider status."
		: /failed to initialize (?:sqlite )?state runtime/i.test(statusMessage)
			? "Codex app-server couldn't initialize local session state. Try again in a moment."
			: statusMessage;
	return {
		key: "codex-provider-status",
		title: uiMessage("shell:provider_status_codex_provider_status"),
		description,
	};
}
