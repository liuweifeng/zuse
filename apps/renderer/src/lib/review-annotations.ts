import type { SelectedLineRange } from "@pierre/diffs";
import { fnv1a } from "./fnv1a.ts";

export type ReviewAnnotationAnchor = {
	readonly side: "additions" | "deletions";
	readonly lineNumber: number;
};

/** Anchor an annotation to the endpoint where the gutter interaction finished. */
export const getReviewAnnotationAnchor = (
	range: SelectedLineRange,
): ReviewAnnotationAnchor | null => {
	const side = range.endSide ?? range.side;
	if (side === null || side === undefined) return null;
	return { side, lineNumber: range.end };
};

export const getReviewItemVersion = ({
	collapsed,
	editing,
	annotationKey,
}: {
	readonly collapsed: boolean;
	readonly editing: boolean;
	readonly annotationKey: string;
}): number => {
	return fnv1a(`${Number(collapsed)}:${Number(editing)}:${annotationKey}`);
};
