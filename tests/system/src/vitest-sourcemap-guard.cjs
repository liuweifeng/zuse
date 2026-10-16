"use strict";

const convertSourceMap = require("convert-source-map");
const fromSource = convertSourceMap.fromSource.bind(convertSourceMap);

convertSourceMap.fromSource = (source) => {
	try {
		return fromSource(source);
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
};
