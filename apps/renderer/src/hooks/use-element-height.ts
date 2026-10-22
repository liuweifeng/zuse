import { useEffect, useState } from "react";

/** Live `offsetHeight` of a callback-ref'd element; `0` while it's unmounted. */
export function useElementHeight(node: HTMLElement | null): number {
	const [height, setHeight] = useState(0);
	useEffect(() => {
		if (node === null) {
			setHeight(0);
			return;
		}
		const ro = new ResizeObserver(() => setHeight(node.offsetHeight));
		ro.observe(node);
		setHeight(node.offsetHeight);
		return () => ro.disconnect();
	}, [node]);
	return height;
}
