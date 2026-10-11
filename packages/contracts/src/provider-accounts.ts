import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const NativeAccountProvider = Schema.Literals(["claude", "codex"]);
export type NativeAccountProvider = typeof NativeAccountProvider.Type;
export const ProviderAccount = Schema.Struct({
	id: Schema.String,
	providerId: NativeAccountProvider,
	name: Schema.String,
	preferred: Schema.Boolean,
});
export type ProviderAccount = typeof ProviderAccount.Type;
export class ProviderAccountError extends Schema.TaggedErrorClass<ProviderAccountError>()(
	"ProviderAccountError",
	{ message: Schema.String },
) {}
export const ProviderAccountsListRpc = Rpc.make("provider.accounts.list", {
	payload: {
		providerId: NativeAccountProvider,
		/** Also report the account this chat is bound to. */
		sessionId: Schema.optional(Schema.String),
	},
	success: Schema.Struct({
		available: Schema.Boolean,
		accounts: Schema.Array(ProviderAccount),
		/**
		 * Present when `sessionId` was given and the chat has started: the bound
		 * account id, or null for the default CLI login.
		 */
		sessionAccountId: Schema.optional(Schema.NullOr(Schema.String)),
	}),
	error: ProviderAccountError,
});
export const ProviderAccountsSaveRpc = Rpc.make("provider.accounts.save", {
	payload: {
		providerId: NativeAccountProvider,
		id: Schema.optional(Schema.String),
		name: Schema.String,
	},
	success: ProviderAccount,
	error: ProviderAccountError,
});
export const ProviderAccountsPreferredRpc = Rpc.make(
	"provider.accounts.preferred",
	{
		payload: {
			providerId: NativeAccountProvider,
			id: Schema.NullOr(Schema.String),
		},
		success: Schema.Void,
		error: ProviderAccountError,
	},
);
export const ProviderAccountsRemoveRpc = Rpc.make("provider.accounts.remove", {
	payload: { providerId: NativeAccountProvider, id: Schema.String },
	success: Schema.Void,
	error: ProviderAccountError,
});
/**
 * Move an idle chat to another account (null = default CLI login). Stops the
 * chat's provider process and copies its native transcript into the target
 * account's home, so the next turn resumes the same conversation there.
 */
export const ProviderAccountsSwitchSessionRpc = Rpc.make(
	"provider.accounts.switchSession",
	{
		payload: {
			providerId: NativeAccountProvider,
			sessionId: Schema.String,
			id: Schema.NullOr(Schema.String),
		},
		success: Schema.Void,
		error: ProviderAccountError,
	},
);
