import type {
	DurableObjectNamespace,
	DurableObjectState,
} from "@cloudflare/workers-types";
import { takeCloudMailboxDirective } from "../../src/cloud-mailbox-directive.ts";
import { withoutResponseHeaders } from "../../src/http.ts";
import { makeCloudflarePluginHost } from "../../src/plugin-host-cloudflare.ts";
import {
	type PluginVaultEnv,
	PluginVault as Vault,
} from "../../src/plugin-vault.ts";

/** Test-only storage inspection. This class is never exported by the production Worker. */
export class PluginVault extends Vault {
	constructor(
		private readonly testState: DurableObjectState,
		env: PluginVaultEnv,
	) {
		super(testState, env);
	}
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__test/forget-reference") {
			await this.testState.storage.delete(
				`engine:alice:${url.searchParams.get("id")}`,
			);
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/__test/legacy-reference") {
			const key = `engine:alice:${url.searchParams.get("id")}`;
			const ref =
				await this.testState.storage.get<Record<string, unknown>>(key);
			if (!ref) return new Response(null, { status: 404 });
			const { plugin: _plugin, auth: _auth, ...legacy } = ref;
			await this.testState.storage.put(key, legacy);
			return new Response(null, { status: 204 });
		}
		if (new URL(request.url).pathname === "/__test/storage") {
			const tables = this.testState.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
				)
				.toArray();
			const rows = Object.fromEntries(
				tables.map(({ name }) => [
					name,
					this.testState.storage.sql
						.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
						.toArray(),
				]),
			);
			return Response.json({
				rows,
				kv: Object.fromEntries(await this.testState.storage.list()),
			});
		}
		return super.fetch(request);
	}
}
export default {
	async fetch(request: Request, env: { PLUGIN_VAULT: DurableObjectNamespace }) {
		const response = await makeCloudflarePluginHost(env.PLUGIN_VAULT).callback(
			request,
		);
		takeCloudMailboxDirective(response);
		return withoutResponseHeaders(response, ["x-zuse-reconcile-machine"]);
	},
};
