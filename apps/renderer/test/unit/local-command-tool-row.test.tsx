import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ToolRow } from "../../src/components/tool-row.tsx";

it.each([
	"local_command_execute",
	"mcp__zuse__local_command_execute",
])("renders %s as a local shell row", (tool) => {
	const html = renderToStaticMarkup(
		<ToolRow
			tool={tool}
			input={{ command: "git status", cwd: "/Users/test" }}
		/>,
	);
	expect(html).toContain("Local computer");
	expect(html).toContain("Local command");
	expect(html).toContain("git status");
});
