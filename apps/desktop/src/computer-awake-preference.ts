import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import type { ComputerAwakeMode } from "@zuse/contracts";
import { readPreference, writePreference } from "./atomic-preference.ts";

const PREFERENCE_FILE = "computer-awake.json";
export const DEFAULT_COMPUTER_AWAKE_MODE: ComputerAwakeMode = "auto";

const isComputerAwakeMode = (value: unknown): value is ComputerAwakeMode =>
	value === "off" || value === "auto" || value === "always";

export const readComputerAwakePreference = async (
	userData: string,
): Promise<ComputerAwakeMode> => {
	try {
		const parsed = await readPreference(
			userData,
			PREFERENCE_FILE,
			(value) => value,
		);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"mode" in parsed &&
			isComputerAwakeMode(parsed.mode)
		) {
			return parsed.mode;
		}
	} catch {}
	return DEFAULT_COMPUTER_AWAKE_MODE;
};

export const writeComputerAwakePreference = async (
	userData: string,
	mode: ComputerAwakeMode,
): Promise<void> => {
	await writePreference(userData, PREFERENCE_FILE, { mode });
};

/** Atomic preference replacement remains observable while the desktop is detached. */
export const watchComputerAwakePreference = (
	userData: string,
	onMode: (mode: ComputerAwakeMode) => void,
) => {
	let disposed = false;
	let generation = 0;
	const path = join(userData, PREFERENCE_FILE);
	const refresh = () => {
		const current = ++generation;
		void readComputerAwakePreference(userData).then((mode) => {
			if (!disposed && current === generation) onMode(mode);
		});
	};

	watchFile(path, { persistent: false, interval: 2000 }, refresh);
	refresh();
	return () => {
		disposed = true;
		unwatchFile(path, refresh);
	};
};
