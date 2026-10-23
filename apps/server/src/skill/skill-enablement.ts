import * as path from "node:path";
import { type ProviderId, Skill } from "@zuse/contracts";

const ZUSE_OVERRIDE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
	"claude",
	"zuse",
]);

export const isZuseSkillOverrideProvider = (providerId: ProviderId): boolean =>
	ZUSE_OVERRIDE_PROVIDERS.has(providerId);

/**
 * `disabledSkills` key: `<providerId>:<name>`. Scope is not part of the key —
 * discovery lets a project skill shadow a global one with the same name, and
 * providers enforce skills by name.
 */
export const skillEnablementKey = (
	providerId: ProviderId,
	name: string,
): string => `${providerId}:${name}`;

/** Whether any `disabledSkills` key targets `providerId`. */
export const hasDisabledSkillsFor = (
	disabledSkills: ReadonlyArray<string>,
	providerId: ProviderId,
): boolean => disabledSkills.some((key) => key.startsWith(`${providerId}:`));

/**
 * Stamp effective `enabled` / `toggleSupported` onto Claude/Zuse skills from
 * the global `disabledSkills` setting. Skills of other providers pass through
 * untouched (their discovery reports native enablement).
 */
export const applySkillEnablement = (
	skills: ReadonlyArray<Skill>,
	disabledSkills: ReadonlyArray<string>,
): ReadonlyArray<Skill> => {
	const disabled = new Set(disabledSkills);
	return skills.map((skill) =>
		isZuseSkillOverrideProvider(skill.providerId)
			? Skill.make({
					...skill,
					enabled: !disabled.has(
						skillEnablementKey(skill.providerId, skill.name),
					),
					toggleSupported: true,
				})
			: skill,
	);
};

const claudeSkillNames = (skill: Skill): ReadonlyArray<string> => {
	if (
		skill.filePath === null ||
		!/^skill\.md$/i.test(path.basename(skill.filePath))
	) {
		return [skill.name];
	}
	const directory = path.basename(path.dirname(skill.filePath));
	const separator = skill.name.indexOf(":");
	const directoryName =
		separator >= 0
			? `${skill.name.slice(0, separator + 1)}${directory}`
			: directory;
	return directoryName === skill.name
		? [skill.name]
		: [skill.name, directoryName];
};

/**
 * Claude Agent SDK `skills` allowlist for a session. `undefined` (leave the
 * SDK default) unless at least one discovered skill is disabled; otherwise the
 * names of every enabled discovered skill, following the SDK's matching rules
 * (SKILL.md `name` / directory name, or `plugin:skill`). A name that belongs
 * to a disabled skill is never emitted as an alias of an enabled one.
 */
export const claudeSkillAllowlist = (
	skills: ReadonlyArray<Skill>,
): ReadonlyArray<string> | undefined => {
	const disabled = skills.filter((skill) => !skill.enabled);
	if (disabled.length === 0) return undefined;
	const disabledNames = new Set(disabled.flatMap(claudeSkillNames));
	const allowed = new Set<string>();
	for (const skill of skills) {
		if (!skill.enabled) continue;
		allowed.add(skill.name);
		for (const name of claudeSkillNames(skill)) {
			if (!disabledNames.has(name)) allowed.add(name);
		}
	}
	return [...allowed];
};
