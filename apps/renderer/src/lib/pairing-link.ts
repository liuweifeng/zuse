import { type ConnectLinkKind, parseConnectLink } from "@zuse/contracts";

export type PairingLinkKind = ConnectLinkKind | "invalid";

export const describePairingLinkKind = (link: string): PairingLinkKind => {
	const result = parseConnectLink(link);
	return result.ok ? result.link.kind : "invalid";
};
