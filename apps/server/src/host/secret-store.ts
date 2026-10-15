import keytar from "keytar";

export interface SecretStore {
	readonly get: (service: string, account: string) => Promise<string | null>;
	readonly set: (
		service: string,
		account: string,
		secret: string,
	) => Promise<void>;
	readonly delete: (service: string, account: string) => Promise<boolean>;
}

export const nativeSecretStore: SecretStore = {
	get: (service, account) => keytar.getPassword(service, account),
	set: async (service, account, secret) => {
		await keytar.setPassword(service, account, secret);
	},
	delete: (service, account) => keytar.deletePassword(service, account),
};
