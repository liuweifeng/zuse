import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
	type AgentEvent,
	type AgentItemId,
	isRedundantShellDescription,
} from "@zuse/contracts";
import { CheckpointFlushScheduler } from "../../kernel/provider-checkpoint-batcher.ts";
import { appendStreamText } from "../../kernel/stream-text.ts";

/**
 * Shared translator for Agent Client Protocol (ACP) `session/update` frames.
 * Lifted out of grok.ts / gemini.ts / cursor.ts which each carried a near-
 * identical copy. The renderer expects every provider's tool calls to look
 * like Claude's (see the "Normalized Tool-Call Contract" doc-block above
 * `ToolUseEvent` in `packages/contracts/src/agent.ts`), so this translator
 * coerces ACP frames into that shape.
 *
 * Per-provider quirks (Gemini's `kind === "think"` skip, etc.) live in a
 * single `provider` switch instead of three forks of the same function.
 *
 * Set `MEMOIZE_DEBUG_ACP=1` to trace every translator decision to stderr
 * (kind, status, what events were emitted). Pair with `MEMOIZE_DEBUG_<P>`
 * (GEMINI/GROK/CURSOR) for raw JSON-RPC frame logs in the drivers.
 */

export type AcpProviderTag = "grok" | "gemini" | "cursor" | "kiro" | "generic";

const ACP_TRACE = process.env.MEMOIZE_DEBUG_ACP === "1";

const trace = (provider: AcpProviderTag, msg: string): void => {
	if (!ACP_TRACE) return;
	process.stderr.write(`[acp.${provider}] ${msg}\n`);
};

const safePreview = (v: unknown, max = 240): string => {
	try {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		if (s === undefined) return "undefined";
		return s.length > max ? `${s.slice(0, max - 1)}…` : s;
	} catch {
		return "(unserialisable)";
	}
};

const toolInputFingerprint = (input: unknown): string =>
	(() => {
		try {
			return JSON.stringify({ input: canonicalizeToolInput(input) });
		} catch {
			return String(input);
		}
	})();

let itemCounter = 0;
const nextItemId = (): AgentItemId =>
	`i_acp_${Date.now()}_${++itemCounter}` as AgentItemId;

const tryParseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

const asText = (v: unknown): string | null => {
	if (typeof v === "string") return v;
	if (v !== null && typeof v === "object" && "text" in v) {
		const t = (v as { text: unknown }).text;
		return typeof t === "string" ? t : null;
	}
	return null;
};

