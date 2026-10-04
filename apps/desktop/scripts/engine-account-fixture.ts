import assert from "node:assert/strict";
import { createServer } from "node:http";

/** A linked account whose HTTP server accepts requests but never responds. */
export const startEngineAccountOutage = async () => {
	const requests: string[] = [];
	const server = createServer((request) => {
		requests.push(request.url ?? "");
		request.resume();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
};
