import { useEffect } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import {
	refreshCloudImages,
	resetCloudImageMonitor,
	subscribeCloudImages,
} from "../lib/cloud-image-monitor.ts";
import { CLOUD_CHECKOUT_STARTED } from "../lib/cloud-onboarding.ts";

/** Monitor builds across navigation; all visible controls belong to Cloud settings. */
export function CloudBuildMonitor() {
	const { isSignedIn, user } = useAuth();
	useEffect(() => {
		resetCloudImageMonitor();
		if (!isSignedIn) return;
		let disposed = false;
		let running = false;
		let wasBuilding = false;
		let checkoutUntil = 0;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			if (running || disposed) return;
			clearTimeout(timer);
			running = true;
			let building = wasBuilding;
			try {
				const next = await refreshCloudImages();
				if (disposed) return;
				if (next.length > 0) checkoutUntil = 0;
				building = next.some((image) => image.state === "building");
				wasBuilding = building;
			} catch {
			} finally {
				running = false;
				if (!disposed)
					timer = setTimeout(
						() => void poll(),
						building || Date.now() < checkoutUntil ? 2_000 : 15_000,
					);
			}
		};
		const unsubscribe = subscribeCloudImages((next) => {
			if (disposed) return;
			if (next.some((image) => image.state === "building")) wasBuilding = true;
			if (next.some((image) => image.state === "building") && !running) {
				clearTimeout(timer);
				timer = setTimeout(() => void poll(), 2_000);
			}
		});
		void poll();
		const wake = () => void poll();
		const checkout = () => {
			checkoutUntil = Date.now() + 10 * 60_000;
			wake();
		};
		window.addEventListener(CLOUD_CHECKOUT_STARTED, checkout);
		window.addEventListener("focus", wake);
		window.addEventListener("online", wake);
		return () => {
			disposed = true;
			unsubscribe();
			clearTimeout(timer);
			window.removeEventListener(CLOUD_CHECKOUT_STARTED, checkout);
			window.removeEventListener("focus", wake);
			window.removeEventListener("online", wake);
			resetCloudImageMonitor();
		};
	}, [isSignedIn, user?.id]);
	return null;
}