const extractMessageText = (content: unknown): string | null => {
	if (!Array.isArray(content)) return asText(content);
	const parts: string[] = [];
	for (const item of content) {
		if (item !== null && typeof item === "object" && "text" in item) {
			const t = (item as Record<string, unknown>)["text"];
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.length > 0 ? parts.join("") : null;
};

const extractCallId = (u: Record<string, unknown>): AgentItemId => {
	const raw =
		typeof u["itemId"] === "string"
			? u["itemId"]
			: typeof u["toolCallId"] === "string"
				? u["toolCallId"]
				: typeof u["call_id"] === "string"
					? u["call_id"]
					: typeof u["callId"] === "string"
						? u["callId"]
						: typeof u["id"] === "string"
							? u["id"]
							: null;
	return raw !== null ? (raw as AgentItemId) : nextItemId();
};

const toNiceToolLabel = (raw: string): string => {
	if (!raw) return "Tool";

	const words = raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
	return words.join(" ");
};

const GENERIC_ACP_TOOL_KINDS = new Set(["other", "tool", "mcp"]);

const normalizeAcpKind = (rawKind: string): string => {
	const k = rawKind.toLowerCase();
	if (k.startsWith("zuse-browser__browser_")) {
		return `mcp__zuse__${k.slice("zuse-browser__".length)}`;
	}
	if (k.startsWith("mcp__zuse-browser__browser_")) {
		return `mcp__zuse__${k.slice("mcp__zuse-browser__".length)}`;
	}
	if (k.startsWith("zuse-orchestration__")) {
		return `mcp__${k}`;
	}
	if (k.startsWith("mcp__zuse-orchestration__")) {
		return k;
	}

	if (k === "emit_ui" || /^(?:mcp__)?zuse(?:-orchestration)?__emit_ui$/.test(k))
		return "mcp__zuse__emit_ui";
	if (
		k === "view_image" ||
		k === "zuse-images__view_image" ||
		k === "mcp__zuse-images__view_image"
	) {
		return "ViewImage";
	}
	switch (k) {
		case "browser_navigate":
		case "browser_screenshot":
		case "browser_snapshot":
		case "browser_click":
		case "browser_type":
		case "browser_wait":
		case "browser_scroll":
		case "browser_hover":
		case "browser_select":
		case "browser_press":
		case "browser_read":
		case "browser_history":
		case "browser_console":
		case "browser_network":
		case "browser_fill_form":
		case "browser_dialog":
		case "browser_login":
			return `mcp__zuse__${k}`;
		case "read":
		case "read_file":
		case "readfile":
			return "Read";
		case "bash":
		case "execute":
		case "run_command":
		case "run_terminal_cmd":
		case "shell":
		case "shell_command":
		case "terminal":
			return "Bash";
		case "edit":
		case "edit_file":
		case "editfile":
		case "search_replace":
		case "searchreplace":
		case "str_replace":
		case "str_replace_editor":
			return "Edit";
		case "write":
		case "write_file":
		case "writefile":
			return "Write";
		case "grep":
		case "grep_search":
		case "grepsearch":
		case "search":
		case "search_files":
		case "searchfiles":
			return "Grep";
		case "glob":
		case "glob_files":
		case "globfiles":
			return "Glob";
		case "websearch":
		case "web_search":
			return "WebSearch";
		case "webfetch":
		case "web_fetch":
		case "fetch":
		case "fetch_url":
			return "WebFetch";
		case "list_dir":
		case "listdir":
		case "list_directory":
		case "directory":
			return "ListDir";
		case "multi_edit":
		case "multiedit":
			return "MultiEdit";
		case "todo_write":
		case "todowrite":
			return "TodoWrite";
		default:
			return toNiceToolLabel(rawKind);
	}
};

const firstLocationPath = (u: Record<string, unknown>): string | null => {
	const locations = u["locations"];
	if (!Array.isArray(locations) || locations.length === 0) return null;
	const loc = locations[0];
	if (loc === null || typeof loc !== "object") return null;
	const p = (loc as Record<string, unknown>)["path"];
	return typeof p === "string" ? p : null;
};

const extractDiffBlock = (
	content: unknown,
): { path?: string; oldText: string; newText: string } | null => {
	const items = Array.isArray(content) ? content : [content];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const b = item as Record<string, unknown>;
		if (b["type"] !== "diff") continue;
		const oldText =
			typeof b["oldText"] === "string"
				? (b["oldText"] as string)
				: typeof b["old_text"] === "string"
					? (b["old_text"] as string)
					: null;
		const newText =
			typeof b["newText"] === "string"
				? (b["newText"] as string)
				: typeof b["new_text"] === "string"
					? (b["new_text"] as string)
					: null;
		if (oldText === null || newText === null) continue;
		const path =
			typeof b["path"] === "string" ? (b["path"] as string) : undefined;
		return { path, oldText, newText };
	}
	return null;
};

const asSearchReplaceEnvelope = (
	v: unknown,
): Record<string, unknown> | null => {
	if (Array.isArray(v)) {
		for (const item of v) {
			const env = asSearchReplaceEnvelope(item);
			if (env !== null) return env;
		}
		return null;
	}
	if (v === null || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const type =
		typeof o["type"] === "string" ? (o["type"] as string).toLowerCase() : null;
	if (
		type === "searchreplace" ||
		type === "search_replace" ||
		"EditsApplied" in o
	) {
		return o;
	}
	if ("content" in o) return asSearchReplaceEnvelope(o["content"]);
	return null;
};

const findSearchReplaceEnvelope = (
	u: Record<string, unknown>,
): Record<string, unknown> | null => {
	for (const key of ["output", "rawOutput", "result", "content"] as const) {
		if (u[key] === undefined) continue;
		const env = asSearchReplaceEnvelope(u[key]);
		if (env !== null) return env;
	}
	return null;
};

const extractSearchReplaceEdits = (
	env: Record<string, unknown>,
): {
	filePath: string | null;
	edits: ReadonlyArray<{ old_string: string; new_string: string }>;
} => {
	const applied =
		env["EditsApplied"] !== null && typeof env["EditsApplied"] === "object"
			? (env["EditsApplied"] as Record<string, unknown>)
			: env;

	const strField = (
		src: Record<string, unknown>,
		key: string,
	): string | null =>
		typeof src[key] === "string" && (src[key] as string).length > 0
			? (src[key] as string)
			: null;

	const filePath =
		strField(applied, "absolute_path") ??
		strField(applied, "file_path") ??
		strField(applied, "path") ??
		strField(env, "file_path") ??
		strField(env, "path");

	const edits: Array<{ old_string: string; new_string: string }> = [];
	const editsContainer =
		applied["edits"] !== null && typeof applied["edits"] === "object"
			? (applied["edits"] as Record<string, unknown>)
			: null;
	const details =
		editsContainer !== null && Array.isArray(editsContainer["details"])
			? (editsContainer["details"] as unknown[])
			: null;
	if (details !== null) {
		for (const d of details) {
			if (d === null || typeof d !== "object") continue;
			const r = d as Record<string, unknown>;
			const oldS =
				typeof r["old_string"] === "string"
					? (r["old_string"] as string)
					: null;
			const newS =
				typeof r["new_string"] === "string"
					? (r["new_string"] as string)
					: null;
			if (oldS !== null || newS !== null) {
				edits.push({ old_string: oldS ?? "", new_string: newS ?? "" });
			}
		}
	}
	if (edits.length === 0) {
		const oldS =
			typeof applied["old_string"] === "string"
				? (applied["old_string"] as string)
				: null;
		const newS =
			typeof applied["new_string"] === "string"
				? (applied["new_string"] as string)
				: null;
		if (oldS !== null || newS !== null) {
			edits.push({ old_string: oldS ?? "", new_string: newS ?? "" });
		}
	}
	return { filePath, edits };
};

const buildCanonicalInput = (
	toolName: string,
	u: Record<string, unknown>,
): unknown => {
	const title = typeof u["title"] === "string" ? (u["title"] as string) : null;

	const rawInput =
		u["rawInput"] !== null &&
		typeof u["rawInput"] === "object" &&
		Object.keys(u["rawInput"] as Record<string, unknown>).length > 0
			? (u["rawInput"] as Record<string, unknown>)
			: null;

	const pathFrom = (src: Record<string, unknown>): string | null => {
		const v =
			typeof src["file_path"] === "string"
				? (src["file_path"] as string)
				: typeof src["target_file"] === "string"
					? (src["target_file"] as string)
					: typeof src["filePath"] === "string"
						? (src["filePath"] as string)
						: typeof src["path"] === "string"
							? (src["path"] as string)
							: null;
		return v !== null && v.length > 0 ? v : null;
	};

	switch (toolName) {
		case "Edit":
		case "MultiEdit": {
			const sr = findSearchReplaceEnvelope(u);
			if (sr !== null) {
				const { filePath, edits } = extractSearchReplaceEdits(sr);
				if (edits.length > 0) {
					const fp =
						filePath ??
						firstLocationPath(u) ??
						(rawInput !== null ? pathFrom(rawInput) : null) ??
						"";
					if (edits.length === 1) {
						return {
							file_path: fp,
							old_string: edits[0]!.old_string,
							new_string: edits[0]!.new_string,
						};
					}
					return { file_path: fp, edits };
				}
			}
			const diff = extractDiffBlock(u["content"]);
			if (diff !== null) {
				return {
					file_path:
						diff.path ??
						firstLocationPath(u) ??
						(rawInput !== null ? pathFrom(rawInput) : null) ??
						"",
					old_string: diff.oldText,
					new_string: diff.newText,
				};
			}
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			if (file_path !== null) return { file_path };
			break;
		}
		case "Write": {
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			const content =
				typeof u["content"] === "string"
					? (u["content"] as string)
					: (extractMessageText(u["content"]) ??
						(rawInput !== null && typeof rawInput["content"] === "string"
							? (rawInput["content"] as string)
							: null));
			const out: Record<string, unknown> = {};
			if (file_path !== null) out["file_path"] = file_path;
			if (content !== null) out["content"] = content;
			return Object.keys(out).length > 0 ? out : null;
		}
		case "Read":
		case "ViewImage": {
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			if (file_path !== null) {
				const out: Record<string, unknown> = { file_path };
				if (typeof u["offset"] === "number") out["offset"] = u["offset"];
				if (typeof u["limit"] === "number") out["limit"] = u["limit"];
				return out;
			}
			break;
		}
		case "Bash": {
			const command =
				typeof u["command"] === "string"
					? (u["command"] as string)
					: typeof u["cmd"] === "string"
						? (u["cmd"] as string)
						: rawInput !== null && typeof rawInput["command"] === "string"
							? (rawInput["command"] as string)
							: null;
			if (command !== null) {
				const out: Record<string, unknown> = { command };
				if (title !== null && !isRedundantShellDescription(title, command)) {
					out["description"] = title;
				}
				return out;
			}
			break;
		}
		case "Grep":
		case "Glob": {
			const out: Record<string, unknown> = {};
			const src = rawInput ?? u;
			if (typeof src["pattern"] === "string") out["pattern"] = src["pattern"];
			if (typeof src["path"] === "string") out["path"] = src["path"];
			if (typeof src["glob"] === "string") out["glob"] = src["glob"];
			if (Object.keys(out).length > 0) return out;
			break;
		}
		case "WebSearch": {
			const query =
				typeof u["query"] === "string"
					? (u["query"] as string)
					: typeof u["q"] === "string"
						? (u["q"] as string)
						: title;
			if (query !== null) return { query };
			break;
		}
		case "WebFetch": {
			const url = typeof u["url"] === "string" ? (u["url"] as string) : null;
			if (url !== null) {
				const out: Record<string, unknown> = { url };
				if (title !== null) out["prompt"] = title;
				return out;
			}
			break;
		}
	}

	if (rawInput !== null) {
		return rawInput;
	}
	if (u["input"] !== undefined) return u["input"];
	if (u["arguments"] !== undefined) {
		const a = u["arguments"];
		return typeof a === "string" ? tryParseJson(a) : a;
	}
	if (u["command"] !== undefined) return { command: u["command"] };
	const file_path = firstLocationPath(u);
	if (file_path !== null) return { file_path };
	return title !== null ? { description: title } : null;
};

const extractToolName = (u: Record<string, unknown>): string => {
	const kind = typeof u["kind"] === "string" ? (u["kind"] as string) : null;
	if (
		kind !== null &&
		kind.length > 0 &&
		!GENERIC_ACP_TOOL_KINDS.has(kind.toLowerCase())
	) {
		return normalizeAcpKind(kind);
	}

	if (typeof u["tool"] === "string" && u["tool"].length > 0)
		return u["tool"] as string;
	if (typeof u["name"] === "string" && u["name"].length > 0)
		return u["name"] as string;
	if (typeof u["execution"] === "string" && u["execution"].length > 0)
		return u["execution"] as string;
	if (typeof u["command"] === "string" && u["command"].length > 0)
		return u["command"] as string;

	const nestedCandidates = [
		u["toolCall"],
		u["tool_call"],
		u["toolInfo"],
		u["tool_info"],
		u["call"],
	];
	for (const cand of nestedCandidates) {
		if (cand && typeof cand === "object") {
			const c = cand as Record<string, unknown>;
			const nestedKind =
				typeof c["kind"] === "string" ? (c["kind"] as string) : null;
			if (nestedKind && nestedKind.length > 0)
				return normalizeAcpKind(nestedKind);
			const nestedName =
				(typeof c["name"] === "string" && c["name"]) ||
				(typeof c["tool"] === "string" && c["tool"]) ||
				(typeof c["command"] === "string" && c["command"]);
			if (
				nestedName &&
				typeof nestedName === "string" &&
				nestedName.length > 0
			) {
				return normalizeAcpKind(nestedName);
			}
		}
	}

	const title = typeof u["title"] === "string" ? (u["title"] as string) : null;
	if (title && title.length > 0 && title.length < 40) {
		if (
			/^(?:mcp__)?zuse-(?:browser|images|orchestration)__[a-z0-9_]+$/i.test(
				title,
			)
		) {
			return normalizeAcpKind(title);
		}
		if (/^[a-z0-9_]+$/i.test(title)) return normalizeAcpKind(title);
	}

	return "tool";
};

const flattenMcpContent = (val: unknown): string | null => {
	if (!Array.isArray(val) || val.length === 0) return null;
	const parts: string[] = [];
	for (const block of val) {
		if (block === null || typeof block !== "object") return null;
		const b = block as Record<string, unknown>;
		if (typeof b["text"] === "string") {
			parts.push(b["text"] as string);
			continue;
		}
		const inner = b["content"];
		if (inner !== null && typeof inner === "object") {
			const it = (inner as Record<string, unknown>)["text"];
			if (typeof it === "string") {
				parts.push(it);
				continue;
			}
		}

		return null;
	}
	return parts.join("");
};

const unwrap = (o: unknown): unknown => {
	const flat = flattenMcpContent(o);
	if (flat !== null) return flat;
	if (o !== null && typeof o === "object" && "content" in o) {
		const nested = (o as Record<string, unknown>)["content"];
		const flatNested = flattenMcpContent(nested);
		if (flatNested !== null) return flatNested;
		return nested ?? o;
	}
	return o;
};

const decodeByteArray = (v: unknown): string | null => {
	const data = Array.isArray(v)
		? v
		: v !== null &&
				typeof v === "object" &&
				Array.isArray((v as Record<string, unknown>)["data"])
			? ((v as Record<string, unknown>)["data"] as unknown[])
			: null;
	if (data === null || data.length === 0) return null;
	const bytes = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) {
		const n = data[i];
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
			return null;
		}
		bytes[i] = n;
	}
	try {
		return new TextDecoder("utf-8").decode(bytes);
	} catch {
		return null;
	}
};

