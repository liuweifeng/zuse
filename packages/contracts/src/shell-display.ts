

const SHELL_PREFIX = /^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh|dash|fish)(?=\s|$)/;

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

const collapseWs = (text: string): string => text.trim().replace(/\s+/g, " ");

/**
 * Unwrap a `/bin/zsh -lc "…"` / `bash -lc '…'` / `sh -c …` wrapper to the
 * inner command for display. Unwraps once (not recursively). Returns `raw`
 * unchanged when the shape is unparseable.
 */
export function unwrapShellCommand(raw: string): string {
  const trimmed = raw.trim();
  const shellMatch = SHELL_PREFIX.exec(trimmed);
  if (shellMatch === null) return raw;

  let rest = trimmed.slice(shellMatch[0].length).replace(/^\s+/, "");

  let hasC = false;
  while (rest.startsWith("-")) {
    if (rest.startsWith("--")) return raw;
    const flagMatch = /^(-[^\s]+)\s*/.exec(rest);
    if (flagMatch === null) break;
    const letters = flagMatch[1]!.slice(1);
    if (letters.includes("c")) hasC = true;
    rest = rest.slice(flagMatch[0].length);
  }

  if (!hasC) return raw;
  rest = rest.replace(/^\s+/, "");
  if (rest.length === 0) return raw;

  const parsed = parseCommandArg(rest);
  if (parsed === null) return raw;
  if (parsed.inner.length === 0) return raw;

  if (parsed.rest.trim().length > 0) return raw;
  return parsed.inner;
}

function parseCommandArg(s: string): { inner: string; rest: string } | null {
  if (s[0] === '"') {
    let i = 1;
    let inner = "";
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\") {
        if (i + 1 >= s.length) return null;
        const next = s[i + 1]!;
        if (next === '"' || next === "\\") {
          inner += next;
          i += 2;
          continue;
        }
        inner += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        return { inner, rest: s.slice(i + 1) };
      }
      inner += ch;
      i += 1;
    }
    return null;
  }

  if (s[0] === "'") {
    let i = 1;
    let inner = "";
    while (i < s.length) {

      if (s.slice(i, i + 4) === "'\\''") {
        inner += "'";
        i += 4;
        continue;
      }
      if (s[i] === "'") {
        return { inner, rest: s.slice(i + 1) };
      }
      inner += s[i]!;
      i += 1;
    }
    return null;
  }

  return { inner: s, rest: "" };
}

/**
 * True when `desc` is empty or just echoes the command (or its first line /
 * unwrapped form), including truncated-prefix titles. Used by drivers to
 * omit redundant `description` and by the renderer to fall back to a
 * generic "Bash"/"Shell" label for old persisted sessions.
 */
export function isRedundantShellDescription(
  desc: string,
  cmd: string,
): boolean {
  const d = collapseWs(desc);
  if (d.length === 0) return true;

  const candidates = [
    cmd,
    firstLine(cmd),
    unwrapShellCommand(cmd),
    firstLine(unwrapShellCommand(cmd)),
  ].map(collapseWs);

  for (const c of candidates) {
    if (c.length === 0) continue;
    if (d === c || c.startsWith(d)) return true;
  }
  return false;
}
