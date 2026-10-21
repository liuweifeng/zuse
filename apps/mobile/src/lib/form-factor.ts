import { Dimensions, Platform, useWindowDimensions } from "react-native";

import { colors } from "~/theme";

/** Android's `sw600dp` breakpoint: the smallest screen side of a tablet. */
export const TABLET_MIN_SIDE = 600;

/** Widest comfortable column for reading chats and forms on large screens. */
export const READABLE_WIDTH = 840;

export const isTabletSize = (size: {
	readonly width: number;
	readonly height: number;
}): boolean => Math.min(size.width, size.height) >= TABLET_MIN_SIDE;

/** Android tablets rotate freely; phones keep the portrait-first layout. */
export const isTabletDevice = (): boolean =>
	Platform.OS === "android" && isTabletSize(Dimensions.get("screen"));

/** Window-based, so split-screen and freeform windows get the phone layout. */
export function useIsWideLayout(): boolean {
	const { width } = useWindowDimensions();
	return width >= TABLET_MIN_SIDE;
}

/**
 * Side inset that centers a readable column on wide Android windows; 0 on
 * phones. iOS ships as an iPhone-only app and keeps its existing layout.
 */
export function useReadableInset(): number {
	const { width } = useWindowDimensions();
	return Platform.OS === "android" && width >= TABLET_MIN_SIDE
		? Math.max(0, Math.floor((width - READABLE_WIDTH) / 2))
		: 0;
}

/** Screen `contentStyle` that keeps content in the readable column. */
export function useReadableContentStyle() {
	const inset = useReadableInset();
	return { backgroundColor: colors.bg, paddingHorizontal: inset };
}