const stripLineMarkers = (content: string): string =>
	content
		.split("\n")
		.map((line) => line.replace(/^\s*\d+→/, ""))
		.join("\n");

const buildGrepText = (o: Record<string, unknown>): string | null => {
	const fileMatches = o["file_matches"];
	if (!Array.isArray(fileMatches) || fileMatches.length === 0) return null;

	let root: string | null = null;
	const stdoutText =
		decodeByteArray(o["stdout"]) ??
		(typeof o["stdout"] === "string" ? (o["stdout"] as string) : null);
	if (stdoutText !== null) {
		const m = stdoutText.match(/workspace_path="([^"]+)"/);
		if (m !== null) root = m[1] ?? null;
	}
	const rel = (p: string): string =>
		root !== null && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;

	const lines: string[] = [];
	for (const fm of fileMatches) {
		if (fm === null || typeof fm !== "object") continue;
		const f = fm as Record<string, unknown>;
		const path = typeof f["path"] === "string" ? (f["path"] as string) : null;
		if (path === null || path.length === 0) continue;
		lines.push(rel(path));
		const matches = Array.isArray(f["matches"]) ? f["matches"] : [];
		for (const mt of matches) {
			if (mt === null || typeof mt !== "object") continue;
			const m = mt as Record<string, unknown>;
			const ln =
				typeof m["line_number"] === "number"
					? (m["line_number"] as number)
					: null;
			const content =
				typeof m["content"] === "string" ? (m["content"] as string).trim() : "";
			lines.push(`\t${ln !== null ? `${ln}: ` : ""}${content}`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
};

const ENVELOPE_SIGNATURE =
	/"type"\s*:\s*"(ReadFile|ListDir|GrepSearch|SearchReplace)"|"FileContent"|"file_matches"|"EditsApplied"/;

const normalizeNativeToolResult = (output: unknown): unknown => {
	if (typeof output === "string") {
		const trimmed = output.trim();
		if (trimmed.startsWith("{") && ENVELOPE_SIGNATURE.test(trimmed)) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				const normalized = normalizeNativeToolResult(parsed);
				if (typeof normalized === "string") return normalized;
			} catch {}
		}
		return output;
	}
	if (output === null || typeof output !== "object" || Array.isArray(output)) {
		return output;
	}
	const o = output as Record<string, unknown>;
	const type =
		typeof o["type"] === "string" ? (o["type"] as string).toLowerCase() : null;

	if (type === "listdir" || type === "list_dir" || type === "list_directory") {
		const container = o["Content"] ?? o["content"];
		if (container !== null && typeof container === "object") {
			const c = (container as Record<string, unknown>)["content"];
			if (typeof c === "string" && c.length > 0) return c;
		}
		if (typeof o["content"] === "string" && o["content"].length > 0) {
			return o["content"];
		}
	}

	if (type === "readfile" || type === "read_file" || "FileContent" in o) {
		const fc =
			o["FileContent"] !== null && typeof o["FileContent"] === "object"
				? (o["FileContent"] as Record<string, unknown>)
				: null;
		const rawOutput =
			fc !== null &&
			typeof fc["raw_output"] === "string" &&
			fc["raw_output"].length > 0
				? (fc["raw_output"] as string)
				: null;
		if (rawOutput !== null) return rawOutput;
		const marked =
			fc !== null && typeof fc["content"] === "string"
				? (fc["content"] as string)
				: typeof o["content"] === "string"
					? (o["content"] as string)
					: null;
		if (marked !== null) return stripLineMarkers(marked);
	}

	if (
		type === "grepsearch" ||
		type === "grep_search" ||
		type === "grep" ||
		Array.isArray(o["file_matches"])
	) {
		const grep = buildGrepText(o);
		if (grep !== null) return grep;
	}

	if (
		type === "searchreplace" ||
		type === "search_replace" ||
		"EditsApplied" in o
	) {
		const { filePath, edits } = extractSearchReplaceEdits(o);
		if (edits.length > 0) {
			const where = filePath !== null ? ` to ${filePath}` : "";
			return `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"}${where}.`;
		}
	}

	if ("stdout" in o || "stderr" in o) {
		const out =
			decodeByteArray(o["stdout"]) ??
			(typeof o["stdout"] === "string" ? (o["stdout"] as string) : "");
		const err =
			decodeByteArray(o["stderr"]) ??
			(typeof o["stderr"] === "string" ? (o["stderr"] as string) : "");
		const combined = [out, err].filter((s) => s.length > 0).join("\n");
		if (combined.length > 0) return combined;
	}

	return output;
};

