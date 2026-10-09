import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createPiPluginExtension } from "../../../src/drivers/pi-plugin-extension.ts";

test("Pi registers live orchestration schemas with required and optional fields intact", async () => {
	const schema = {
		type: "object",
		properties: { task: { type: "string" }, timeoutMs: { type: "number" } },
		required: ["task"],
	};
	const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({
			tools: [
				{
					name: "delegate_task",
					description: "Delegate",
					inputSchema: schema,
				},
			],
		}),
	);
	try {
		const extension = await createPiPluginExtension({
			name: "zuse",
			transport: "http",
			url: "http://127.0.0.1:1234/mcp",
			headers: { Authorization: "Bearer session" },
		});
		try {
			const source = await readFile(extension.file, "utf8");
			expect(source).toContain('"name":"delegate_task"');
			expect(source).toContain(JSON.stringify(schema));
			expect(source).toContain("Type.Unsafe(tool.inputSchema)");
			expect(source).toContain("/orchestration");
			expect(source).toContain("/plugins");
		} finally {
			await extension.close();
		}
	} finally {
		fetcher.mockRestore();
	}
});

test("Pi preserves plugin-only sessions when orchestration scope is disabled", async () => {
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("unavailable", { status: 403 }));
	try {
		const extension = await createPiPluginExtension({
			name: "zuse",
			transport: "http",
			url: "http://127.0.0.1:1234/mcp",
		});
		try {
			expect(await readFile(extension.file, "utf8")).not.toContain(
				'"name":"delegate_task"',
			);
		} finally {
			await extension.close();
		}
	} finally {
		fetcher.mockRestore();
	}
});
