import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createElement, useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useTranscriptScrollIntent } from "../../src/hooks/use-transcript-scroll-intent.ts";
import { TranscriptScrollCoordinator } from "../../src/lib/transcript-scroll-coordinator.ts";

export async function run() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let update: (value: number) => void = () => {};
	let list: LegendListRef | null = null;
	const coordinator = new TranscriptScrollCoordinator();
	const rows = Array.from({ length: 10 }, (_, id) => ({ id }));
	function Fixture() {
		const [version, setVersion] = useState(0);
		update = setVersion;
		const listRef = useRef<LegendListRef | null>(null);
		const scrollElementRef = useRef<HTMLDivElement | null>(null);
		const handleScroll = useCallback(() => {}, []);
		useTranscriptScrollIntent({
			listRef,
			scrollElementRef,
			coordinator,
			handleScroll,
			enabled: true,
			messageCount: version === 0 ? 0 : rows.length,
		});
		return version === 0
			? null
			: createElement(LegendList<{ id: number }>, {
					ref: (value: LegendListRef | null) => {
						list = value;
						listRef.current = value;
					},
					data: rows,
					dataVersion: version,
					keyExtractor: (row: { id: number }) => String(row.id),
					estimatedItemSize: 100,
					renderItem: ({ item }: { item: { id: number } }) =>
						createElement(
							"div",
							{ style: { height: item.id === 9 ? 1600 + version * 10 : 100 } },
							String(item.id),
						),
					initialScrollIndex: { index: 8, viewPosition: 0, viewOffset: 16 },
					anchoredEndSpace: {
						anchorIndex: 8,
						anchorOffset: 16,
						onReady: () =>
							coordinator.positionAnchoredTurn({
								animated: false,
								force: true,
							}),
					},
					maintainScrollAtEnd: false,
					maintainVisibleContentPosition: { data: true, size: true },
					style: { height: 600, width: 800, overflowAnchor: "none" },
				});
	}
	const frames = async (count: number) => {
		for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
	};
	try {
		flushSync(() => root.render(createElement(Fixture)));
		// Slow startup exhausts the old listener retry budget before the list mounts.
		await frames(35);
		coordinator.prepareNewTurn(8, 16);
		coordinator.attach({
			getMeasurementState: () => list?.getState() ?? null,
			isAtLiveEdge: () => false,
			scrollToEnd: () => list?.scrollToEnd(),
			scrollToIndex: (options) => list?.scrollToIndex(options),
		});
		flushSync(() => update(1));
		await frames(10);
		const node = (list as LegendListRef | null)?.getScrollableNode();
		if (!node) throw new Error("Transcript did not mount");
		node.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
		node.scrollTop = 1200;
		await frames(3);
		const before = node.scrollTop;
		// A layout notification can arrive after the reader has moved down the reply.
		coordinator.positionAnchoredTurn({ animated: false, force: true });
		await frames(10);
		const after = node.scrollTop;
		if (Math.abs(after - before) > 2)
			throw new Error(
				`Reader scrolled back up: ${before} -> ${after}; mode=${coordinator.getSnapshot().mode}`,
			);
		if (coordinator.getSnapshot().mode !== "detached")
			throw new Error("Reader intent was not registered");
		return { before, after, mode: coordinator.getSnapshot().mode };
	} finally {
		coordinator.dispose();
		root.unmount();
		host.remove();
	}
}
