import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import {
	useTranscriptDisclosure,
	useTranscriptDisclosures,
} from "../../src/store/transcript-disclosures.ts";

function Disclosure({ id, live = false }: { id: string; live?: boolean }) {
	const [open] = useTranscriptDisclosure(
		`${id}:${live ? "live" : "settled"}`,
		live,
	);
	return (
		<button type="button" aria-expanded={open}>
			Activity
		</button>
	);
}
beforeEach(() => useTranscriptDisclosures.setState({ byKey: {} }));
it("keeps a manual close and a manual reopen across row remounts", () => {
	const render = () => renderToStaticMarkup(<Disclosure id="row" live />);
	expect(render()).toContain('aria-expanded="true"');
	useTranscriptDisclosures.getState().toggle("row:live", true);
	expect(render()).toContain('aria-expanded="false"');
	expect(render()).toContain('aria-expanded="false"');
	useTranscriptDisclosures.getState().toggle("row:live", true);
	expect(render()).toContain('aria-expanded="true"');
});
it("collapses when a turn finishes even if live activity was explicitly opened", () => {
	const store = useTranscriptDisclosures.getState();
	store.toggle("row:live", true);
	store.toggle("row:live", true);
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="false"',
	);
	store.toggle("row:settled", false);
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="true"',
	);
	expect(renderToStaticMarkup(<Disclosure id="another-row" />)).toContain(
		'aria-expanded="false"',
	);
});
it("bounds retained disclosure state", () => {
	for (let i = 0; i < 2050; i++)
		useTranscriptDisclosures.getState().toggle(String(i), false);
	expect(Object.keys(useTranscriptDisclosures.getState().byKey)).toHaveLength(
		2048,
	);
	expect(useTranscriptDisclosures.getState().byKey["2049"]).toBe(true);
});
