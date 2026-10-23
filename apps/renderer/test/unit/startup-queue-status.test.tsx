import { ComposerInput, EnvironmentId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartupQueueStatus } from "../../src/components/composer/startup-queue-status.tsx";

const ref = {
	environmentId: EnvironmentId.make("env"),
	sessionId: SessionId.make("session"),
};
const input = (attachments: ComposerInput["attachments"]) =>
	new ComposerInput({ text: "Hi", attachments, fileRefs: [], skillRefs: [] });
const render = (value: ComposerInput, creating = false) =>
	renderToStaticMarkup(
		<StartupQueueStatus
			sessionRef={ref}
			queueId="q"
			input={value}
			creating={creating}
		/>,
	);

describe("startup queue status", () => {
	it("says nothing for a text message that is still being saved", () => {
		expect(render(input([]))).toBe("");
	});

	it("asks to reattach only when uploaded files were lost", () => {
		const markup = render(
			input([{ id: "a", mimeType: "image/png", originalName: "a.png" }]),
		);
		expect(markup).toContain("Files weren’t attached");
	});

	it("shows preparation while the chat is still being created", () => {
		expect(render(input([]), true)).not.toBe("");
	});
});
