import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
	Platform: { OS: "android" },
	Dimensions: { get: () => ({ width: 0, height: 0 }) },
	useWindowDimensions: () => ({ width: 0, height: 0 }),
}));

vi.mock("~/theme", () => ({ colors: { bg: "#f7f7f5" } }));

const { isTabletSize } = await import("../../../src/lib/form-factor");

describe("form factor", () => {
	it.each([
		[{ width: 412, height: 915 }, false],
		[{ width: 915, height: 412 }, false],
		[{ width: 800, height: 1280 }, true],
		[{ width: 1280, height: 800 }, true],
		[{ width: 600, height: 960 }, true],
	])("classifies %o", (size, tablet) => {
		expect(isTabletSize(size)).toBe(tablet);
	});
});
