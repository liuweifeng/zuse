import {
	ComposerInput,
	EnvironmentId,
	QueuedMessage,
	SessionId,
} from "@zuse/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	pill: null as Record<string, unknown> | null,
}));
vi.mock("../../src/components/composer/tray-pill.tsx", () => ({
	trayPillActionClass: "",
	TrayPill: (props: { leading: ReactNode; actions: ReactNode }) => {
		captured.pill = props;
		return (
			<div>
				{props.leading}
				{props.actions}
			</div>
		);
	},
}));
vi.mock("../../src/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
	TooltipTrigger: ({ render }: { render: ReactNode }) => render,
	TooltipPopup: () => null,
}));
vi.mock("../../src/components/ui/menu", () => ({
	Menu: ({ children }: { children: ReactNode }) => children,
	MenuTrigger: ({ render }: { render: ReactNode }) => render,
	MenuPopup: ({ children }: { children: ReactNode }) => children,
	MenuItem: (props: ComponentProps<"button">) => <button {...props} />,
}));

import { QueueChip } from "../../src/components/composer/queue-chip.tsx";

const sessionId = SessionId.make("queue-pending");
const item = QueuedMessage.make({
	id: "queue-item",
	sessionId,
	position: 1,
	ready: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	input: ComposerInput.make({
		text: "steer",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
	}),
});

describe("pending queue chip", () => {
	it.each([
		true,
		false,
	])("guards mutation controls and drag callbacks when submitting=%s", (submitting) => {
		const onDragStart = vi.fn();
		const onDragOver = vi.fn();
		const onDrop = vi.fn();
		const html = renderToStaticMarkup(
			<QueueChip
				sessionId={sessionId}
				environmentId={EnvironmentId.make("local")}
				item={item}
				index={1}
				count={3}
				running
				submitting={submitting}
				dragging={false}
				onMove={vi.fn()}
				onDragStart={onDragStart}
				onDragOver={onDragOver}
				onDrop={onDrop}
			/>,
		);
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		expect(buttons).toHaveLength(7);
		for (const button of buttons)
			expect(button.includes('disabled=""')).toBe(submitting);
		expect(captured.pill?.draggable).toBe(!submitting);
		for (const eventName of ["onDragStart", "onDragOver", "onDrop"]) {
			const handler = captured.pill?.[eventName] as (event: unknown) => void;
			handler({ preventDefault: vi.fn(), dataTransfer: {} });
		}
		for (const handler of [onDragStart, onDragOver, onDrop])
			expect(handler).toHaveBeenCalledTimes(submitting ? 0 : 1);
	});
});
