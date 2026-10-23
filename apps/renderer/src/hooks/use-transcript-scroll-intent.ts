import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect } from "react";
import type { TranscriptScrollCoordinator } from "../lib/transcript-scroll-coordinator.ts";

export function useTranscriptScrollIntent({
	listRef,
	scrollElementRef,
	coordinator,
	handleScroll,
	enabled,
	messageCount,
}: {
	readonly listRef: RefObject<LegendListRef | null>;
	readonly scrollElementRef: RefObject<HTMLDivElement | null>;
	readonly coordinator: TranscriptScrollCoordinator;
	readonly handleScroll: () => void;
	readonly enabled: boolean;
	readonly messageCount: number;
}) {
	const hasMessages = messageCount > 0;
	useEffect(() => {
		if (!enabled || !hasMessages) return;
		let removeListeners: (() => void) | null = null;
		let frame: number | null = null;
		const attachListeners = (remainingAttempts: number) => {
			const scrollNode = listRef.current?.getScrollableNode();
			if (scrollNode === undefined) {
				if (remainingAttempts > 0) {
					frame = requestAnimationFrame(() =>
						attachListeners(remainingAttempts - 1),
					);
				}
				return;
			}
			if (scrollNode instanceof HTMLDivElement) {
				scrollNode.dataset.pane = "chat";
				scrollNode.tabIndex = -1;
				scrollElementRef.current = scrollNode;
			}
			const takeControl = (
				intent: "interaction" | "scroll" | "scroll-backward",
			) => {
				coordinator.readerTookControl(intent);
				if (intent !== "interaction") requestAnimationFrame(handleScroll);
			};
			const onKeyDown = (event: KeyboardEvent) => {
				if (
					[
						"ArrowUp",
						"ArrowDown",
						"PageUp",
						"PageDown",
						"Home",
						"End",
						" ",
					].includes(event.key)
				) {
					takeControl(
						["ArrowUp", "PageUp", "Home"].includes(event.key) ||
							(event.key === " " && event.shiftKey)
							? "scroll-backward"
							: "scroll",
					);
				}
			};
			const onFocusIn = (event: FocusEvent) => {
				const target = event.target;
				if (
					target instanceof HTMLElement &&
					target.matches("a, button, input, textarea, [role='button']")
				) {
					takeControl("interaction");
				}
			};
			const onSelectionChange = () => {
				const selection = document.getSelection();
				if (selection?.isCollapsed !== false) return;
				const anchorNode = selection.anchorNode;
				if (anchorNode !== null && scrollNode.contains(anchorNode))
					takeControl("interaction");
			};
			const onScrollIntent = () => takeControl("scroll");
			const onWheel = (event: WheelEvent) => {
				if (event.deltaY !== 0)
					takeControl(event.deltaY < 0 ? "scroll-backward" : "scroll");
			};
			const onPointerDown = (event: PointerEvent) => {
				const bounds = scrollNode.getBoundingClientRect();
				const scrollbarHitWidth = Math.max(
					12,
					scrollNode.offsetWidth - scrollNode.clientWidth,
				);
				const scrollbarIsLeft =
					window.getComputedStyle(scrollNode).direction === "rtl";
				const isScrollbarIntent =
					event.target === scrollNode &&
					(scrollbarIsLeft
						? event.clientX <= bounds.left + scrollbarHitWidth
						: event.clientX >= bounds.right - scrollbarHitWidth);
				takeControl(isScrollbarIntent ? "scroll" : "interaction");
			};
			scrollNode.addEventListener("wheel", onWheel, { passive: true });
			scrollNode.addEventListener("touchmove", onScrollIntent, {
				passive: true,
			});
			scrollNode.addEventListener("pointerdown", onPointerDown, {
				passive: true,
			});
			scrollNode.addEventListener("keydown", onKeyDown);
			scrollNode.addEventListener("focusin", onFocusIn);
			document.addEventListener("selectionchange", onSelectionChange);
			removeListeners = () => {
				scrollNode.removeEventListener("wheel", onWheel);
				scrollNode.removeEventListener("touchmove", onScrollIntent);
				scrollNode.removeEventListener("pointerdown", onPointerDown);
				scrollNode.removeEventListener("keydown", onKeyDown);
				scrollNode.removeEventListener("focusin", onFocusIn);
				document.removeEventListener("selectionchange", onSelectionChange);
			};
		};
		frame = requestAnimationFrame(() => attachListeners(30));
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			removeListeners?.();
		};
	}, [
		coordinator,
		handleScroll,
		enabled,
		hasMessages,
		listRef,
		scrollElementRef,
	]);
}
