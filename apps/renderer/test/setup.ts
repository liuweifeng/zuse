if (!("self" in globalThis)) {
	Object.defineProperty(globalThis, "self", {
		configurable: true,
		value: globalThis,
	});
}
