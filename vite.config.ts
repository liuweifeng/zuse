import { defineConfig } from "vite-plus";

export default defineConfig({
	assetsInclude: ["**/*.sh"],
	plugins: [
		{
			name: "raw-shell-modules",
			enforce: "pre",
			transform(source, id) {
				return id.endsWith(".sh")
					? { code: `export default ${JSON.stringify(source)}`, map: null }
					: null;
			},
		},
	],
});