const extractOutput = (u: Record<string, unknown>): unknown => {
	const raw =
		u["output"] !== undefined
			? unwrap(u["output"])
			: u["rawOutput"] !== undefined
				? unwrap(u["rawOutput"])
				: u["content"] !== undefined
					? (flattenMcpContent(u["content"]) ?? u["content"])
					: u["result"] !== undefined
						? unwrap(u["result"])
						: null;
	return normalizeNativeToolResult(raw);
};

const extractErrorDetail = (u: Record<string, unknown>): string | null => {
	const fields = ["message", "error", "details", "data"] as const;
	for (const f of fields) {
		const v = u[f];
		if (typeof v === "string" && v.length > 0) return v;
		if (v !== null && typeof v === "object") {
			const nested = (v as Record<string, unknown>).message;
			if (typeof nested === "string" && nested.length > 0) return nested;
		}
	}
	return null;
};

const safeStringify = (u: Record<string, unknown>): string => {
	try {
		return JSON.stringify(u);
	} catch {
		return "(unserialisable)";
	}
};

const logUnknownToolIfNeeded = (
	provider: AcpProviderTag,
	u: Record<string, unknown>,
	toolName: string,
	phase: string,
): void => {
	if (toolName !== "tool") return;
	if (!ACP_TRACE) return;
	trace(provider, `unknown tool ${phase} — raw payload=${safePreview(u, 800)}`);
};

const isAssistantTextChunk = (kind: string): boolean =>
	kind === "agent_message_chunk" || kind === "message";

const isThinkingChunk = (kind: string): boolean =>
	kind === "agent_thought_chunk" ||
	kind === "agent_reasoning_chunk" ||
	kind === "thinking_chunk" ||
	kind === "reasoning";

interface AcpTranslator {
	finishTools(reason: string): ReadonlyArray<AgentEvent>;

	translate(update: unknown): ReadonlyArray<AgentEvent>;

	flush(): ReadonlyArray<AgentEvent>;
}

export interface AcpTranslatorCheckpointOptions {
	readonly onCheckpoint: (events: ReadonlyArray<AgentEvent>) => void;
	readonly intervalMs?: number;
	readonly maxBytes?: number;
}

interface ToolCallState {
	genericOutput?: unknown;

	lastInputJson: string | null;

	resultEmitted: boolean;

	useEmitted: boolean;

	toolName: string | null;
}

interface CollabAgentRun {
	readonly parentItemId: AgentItemId;
	readonly model: string;
	readonly startedAt: number;
	turnCount: number;
	lastMessage: string;
	summaryEmitted: boolean;
}

interface GrokCursorTaskRun {
	readonly itemId: AgentItemId;
	readonly description: string;
	readonly prompt: string;
	readonly model: string;
	readonly startedAt: number;
	readonly scoreText: string;
	childEventCount: number;
	lastActivityAt: number;
	lastMessage: string;
	summaryEmitted: boolean;
}

const recordFrom = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const stringFrom = (
	record: Record<string, unknown>,
	key: string,
): string | null => {
	const v = record[key];
	return typeof v === "string" && v.length > 0 ? v : null;
};

const collabAgentStateStatus = (value: unknown): string | null => {
	const state = recordFrom(value);
	if (state === null) return null;
	const directType = stringFrom(state, "type");
	if (directType !== null) return directType;
	const status = state["status"];
	if (typeof status === "string") return status;
	if (status !== null && typeof status === "object") {
		return stringFrom(status as Record<string, unknown>, "type");
	}
	return null;
};

const collabAgentStateMessage = (value: unknown): string | null => {
	const state = recordFrom(value);
	if (state === null) return null;
	return stringFrom(state, "message");
};

const isTerminalCollabAgentStatus = (status: string | null): boolean =>
	status === "completed" ||
	status === "idle" ||
	status === "notLoaded" ||
	status === "errored" ||
	status === "systemError" ||
	status === "interrupted" ||
	status === "shutdown";

const grokCallPrefix = (itemId: string): string | null => {
	const match = /^call-([0-9a-f-]{36})-composer_call_/i.exec(itemId);
	return match?.[1] ?? null;
};

const isGrokCursorTaskInput = (
	input: unknown,
): input is Record<string, unknown> => {
	const record = recordFrom(input);
	if (record === null) return false;
	return (
		record["variant"] === "CursorTask" ||
		typeof record["subagent_type"] === "string"
	);
};

const grokTaskText = (
	input: Record<string, unknown>,
): {
	readonly description: string;
	readonly prompt: string;
	readonly model: string;
} => {
	const description =
		typeof input["description"] === "string" ? input["description"] : "agent";
	const prompt = typeof input["prompt"] === "string" ? input["prompt"] : "";
	const model = typeof input["model"] === "string" ? input["model"] : "inherit";
	return { description, prompt, model };
};

const GROK_TASK_STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"available",
	"check",
	"code",
	"current",
	"files",
	"from",
	"into",
	"local",
	"return",
	"status",
	"task",
	"tasks",
	"that",
	"this",
	"with",
	"work",
]);

const tokenizeForGrokTaskScore = (value: string): Set<string> => {
	const out = new Set<string>();
	for (const token of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ??
		[]) {
		if (!GROK_TASK_STOP_WORDS.has(token)) out.add(token);
	}
	return out;
};

const scoreGrokTaskMatch = (task: GrokCursorTaskRun, text: string): number => {
	const haystack = text.toLowerCase();
	const description = task.description.toLowerCase();
	let score = haystack.includes(description) ? 20 : 0;
	const taskTokens = tokenizeForGrokTaskScore(task.scoreText);
	const eventTokens = tokenizeForGrokTaskScore(text);
	for (const token of eventTokens) {
		if (taskTokens.has(token)) score += 1;
	}
	return score;
};

/**
 * Create a per-session translator. Stateful because:
 *   1. ACP's `agent_message_chunk` is a delta protocol — we buffer
 *      consecutive chunks into one logical `AssistantMessage` event.
 *   2. `tool_call_update` is also a delta protocol — we dedupe so the
 *      renderer doesn't show a stack of "Read foo.ts" rows for one read.
 */
