import { createMDX } from "fumadocs-mdx/next";

const nextConfig = {
	transpilePackages: ["@zuse/i18n"],

	env: {
		NEXT_PUBLIC_POSTHOG_KEY:
			process.env.NEXT_PUBLIC_POSTHOG_KEY ||
			process.env.VITE_POSTHOG_KEY ||
			process.env.ZUSE_POSTHOG_KEY ||
			"",
		NEXT_PUBLIC_POSTHOG_HOST:
			process.env.NEXT_PUBLIC_POSTHOG_HOST ||
			process.env.VITE_POSTHOG_HOST ||
			process.env.ZUSE_POSTHOG_HOST ||
			"https://us.i.posthog.com",
	},
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
	async headers() {
		return [
			{
				source: "/models/:path*",
				headers: [
					{
						key: "Cache-Control",
						value:
							"public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
					},
					{ key: "Access-Control-Allow-Origin", value: "*" },
				],
			},
			{
				source: "/schemas/:path*",
				headers: [
					{
						key: "Cache-Control",
						value: "public, max-age=3600, s-maxage=86400",
					},
					{ key: "Access-Control-Allow-Origin", value: "*" },
				],
			},
		];
	},
	async redirects() {
		return [
			{
				source: "/docs/repository-settings",
				destination: "https://docs.zuse.sh/projects/repository-settings",
				permanent: true,
			},
			{
				source: "/docs/schemas",
				destination: "https://docs.zuse.sh/reference/schemas",
				permanent: true,
			},
			{
				source: "/docs/scripts",
				destination: "https://docs.zuse.sh/projects/scripts",
				permanent: true,
			},
			{
				source: "/docs/settings",
				destination: "https://docs.zuse.sh/reference/settings",
				permanent: true,
			},
			{
				source: "/docs/worktree-includes",
				destination: "https://docs.zuse.sh/projects/file-includes",
				permanent: true,
			},
			{
				source: "/docs/zuse-skill",
				destination: "https://docs.zuse.sh/reference/bundled-skill",
				permanent: true,
			},
			{
				source: "/docs/:path*",
				destination: "https://docs.zuse.sh/:path*",
				permanent: true,
			},
		];
	},
};

const withMDX = createMDX();

export default withMDX(nextConfig);
