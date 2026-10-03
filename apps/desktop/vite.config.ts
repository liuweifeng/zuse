import { defineConfig } from "vite-plus";

import desktopPack from "./tsdown.config.ts";

export default defineConfig({
	pack: desktopPack,
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
	},
});
