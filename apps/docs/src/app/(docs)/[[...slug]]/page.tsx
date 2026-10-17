import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
	MarkdownCopyButton,
	ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
	type PageLink,
	Prerequisites,
	RelatedPages,
} from "@/components/mdx-components";
import { GITHUB_URL } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type PageProps = {
	params: Promise<{ slug?: string[] }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata({
	params,
}: PageProps): Promise<Metadata> {
	const page = source.getPage((await params).slug);
	if (!page) notFound();

	return {
		title: page.data.title,
		description: page.data.description,
		alternates: { canonical: page.url },
	};
}

export default async function DocumentationPage({ params }: PageProps) {
	const page = source.getPage((await params).slug);
	if (!page) notFound();

	const Body = page.data.body;
	const toPageLink = (href: string): PageLink => {
		const target = source.getPage(href.split("/").filter(Boolean));
		return {
			href,
			title: target?.data.navTitle ?? target?.data.title ?? href,
		};
	};
	const markdownUrl = `${page.url}.md`;
	const githubUrl = `${GITHUB_URL}/blob/main/apps/docs/content/docs/${page.data.info.path}`;
	const related = Array.from(
		new Set([
			...page.data.related,
			...source
				.getPages()
				.filter(
					(candidate) =>
						candidate.url !== page.url &&
						(candidate.data.related.includes(page.url) ||
							candidate.data.prerequisites.includes(page.url)),
				)
				.map((candidate) => candidate.url),
		]),
	)
		.slice(0, 6)
		.map(toPageLink);

	const pageActions = (
		<div className="page-actions">
			<MarkdownCopyButton markdownUrl={markdownUrl} />
			<ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
		</div>
	);

	return (
		<main className="contents">
			<DocsPage
				toc={page.data.toc}
				full={page.data.full}
				breadcrumb={{ enabled: false }}
				tableOfContent={{ style: "clerk", footer: pageActions }}
				tableOfContentPopover={{ style: "clerk", footer: pageActions }}
			>
				<header className="docs-header">
					<DocsTitle>{page.data.title}</DocsTitle>
					<DocsDescription className="docs-description">
						{page.data.description}
					</DocsDescription>
				</header>

				<DocsBody>
					<Prerequisites links={page.data.prerequisites.map(toPageLink)} />
					<Body components={getMDXComponents()} />
					<RelatedPages links={related} />
				</DocsBody>
			</DocsPage>
		</main>
	);
}
