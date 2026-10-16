import { useEffect, useRef } from "react";

import { useUiStore } from "../store/ui.ts";
import { ProjectsSidebar } from "./projects-sidebar.tsx";
import { TopBarLeft } from "./top-bar.tsx";

const TRIGGER_WIDTH_PX = 4;
const OVERLAY_WIDTH_PX = 280;
const CLOSE_DELAY_MS = 250;

export function SidebarPeekTrigger() {
	const docked = useUiStore((s) => s.leftSidebarOpen);
	const setPeek = useUiStore((s) => s.setLeftSidebarPeek);

	if (docked) return null;

	return (
		<div
			aria-hidden
			onMouseEnter={() => setPeek(true)}
			className="fixed inset-y-0 left-0 z-40"
			style={{ width: TRIGGER_WIDTH_PX }}
		/>
	);
}

export function SidebarPeekOverlay() {
	const docked = useUiStore((s) => s.leftSidebarOpen);
	const peek = useUiStore((s) => s.leftSidebarPeek);
	const setPeek = useUiStore((s) => s.setLeftSidebarPeek);
	const closeTimer = useRef<number | null>(null);

	useEffect(() => {
		if (docked && closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, [docked]);

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) {
				window.clearTimeout(closeTimer.current);
			}
		};
	}, []);

	if (docked) return null;

	const cancelClose = () => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	};

	const scheduleClose = () => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null;
			setPeek(false);
		}, CLOSE_DELAY_MS);
	};

	return (
		<div
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-background/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-200 ease-out ${
				peek ? "translate-x-0" : "-translate-x-full"
			}`}
			style={{ width: OVERLAY_WIDTH_PX }}
		>
			<TopBarLeft />
			<div className="flex min-h-0 flex-1 flex-col">
				<ProjectsSidebar />
			</div>
		</div>
	);
}
