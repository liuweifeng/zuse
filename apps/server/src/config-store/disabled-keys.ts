/**
 * Apply an enable/disable toggle to a settings "disabled keys" list
 * (`disabledSkills`). Enabling removes the key;
 * disabling appends it once. Order of existing keys is preserved.
 */
export const toggleDisabledKey = (
	current: ReadonlyArray<string>,
	key: string,
	enabled: boolean,
): string[] =>
	enabled
		? current.filter((candidate) => candidate !== key)
		: current.includes(key)
			? [...current]
			: [...current, key];
