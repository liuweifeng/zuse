import { createMDX } from "fumadocs-mdx/next";

const nextConfig = {
	transpilePackages: ["@zuse/analytics"],
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
	async redirects() {
		return [
			{
				source: "/",
				destination: "/start",
				permanent: true,
			},
			{
				source: "/providers/gemini",
				destination: "/providers/acp#gemini-cli",
				permanent: true,
			},
		];
	},
	async rewrites() {
		return [
			{
				source: "/:path*.md",
				destination: "/api/markdown/:path*",
			},
		];
	},
};

export default createMDX()(nextConfig);
