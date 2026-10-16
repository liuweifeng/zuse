import type { ProviderId } from "@zuse/contracts";
import { ProviderIcon } from "./provider-icons.tsx";

/**
 * Small provider tile for delegated work. The ring lets a group header
 * overlap several; agents without a provider fall back to their initial.
 */
export function DelegationAvatar({
	providerId,
	name,
}: {
	readonly providerId: ProviderId | null;
	readonly name: string;
}) {
	return (
		<span
			aria-hidden="true"
			className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium text-muted-foreground uppercase ring-2 ring-background"
		>
			{providerId !== null ? (
				<ProviderIcon providerId={providerId} className="size-3" />
			) : (
				(name.trim().at(0) ?? "")
			)}
		</span>
	);
}