export const createAcpTranslator = (
	provider: AcpProviderTag,
	checkpointOptions?: AcpTranslatorCheckpointOptions,
): AcpTranslator => {
	let assistantBuffer = "";
	let assistantItemId: AgentItemId | null = null;
	let assistantCheckpointLength = 0;
	let assistantRevision = 0;

	let thinkingBuffer = "";
	let thinkingItemId: AgentItemId | null = null;
	let thinkingCheckpointLength = 0;
	let thinkingRevision = 0;

	const toolStates = new Map<string, ToolCallState>();
	const collabAgentsByThread = new Map<string, CollabAgentRun>();
	const grokCursorTasks = new Map<AgentItemId, GrokCursorTaskRun>();
	const grokCursorTaskOrder: AgentItemId[] = [];
	const grokPrefixToTask = new Map<string, AgentItemId>();
	const grokTaskLaunchPrefixes = new Set<string>();
	let lastGrokCursorTextParentItemId: AgentItemId | undefined;
	let checkpointScheduler: CheckpointFlushScheduler | null = null;

	const flushAssistant = (): ReadonlyArray<AgentEvent> => {
		if (assistantBuffer.length === 0) return [];
		const parentItemId = grokCursorTextParentFor(assistantBuffer);
		assistantRevision += 1;
		const ev: AgentEvent = {
			_tag: "AssistantMessage",
			itemId: assistantItemId ?? nextItemId(),
			text: assistantBuffer,
			parentItemId,
			checkpoint: { revision: assistantRevision, final: true },
		};
		noteGrokCursorTaskChild(parentItemId, assistantBuffer);
		trace(
			provider,
			`flush AssistantMessage itemId=${ev.itemId} len=${assistantBuffer.length} preview=${safePreview(assistantBuffer)}`,
		);
		assistantBuffer = "";
		assistantItemId = null;
		assistantCheckpointLength = 0;
		assistantRevision = 0;
		return [ev];
	};

	const flushThinking = (): ReadonlyArray<AgentEvent> => {
		if (thinkingBuffer.length === 0) return [];
		const parentItemId = grokCursorTextParentFor(thinkingBuffer);
		thinkingRevision += 1;
		const ev: AgentEvent = {
			_tag: "Thinking",
			itemId: thinkingItemId ?? nextItemId(),
			text: thinkingBuffer,
			redacted: false,
			parentItemId,
			checkpoint: { revision: thinkingRevision, final: true },
		};
		noteGrokCursorTaskChild(parentItemId);
		trace(
			provider,
			`flush Thinking itemId=${ev.itemId} len=${thinkingBuffer.length} preview=${safePreview(thinkingBuffer)}`,
		);
		thinkingBuffer = "";
		thinkingItemId = null;
		thinkingCheckpointLength = 0;
		thinkingRevision = 0;
		return [ev];
	};

	const flushPending = (): ReadonlyArray<AgentEvent> => {
		const t = flushThinking();
		const a = flushAssistant();
		return t.length === 0 ? a : a.length === 0 ? t : [...t, ...a];
	};

	const checkpointPending = (): ReadonlyArray<AgentEvent> => {
		const out: AgentEvent[] = [];
		if (
			thinkingItemId !== null &&
			thinkingBuffer.length > thinkingCheckpointLength
		) {
			const parentItemId = grokCursorTextParentFor(thinkingBuffer);
			thinkingRevision += 1;
			out.push({
				_tag: "Thinking",
				itemId: thinkingItemId,
				text: thinkingBuffer,
				redacted: false,
				parentItemId,
				checkpoint: { revision: thinkingRevision, final: false },
			});
			noteGrokCursorTaskChild(parentItemId);
			thinkingCheckpointLength = thinkingBuffer.length;
		}
		if (
			assistantItemId !== null &&
			assistantBuffer.length > assistantCheckpointLength
		) {
			const parentItemId = grokCursorTextParentFor(assistantBuffer);
			assistantRevision += 1;
			out.push({
				_tag: "AssistantMessage",
				itemId: assistantItemId,
				text: assistantBuffer,
				parentItemId,
				checkpoint: { revision: assistantRevision, final: false },
			});
			noteGrokCursorTaskChild(parentItemId, assistantBuffer);
			assistantCheckpointLength = assistantBuffer.length;
		}
		return out;
	};

	const emitCheckpoint = (): void => {
		const events = checkpointPending();
		if (events.length > 0) checkpointOptions?.onCheckpoint(events);
	};

	if (checkpointOptions !== undefined) {
		checkpointScheduler = new CheckpointFlushScheduler({
			onFlush: emitCheckpoint,
			intervalMs: checkpointOptions.intervalMs,
			maxBytes: checkpointOptions.maxBytes,
		});
	}

	const scheduleCheckpoint = (): void => {
		if (checkpointScheduler === null) return;
		const bufferedBytes = Buffer.byteLength(
			assistantBuffer.slice(assistantCheckpointLength) +
				thinkingBuffer.slice(thinkingCheckpointLength),
		);
		checkpointScheduler.update(bufferedBytes);
	};

	const getOrInitToolState = (id: string): ToolCallState => {
		let s = toolStates.get(id);
		if (s === undefined) {
			s = {
				lastInputJson: null,
				resultEmitted: false,
				useEmitted: false,
				toolName: null,
			};
			toolStates.set(id, s);
		}
		return s;
	};

	const parentItemIdForThread = (threadId: unknown): AgentItemId | undefined =>
		typeof threadId === "string"
			? collabAgentsByThread.get(threadId)?.parentItemId
			: undefined;

	const rememberCollabAgent = (
		itemId: AgentItemId,
		threadId: string,
		model: string,
	): CollabAgentRun => {
		let run = collabAgentsByThread.get(threadId);
		if (run === undefined) {
			run = {
				parentItemId: itemId,
				model,
				startedAt: Date.now(),
				turnCount: 0,
				lastMessage: "",
				summaryEmitted: false,
			};
			collabAgentsByThread.set(threadId, run);
		}
		return run;
	};

	const maybeFinishCollabAgent = (
		itemId: AgentItemId,
		run: CollabAgentRun,
		state: unknown,
	): AgentEvent | null => {
		const status = collabAgentStateStatus(state);
		if (!isTerminalCollabAgentStatus(status) || run.summaryEmitted) return null;
		run.summaryEmitted = true;
		const message = collabAgentStateMessage(state) ?? run.lastMessage;
		return {
			_tag: "SubagentSummary",
			itemId,
			agentName: "agent",
			model: run.model,
			turns: run.turnCount,
			durationMs: Date.now() - run.startedAt,
			summary: message,
			isError: status === "errored" || status === "interrupted",
		};
	};

	const rememberGrokCursorTask = (
		itemId: AgentItemId,
		input: Record<string, unknown>,
	): void => {
		if (provider !== "grok" || !isGrokCursorTaskInput(input)) return;
		const current = grokCursorTasks.get(itemId);
		const { description, prompt, model } = grokTaskText(input);
		if (current !== undefined) {
			current.lastMessage = current.lastMessage || description;
			return;
		}
		grokCursorTasks.set(itemId, {
			itemId,
			description,
			prompt,
			model,
			startedAt: Date.now(),
			scoreText: `${description}\n${prompt}`,
			childEventCount: 0,
			lastActivityAt: Date.now(),
			lastMessage: "",
			summaryEmitted: false,
		});
		grokCursorTaskOrder.push(itemId);
		const prefix = grokCallPrefix(itemId);
		if (prefix !== null) grokTaskLaunchPrefixes.add(prefix);
	};

	const bestGrokCursorTaskForText = (
		text: string,
	): GrokCursorTaskRun | null => {
		if (provider !== "grok" || grokCursorTaskOrder.length === 0) return null;
		let best: GrokCursorTaskRun | null = null;
		let bestScore = 0;
		for (const itemId of grokCursorTaskOrder) {
			const task = grokCursorTasks.get(itemId);
			if (task === undefined || task.summaryEmitted) continue;
			const score = scoreGrokTaskMatch(task, text);
			if (score > bestScore) {
				best = task;
				bestScore = score;
			}
		}
		return bestScore > 0 ? best : null;
	};

	const grokCursorTextParentFor = (text: string): AgentItemId | undefined => {
		if (provider !== "grok") return undefined;
		const best = bestGrokCursorTaskForText(text);
		if (best !== null) return best.itemId;
		if (lastGrokCursorTextParentItemId === undefined) return undefined;
		const task = grokCursorTasks.get(lastGrokCursorTextParentItemId);
		return task !== undefined && !task.summaryEmitted ? task.itemId : undefined;
	};

	const parentGrokCursorTaskForTool = (
		itemId: AgentItemId,
		toolName: string,
		update: Record<string, unknown>,
		input: unknown,
	): AgentItemId | undefined => {
		if (provider !== "grok" || grokCursorTaskOrder.length === 0)
			return undefined;
		if (toolName === "Task" || toolName === "Agent") return undefined;
		const prefix = grokCallPrefix(itemId);
		if (prefix === null || grokTaskLaunchPrefixes.has(prefix)) return undefined;
		const existing = grokPrefixToTask.get(prefix);
		if (existing !== undefined) return existing;

		const rawInput = recordFrom(update["rawInput"]);
		const text = safeStringify({
			title: update["title"],
			kind: update["kind"],
			rawInput,
			input,
		});
		const task = bestGrokCursorTaskForText(text);
		if (task === null) return undefined;
		grokPrefixToTask.set(prefix, task.itemId);
		return task.itemId;
	};

	const noteGrokCursorTaskChild = (
		parentItemId: AgentItemId | undefined,
		message?: string,
	): void => {
		if (parentItemId === undefined) return;
		const task = grokCursorTasks.get(parentItemId);
		if (task === undefined) return;
		if (!task.summaryEmitted) {
			lastGrokCursorTextParentItemId = parentItemId;
		}
		task.childEventCount += 1;
		task.lastActivityAt = Date.now();
		if (message !== undefined && message.trim().length > 0) {
			task.lastMessage = message.trim();
		}
	};

	const finishGrokCursorTasks = (): ReadonlyArray<AgentEvent> => {
		if (provider !== "grok") return [];
		const events: AgentEvent[] = [];
		for (const itemId of grokCursorTaskOrder) {
			const task = grokCursorTasks.get(itemId);
			if (task === undefined || task.summaryEmitted) continue;
			task.summaryEmitted = true;
			events.push({
				_tag: "SubagentSummary",
				itemId: task.itemId,
				agentName: task.description,
				model: task.model,
				turns: task.childEventCount,
				durationMs: Math.max(0, task.lastActivityAt - task.startedAt),
				summary: task.lastMessage || "Completed.",
				isError: false,
			});
		}
		return events;
	};

	const translateOne = (update: unknown): ReadonlyArray<AgentEvent> => {
		if (update === null || typeof update !== "object") return [];
		const u = update as Record<string, unknown>;
		const wrappedItem = recordFrom(u["item"]);
		const kind =
			typeof u["sessionUpdate"] === "string"
				? (u["sessionUpdate"] as string)
				: typeof u["type"] === "string"
					? (u["type"] as string)
					: typeof wrappedItem?.["type"] === "string"
						? (wrappedItem["type"] as string)
						: typeof u["method"] === "string"
							? (u["method"] as string)
							: null;
		if (kind === null) return [];

		const shouldFlushBeforeEvent = !(
			provider === "grok" &&
			(kind === "tool_call_update" ||
				kind === "tool_result" ||
				kind === "tool_output" ||
				kind === "function_call_output" ||
				kind === "custom_tool_call_output" ||
				kind === "tool_search_output")
		);

		if (isThinkingChunk(kind)) {
			const flushed = flushAssistant();
			let text = asText(u["content"]);
			if (text === null || text.length === 0) return flushed;

			if (provider === "grok" && thinkingBuffer.length === 0) {
				const cleaned = text
					.replace(/^the user (says|asked|wants|is asking)[^"]*"\s*/i, "")
					.replace(/^first, the user's query[^—-]*[-—]\s*/i, "")
					.trim();
				if (cleaned.length > 10) {
					text = cleaned;
				}
			}
			if (thinkingItemId === null) thinkingItemId = extractCallId(u);
			thinkingBuffer = appendStreamText(thinkingBuffer, text, "sentence-start");
			trace(
				provider,
				`buffer thinking chunk len=${text.length} totalLen=${thinkingBuffer.length}`,
			);
			return flushed;
		}

		if (isAssistantTextChunk(kind)) {
			const flushed = flushThinking();
			const text =
				kind === "message"
					? extractMessageText(u["content"])
					: asText(u["content"]);
			if (text === null || text.length === 0) return flushed;
			if (assistantItemId === null) assistantItemId = extractCallId(u);
			assistantBuffer = appendStreamText(
				assistantBuffer,
				text,
				"sentence-start",
			);
			trace(
				provider,
				`buffer message chunk len=${text.length} totalLen=${assistantBuffer.length}`,
			);
			return flushed;
		}

		const flushed = shouldFlushBeforeEvent ? flushPending() : [];

		const tail = ((): ReadonlyArray<AgentEvent> => {
			switch (kind) {
				case "agent_thought_chunk":
				case "agent_reasoning_chunk":
				case "thinking_chunk":
				case "reasoning": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					const summary = Array.isArray(item["summary"])
						? (item["summary"] as unknown[]).filter(
								(value): value is string => typeof value === "string",
							)
						: [];
					const content = Array.isArray(item["content"])
						? (item["content"] as unknown[]).filter(
								(value): value is string => typeof value === "string",
							)
						: [];
					const nestedText = [...summary, ...content].join("\n").trim();
					const text = nestedText || asText(u["content"]);
					if (text === null || text.length === 0) return [];
					trace(provider, `emit Thinking len=${text.length}`);
					return [
						{
							_tag: "Thinking",
							itemId: extractCallId(item),
							text,
							redacted: false,
							parentItemId,
						},
					];
				}

				case "tool_call":
				case "tool_use":
				case "function_call":
				case "custom_tool_call":
				case "tool_search_call":
				case "local_shell_call":
				case "web_search_call":
				case "image_generation_call": {
					const rawKind =
						typeof u["kind"] === "string" ? (u["kind"] as string) : null;

					if (provider === "gemini" && rawKind === "think") {
						trace(provider, `skip think tool_call`);
						return [];
					}

					const callId = extractCallId(u);
					const toolName = extractToolName(u);
					logUnknownToolIfNeeded(provider, u, toolName, "tool_call");
					const input = buildCanonicalInput(toolName, u);
					if (input !== null && typeof input === "object") {
						rememberGrokCursorTask(callId, input as Record<string, unknown>);
					}
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						toolName,
						u,
						input,
					);
					const inputJson = toolInputFingerprint(input);
					const state = getOrInitToolState(callId);

					if (state.toolName === null) state.toolName = toolName;

					if (state.useEmitted && state.lastInputJson === inputJson) {
						trace(
							provider,
							`skip duplicate tool_call id=${callId} tool=${toolName}`,
						);
						return [];
					}
					state.useEmitted = true;
					state.lastInputJson = inputJson;
					noteGrokCursorTaskChild(parentItemId);
					trace(
						provider,
						`emit ToolUse id=${callId} tool=${toolName} input=${safePreview(input)}`,
					);
					return [
						{
							_tag: "ToolUse",
							itemId: callId,
							tool: toolName,
							input,
							parentItemId,
						},
					];
				}

				case "tool_call_update": {
					const rawKind =
						typeof u["kind"] === "string" ? (u["kind"] as string) : null;
					if (provider === "gemini" && rawKind === "think") return [];
					const callId = extractCallId(u);
					const state = getOrInitToolState(callId);

					const updateToolName = extractToolName(u);
					const toolName =
						state.toolName !== null && state.toolName !== "tool"
							? state.toolName
							: updateToolName;
					if (state.toolName === null) state.toolName = toolName;
					logUnknownToolIfNeeded(provider, u, toolName, "tool_call_update");
					const input = buildCanonicalInput(toolName, u);
					if (input !== null && typeof input === "object") {
						rememberGrokCursorTask(callId, input as Record<string, unknown>);
					}
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						toolName,
						u,
						input,
					);
					const events: AgentEvent[] = [];

					if (input !== null) {
						if (
							provider === "grok" &&
							(toolName === "Task" || toolName === "Agent") &&
							isGrokCursorTaskInput(input) &&
							state.useEmitted &&
							state.lastInputJson !== null &&
							state.lastInputJson.includes('"prompt"') &&
							!state.lastInputJson.includes('"description":"Task"')
						) {
							trace(
								provider,
								`skip duplicate CursorTask update id=${callId} tool=${toolName}`,
							);
							return events;
						}
						const inputJson = toolInputFingerprint(input);
						if (state.lastInputJson !== inputJson) {
							state.lastInputJson = inputJson;
							state.useEmitted = true;
							noteGrokCursorTaskChild(parentItemId);
							trace(
								provider,
								`emit ToolUse(update) id=${callId} tool=${toolName} input=${safePreview(input)}`,
							);
							events.push({
								_tag: "ToolUse",
								itemId: callId,
								tool: toolName,
								input,
								parentItemId,
							});
						} else {
							trace(
								provider,
								`skip duplicate tool_call_update id=${callId} tool=${toolName}`,
							);
						}
					}

					const content = u["content"];
					const hasContent =
						content !== undefined &&
						Array.isArray(content) &&
						(content as ReadonlyArray<unknown>).length > 0;
					const isDiffOnly = hasContent && extractDiffBlock(content) !== null;
					const status = typeof u["status"] === "string" ? u["status"] : null;
					const completed = status === "completed" || status === "failed";
					if (provider === "generic" && hasContent && !isDiffOnly)
						state.genericOutput = extractOutput(u);

					if (
						!state.resultEmitted &&
						((provider !== "generic" && hasContent && !isDiffOnly) || completed)
					) {
						state.resultEmitted = true;
						const output = extractOutput(u) ?? state.genericOutput ?? null;
						const isError =
							u["isError"] === true ||
							u["is_error"] === true ||
							status === "failed";
						trace(
							provider,
							`emit ToolResult id=${callId} tool=${toolName} status=${status ?? "(none)"} isError=${isError} output=${safePreview(output)}`,
						);
						events.push({
							_tag: "ToolResult",
							itemId: callId,
							output,
							isError,
							parentItemId,
						});
						noteGrokCursorTaskChild(parentItemId);
					} else if (state.resultEmitted) {
						trace(
							provider,
							`skip late tool_call_update id=${callId} (result already emitted)`,
						);
					}

					return events;
				}

				case "tool_result":
				case "tool_output":
				case "function_call_output":
				case "custom_tool_call_output":
				case "tool_search_output": {
					const callId = extractCallId(u);
					const state = getOrInitToolState(callId);
					if (state.resultEmitted) {
						trace(
							provider,
							`skip duplicate ${kind} id=${callId} (result already emitted)`,
						);
						return [];
					}
					state.resultEmitted = true;
					const isError = u["isError"] === true || u["is_error"] === true;
					const output = extractOutput(u);
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						state.toolName ?? extractToolName(u),
						u,
						u["input"] ?? u["arguments"] ?? null,
					);
					noteGrokCursorTaskChild(parentItemId);
					trace(
						provider,
						`emit ToolResult(${kind}) id=${callId} isError=${isError} output=${safePreview(output)}`,
					);
					return [
						{
							_tag: "ToolResult",
							itemId: callId,
							output,
							isError,
							parentItemId,
						},
					];
				}

				case "error":
				case "agent_error": {
					const detail = extractErrorDetail(u);
					const providerLabel =
						provider === "grok"
							? "Grok"
							: provider === "cursor"
								? "Cursor"
								: provider === "kiro"
									? "Kiro"
									: provider === "generic"
										? "ACP"
										: "Gemini";
					const message =
						detail !== null
							? detail
							: (() => {
									const serialized = safeStringify(u);
									return serialized === "{}"
										? `${providerLabel} agent reported an error with no detail.`
										: `${providerLabel} agent error: ${serialized}`;
								})();
					return [{ _tag: "Error", message }];
				}

				case "agentMessage": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					const text = stringFrom(item, "text");
					if (parentItemId === undefined || text === null) return [];
					const itemId = extractCallId(item);
					const state = getOrInitToolState(itemId as string);
					if (state.useEmitted) return [];
					state.useEmitted = true;
					const threadId = stringFrom(u, "threadId");
					if (threadId !== null) {
						const run = collabAgentsByThread.get(threadId);
						if (run !== undefined) {
							run.turnCount += 1;
							run.lastMessage = text;
						}
					}
					return [
						{
							_tag: "AssistantMessage",
							itemId,
							text,
							parentItemId,
						},
					];
				}

				case "commandExecution": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const command = stringFrom(item, "command") ?? "";
					const cwd = stringFrom(item, "cwd");
					const status = stringFrom(item, "status");
					const output = stringFrom(item, "aggregatedOutput") ?? "";
					const isTerminal =
						status === "completed" ||
						status === "failed" ||
						(item["exitCode"] !== null && item["exitCode"] !== undefined);
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: "Bash",
							input: { command, ...(cwd !== null ? { cwd } : {}) },
							parentItemId,
						});
					}
					if (isTerminal && !state.resultEmitted) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output,
							isError:
								status === "failed" ||
								(typeof item["exitCode"] === "number" &&
									item["exitCode"] !== 0),
							parentItemId,
						});
					}
					return events;
				}

				case "fileChange": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const status = stringFrom(item, "status");
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: "Edit",
							input: { changes: item["changes"] ?? [] },
							parentItemId,
						});
					}
					if (
						status !== null &&
						status !== "pending" &&
						status !== "inProgress" &&
						!state.resultEmitted
					) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output: { status, changes: item["changes"] ?? [] },
							isError: status === "failed",
							parentItemId,
						});
					}
					return events;
				}

				case "mcpToolCall":
				case "dynamicToolCall": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const status = stringFrom(item, "status");
					const namespace = stringFrom(item, "namespace");
					const server = stringFrom(item, "server");
					const tool = stringFrom(item, "tool") ?? "Tool";
					const toolName =
						namespace !== null
							? `${namespace}__${tool}`
							: server !== null
								? `${server}__${tool}`
								: tool;
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: toolName,
							input: item["arguments"] ?? {},
							parentItemId,
						});
					}
					const terminal =
						status === "completed" ||
						status === "failed" ||
						(item["success"] !== null && item["success"] !== undefined);
					if (terminal && !state.resultEmitted) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output:
								item["result"] ?? item["contentItems"] ?? item["error"] ?? null,
							isError:
								status === "failed" ||
								item["success"] === false ||
								(item["error"] !== null && item["error"] !== undefined),
							parentItemId,
						});
					}
					return events;
				}

				case "thread/status/changed":
				case "thread/closed":
				case "turn/completed": {
					const threadId = stringFrom(u, "threadId");
					if (threadId === null) return [];
					const run = collabAgentsByThread.get(threadId);
					if (run === undefined) return [];

					const status =
						kind === "thread/closed"
							? "shutdown"
							: kind === "turn/completed"
								? "idle"
								: collabAgentStateStatus(u["status"]);
					if (!isTerminalCollabAgentStatus(status)) return [];
					const summary = maybeFinishCollabAgent(run.parentItemId, run, {
						status,
						message: run.lastMessage,
					});
					return summary === null ? [] : [summary];
				}

				case "available_commands_update":
				case "current_mode_update":
					return [];

				case "collabAgentToolCall": {
					const candidate = wrappedItem ?? u;
					if (candidate["type"] !== "collabAgentToolCall") {
						return [];
					}

					const collab = candidate;
					const tool =
						typeof collab["tool"] === "string"
							? (collab["tool"] as string)
							: "unknown";
					const callId = extractCallId(collab);
					const status =
						typeof collab["status"] === "string"
							? (collab["status"] as string)
							: null;
					const receiverThreadIds = Array.isArray(collab["receiverThreadIds"])
						? (collab["receiverThreadIds"] as string[])
						: [];
					const prompt =
						typeof collab["prompt"] === "string"
							? (collab["prompt"] as string)
							: null;
					const model =
						typeof collab["model"] === "string"
							? (collab["model"] as string)
							: null;
					const agentsStates = (collab["agentsStates"] ?? {}) as Record<
						string,
						unknown
					>;
					const parentItemId = parentItemIdForThread(collab["senderThreadId"]);

					if (tool === "spawnAgent") {
						const input = {
							subagent_type: "agent",
							prompt: prompt ?? "",
							...(model !== null ? { model } : {}),
							receiverThreadIds,
						};
						const state = getOrInitToolState(callId);
						if (!state.useEmitted) {
							state.useEmitted = true;
							state.lastInputJson = JSON.stringify(input);
							state.toolName = "Agent";
							for (const threadId of receiverThreadIds) {
								rememberCollabAgent(callId, threadId, model ?? "inherit");
							}
							const events: AgentEvent[] = [
								{
									_tag: "ToolUse",
									itemId: callId,
									tool: "Agent",
									input,
									parentItemId,
								},
							];
							for (const threadId of receiverThreadIds) {
								const run = collabAgentsByThread.get(threadId);
								if (run === undefined) continue;
								const summary = maybeFinishCollabAgent(
									run.parentItemId,
									run,
									agentsStates[threadId],
								);
								if (summary !== null) events.push(summary);
							}
							return events;
						}
						return [];
					}

					const input: Record<string, unknown> = {
						tool,
						...(prompt ? { prompt } : {}),
						...(model ? { model } : {}),
						receiverThreadIds,
						agentsStates,
					};
					if (status) input["status"] = status;

					const state = getOrInitToolState(callId);
					const isTerminal = status === "completed" || status === "failed";
					const toolName = `Collab${tool.charAt(0).toUpperCase()}${tool.slice(1)}`;

					if (!state.useEmitted || isTerminal) {
						state.useEmitted = true;
						state.lastInputJson = JSON.stringify(input);
						trace(
							provider,
							`emit CollabToolUse id=${callId} tool=${toolName} receivers=${receiverThreadIds.length} status=${status ?? ""}`,
						);
						const events: AgentEvent[] = [
							{
								_tag: "ToolUse",
								itemId: callId,
								tool: toolName,
								input,
								parentItemId,
							},
						];
						if (isTerminal) {
							events.push({
								_tag: "ToolResult",
								itemId: callId,
								output: { status, agentsStates },
								isError: status === "failed",
								parentItemId,
							});
							state.resultEmitted = true;
						}
						for (const [threadId, agentState] of Object.entries(agentsStates)) {
							const run = collabAgentsByThread.get(threadId);
							if (run === undefined) continue;
							const summary = maybeFinishCollabAgent(
								run.parentItemId,
								run,
								agentState,
							);
							if (summary !== null) events.push(summary);
						}
						return events;
					}

					trace(
						provider,
						`skip duplicate collab update id=${callId} tool=${tool}`,
					);
					return [];
				}

				default:
					trace(provider, `unknown kind=${kind} payload=${safePreview(u)}`);
					return [];
			}
		})();

		return flushed.length === 0 ? tail : [...flushed, ...tail];
	};

	return {
		finishTools: (reason: string): ReadonlyArray<AgentEvent> => {
			const result: AgentEvent[] = [];
			for (const [itemId, state] of toolStates) {
				if (state.useEmitted && !state.resultEmitted) {
					state.resultEmitted = true;
					result.push({
						_tag: "ToolResult",
						itemId: itemId as AgentItemId,
						output: state.genericOutput ?? reason,
						isError: true,
					});
				}
			}
			return result;
		},
		translate: (update) => {
			const events = translateOne(update);
			const record = recordFrom(update);
			const terminal =
				provider === "generic" &&
				record?.sessionUpdate === "tool_call" &&
				(record.status === "completed" || record.status === "failed");
			const completion = terminal
				? translateOne({ ...record, sessionUpdate: "tool_call_update" })
				: [];
			scheduleCheckpoint();
			return [...events, ...completion];
		},
		flush: () => {
			checkpointScheduler?.cancel();
			const pending = flushPending();
			const finishedTasks = finishGrokCursorTasks();
			return finishedTasks.length === 0
				? pending
				: [...pending, ...finishedTasks];
		},
	};
};

/**
 * Convenience wrapper for callers that don't need stateful coalescing
 * (e.g. unit tests). Equivalent to calling `createAcpTranslator(...).
 * translate(update)` once then flushing — useful when each update is a
 * one-off and you want any buffered text emitted immediately.
 */
export const translateAcpSessionUpdate = (
	update: unknown,
	provider: AcpProviderTag,
): ReadonlyArray<AgentEvent> => {
	const t = createAcpTranslator(provider);
	return [...t.translate(update), ...t.flush()];
};
