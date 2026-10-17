import { docs } from "collections/server";
import type { Folder, Node, Root } from "fumadocs-core/page-tree";
import { type LoaderPlugin, loader } from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement, type ReactNode } from "react";

const LOGO_PREFIX = "logo:";

function resolveIcon(icon: unknown): ReactNode {
	if (typeof icon !== "string") return icon as ReactNode;
	if (icon.startsWith(LOGO_PREFIX)) {
		return createElement("img", {
			src: `/logos/${icon.slice(LOGO_PREFIX.length)}.svg`,
			alt: "",
			"data-logo-icon": "",
		});
	}
	const Icon = icons[icon as keyof typeof icons];
	if (!Icon) throw new Error(`Unknown documentation icon: ${icon}`);
	return createElement(Icon);
}

/**
 * Resolves Lucide names and `logo:<name>` provider marks, and swaps page
 * titles for their shorter `navTitle` in navigation.
 */
const navigationPlugin: LoaderPlugin = {
	name: "zuse:navigation",
	transformPageTree: {
		file(node, filePath) {
			const file = filePath ? this.storage.read(filePath) : undefined;
			const data =
				file?.format === "page"
					? (file.data as { navTitle?: string; icon?: string })
					: undefined;
			const isOverview = filePath?.endsWith("/index.mdx") ?? false;
			return {
				...node,
				name: data?.navTitle ?? (isOverview ? "Overview" : node.name),
				icon: resolveIcon(data?.icon ?? node.icon),
			};
		},
		folder(node) {
			return { ...node, icon: resolveIcon(node.icon) };
		},
		separator(node) {
			return { ...node, icon: resolveIcon(node.icon) };
		},
	},
};

export const source = loader({
	baseUrl: "/",
	source: docs.toFumadocsSource(),
	plugins: [navigationPlugin],
});

function findSection(id: string): Folder {
	const section = source.pageTree.children.find(
		(node): node is Folder => node.type === "folder" && node.$id === id,
	);
	if (!section) throw new Error(`Missing documentation section: ${id}`);
	return section;
}

/** A section renders as a labeled group: its overview first, then its pages. */
function flattenSection(id: string): Node[] {
	const section = findSection(id);
	return [
		{ type: "separator", $id: `${id}:label`, name: section.name },
		...(section.index ? [section.index] : []),
		...section.children,
	];
}

function sectionTab(
	id: string,
	options: { name: string; description: string; icon: string },
	sections: ReadonlyArray<string>,
): Folder {
	return {
		$id: `tab:${id}`,
		type: "folder",
		root: true,
		name: options.name,
		description: options.description,
		icon: resolveIcon(options.icon),
		children: sections.flatMap(flattenSection),
	};
}

/** How-to guides keep their own separators from `how-to/meta.json`. */
function howToTab(): Folder {
	const section = findSection("how-to");
	return {
		...section,
		$id: "tab:how-to",
		root: true,
		description: "Step-by-step tasks",
		icon: resolveIcon("ListChecks"),
		index: undefined,
		children: [...(section.index ? [section.index] : []), ...section.children],
	};
}

/**
 * Regroup content folders into top-level tabs without changing public URLs.
 * Each tab is a Fumadocs root folder: the section switcher lists the tabs and
 * the sidebar shows the active tab's labeled groups.
 */
export const documentationTree: Root = {
	...source.pageTree,
	children: [
		sectionTab(
			"documentation",
			{
				name: "Documentation",
				description: "Guides and features",
				icon: "BookOpen",
			},
			[
				"start",
				"concepts",
				"desktop",
				"providers",
				"projects",
				"composer",
				"workspace",
			],
		),
		sectionTab(
			"remote",
			{
				name: "Remote and Serve",
				description: "Browser, iPhone, and hosts",
				icon: "Radio",
			},
			["remote", "mobile", "serve"],
		),
		howToTab(),
		sectionTab(
			"reference",
			{
				name: "Reference",
				description: "Settings, keys, and schemas",
				icon: "BookMarked",
			},
			["reference"],
		),
	],
};
