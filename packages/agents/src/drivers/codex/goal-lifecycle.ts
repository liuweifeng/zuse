import type { ThreadGoalStatus } from "@zuse/contracts";
/** Native goal status, rather than each autonomous native turn, owns goal completion. */
export const makeCodexGoalLifecycle = () => {
	let owned = false;
	let active = false;
	let physicalTurn = false;
	return {
		start: () => {
			owned = true;
			active = true;
		},
		turnStarted: () => {
			physicalTurn = true;
		},
		turnCompleted: (failed: boolean) => {
			physicalTurn = false;
			if (failed) active = false;
			return !owned || !active;
		},
		updated: (status: ThreadGoalStatus) => {
			active = status === "active";
			return owned && !active && !physicalTurn;
		},
		cleared: () => {
			active = false;
			return owned && !physicalTurn;
		},
	};
};
