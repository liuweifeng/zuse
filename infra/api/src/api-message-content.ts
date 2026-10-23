import { type ApiAsset, MessageSource } from "@zuse/contracts";
import { Option, Schema } from "effect";

const decodeMessageSource = Schema.decodeUnknownOption(MessageSource);

const PREFIX = "zuse-api-message-v1:";

export interface ApiMessageContent {
	readonly text: string;
	readonly githubBot?: boolean;
	readonly actor?: { readonly subject: string; readonly membershipId: string };
	readonly attachments: ReadonlyArray<ApiAsset>;
	readonly source?: MessageSource;
}

/**
 * Keep the sealed ledger column backwards compatible with its original plain
 * text format. Rich user messages use an explicit prefix so arbitrary JSON in
 * a prompt can never be mistaken for an envelope.
 */
export const encodeApiMessageContent = (content: ApiMessageContent): string =>
	`${PREFIX}${JSON.stringify({
		text: content.text,
		...(content.githubBot === true ? { githubBot: true } : {}),
		attachments: content.attachments,
		...(content.actor === undefined ? {} : { actor: content.actor }),
		...(content.source === undefined ? {} : { source: content.source }),
	})}`;

export const decodeApiMessageContent = (
	sealedPlaintext: string,
): ApiMessageContent => {
	if (!sealedPlaintext.startsWith(PREFIX))
		return { text: sealedPlaintext, attachments: [] };
	try {
		const decoded = JSON.parse(sealedPlaintext.slice(PREFIX.length)) as {
			readonly text?: unknown;
			readonly githubBot?: unknown;
			readonly actor?: {
				readonly subject?: unknown;
				readonly membershipId?: unknown;
			};
			readonly attachments?: unknown;
			readonly source?: unknown;
		};
		if (
			typeof decoded.text !== "string" ||
			!Array.isArray(decoded.attachments) ||
			!decoded.attachments.every(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					typeof (value as { readonly assetId?: unknown }).assetId ===
						"string" &&
					typeof (value as { readonly mimeType?: unknown }).mimeType ===
						"string" &&
					typeof (value as { readonly originalName?: unknown }).originalName ===
						"string" &&
					typeof (value as { readonly sizeBytes?: unknown }).sizeBytes ===
						"number",
			)
		)
			throw new Error("invalid API message envelope");
		const source =
			decoded.source === undefined
				? Option.none()
				: decodeMessageSource(decoded.source);
		return {
			text: decoded.text,
			...(decoded.githubBot === true ? { githubBot: true } : {}),
			attachments: decoded.attachments as ReadonlyArray<ApiAsset>,
			...(decoded.actor &&
			typeof decoded.actor.subject === "string" &&
			typeof decoded.actor.membershipId === "string"
				? {
						actor: {
							subject: decoded.actor.subject,
							membershipId: decoded.actor.membershipId,
						},
					}
				: {}),
			...(Option.isSome(source) ? { source: source.value } : {}),
		};
	} catch {
		return { text: sealedPlaintext, attachments: [] };
	}
};
