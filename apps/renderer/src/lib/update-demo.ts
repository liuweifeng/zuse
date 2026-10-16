import type { UpdateStatus } from "@zuse/contracts";

declare global {
	interface Window {
		__zuseUpdateDemo?: {
			set: (status: UpdateStatus) => void;
			cycle: () => void;
			clear: () => void;
		};
	}
}

export function installUpdateDemo(): void {
	const send = (status: UpdateStatus) => {
		const fn = window.zuse?.updates?.__demoSet;
		if (!fn) {
			console.warn(
				"[update-demo] window.zuse.updates.__demoSet missing — preload may not have reloaded.",
			);
			return;
		}
		void fn(status);
	};

	window.__zuseUpdateDemo = {
		set: send,
		clear: () => send({ kind: "idle" }),
		cycle: () => {
			send({ kind: "available", version: "0.1.4" });
			let percent = 0;
			const tick = setInterval(() => {
				percent = Math.min(100, percent + 12);
				send({
					kind: "downloading",
					percent,
					bytesPerSecond: 850_000 + Math.round(Math.random() * 400_000),
				});
				if (percent >= 100) {
					clearInterval(tick);
					setTimeout(() => send({ kind: "ready", version: "0.1.4" }), 400);
				}
			}, 600);
		},
	};

	console.log("[update-demo] ready. Try __zuseUpdateDemo.cycle() in DevTools.");
}
