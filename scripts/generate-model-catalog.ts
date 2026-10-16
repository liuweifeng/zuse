#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

import {
	BUNDLED_MODEL_CATALOG,
	ModelCatalog,
} from "../packages/contracts/src/model-catalog/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "apps", "web", "public", "models", "v1.json");
const check = process.argv.includes("--check");

const encoded = Schema.encodeSync(ModelCatalog)(BUNDLED_MODEL_CATALOG);
const next = `${JSON.stringify(encoded, null, 2)}\n`;
const current = existsSync(outputPath)
	? readFileSync(outputPath, "utf8")
	: null;

if (current === next) {
	console.log(`Model catalog up to date (revision ${encoded.revision}).`);
	process.exit(0);
}

if (current !== null) {
	let previousRevision: number | null = null;
	try {
		const parsed = JSON.parse(current) as { revision?: unknown };
		previousRevision =
			typeof parsed.revision === "number" ? parsed.revision : null;
	} catch {
		previousRevision = null;
	}
	if (previousRevision !== null && previousRevision >= encoded.revision) {
		console.error(
			`Model catalog content changed but revision ${encoded.revision} is not newer than the published ${previousRevision}.\n` +
				"Bump `revision` in packages/contracts/src/model-catalog/bundled.ts (format YYYYMMDDNN).",
		);
		process.exit(1);
	}
}

if (check) {
	console.error(
		`apps/web/public/models/v1.json is stale. Run \`bun run catalog:generate\` and commit the result.`,
	);
	process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, next);
console.log(
	`Wrote model catalog revision ${encoded.revision} to ${outputPath}`,
);
