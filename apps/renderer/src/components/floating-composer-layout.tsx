import { type ReactNode, useState } from "react";
import { useElementHeight } from "../hooks/use-element-height.ts";

/**
 * A transcript with the composer floating over its bottom edge. The composer
 * is measured so the transcript can pad its scroll range (`endInset`) and the
 * last message clears the overlay. Must sit inside `.chat-session-layout`,
 * which defines the reading-column variables.
 */
export function FloatingComposerLayout({
	transcript,
	composer,
}: {
	readonly transcript: (endInset: number) => ReactNode;
	readonly composer: ReactNode;
}) {
	const [composerNode, setComposerNode] = useState<HTMLDivElement | null>(null);
	const endInset = useElementHeight(composerNode);
	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			{transcript(endInset)}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-[var(--chat-row-gutter)]">
				{/* Keep the fade on the full transcript plane. Code blocks can
				    extend beyond the centered composer column. */}
				<div
					data-chat-composer-fade
					aria-hidden
					className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
				/>
				<div
					ref={setComposerNode}
					className="pointer-events-auto mx-auto w-full max-w-[var(--chat-reading-column)] pt-1"
				>
					{composer}
				</div>
			</div>
		</div>
	);
}
