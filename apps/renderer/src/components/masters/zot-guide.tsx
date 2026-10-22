import "@zuse/i18n/english/projects";
import { EnvironmentId, type MasterSnapshot } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	canInsertZotExample,
	findZotGuideTarget,
	insertZotExample,
	leaseDetailsPanel,
	restoreZotGuideFocus,
	ZOT_GUIDE_TARGETS,
	zotGuideNeedsDetails,
	zotGuideVisible,
} from "../../lib/zot-guide.ts";
import { useComposerBridge } from "../../store/composer-bridge.ts";
import { composerDraftKeyForSession } from "../../store/composer-drafts.ts";
import { useMastersStore } from "../../store/masters.ts";
import {
	useZotOnboardingStore,
	ZOT_ONBOARDING_STEPS,
	type ZotOnboardingStep,
} from "../../store/zot-onboarding.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover.tsx";

const ACTIVE_ATTRIBUTE = "data-zot-guide-active";

const FALLBACK_PLACEMENT = { side: "bottom", align: "center" } as const;

/** Card placement next to each target; the positioner flips on collision. */
const PLACEMENT: Record<
	ZotOnboardingStep,
	{ side: "top" | "bottom" | "left"; align: "start" | "center" | "end" }
> = {
	welcome: { side: "bottom", align: "start" },
	repositories: { side: "left", align: "start" },
	brief: { side: "top", align: "center" },
	slaves: { side: "left", align: "center" },
	continuity: { side: "bottom", align: "end" },
};

/**
 * Step-by-step introduction for a Zot surface. It only points at controls
 * and explains them: nothing here runs commands, sends messages, or changes
 * repositories or permissions. Mounted once the Zot's snapshot has loaded.
 */
export function ZotGuide({
	rootRef,
	snapshot,
	environmentId,
	composerMounted,
}: {
	/** The Zot surface; targets are looked up inside it only. */
	readonly rootRef: RefObject<HTMLElement | null>;
	readonly snapshot: MasterSnapshot;
	readonly environmentId: string;
	/** Whether the coordinator conversation (with its composer) is on screen. */
	readonly composerMounted: boolean;
}) {
	const open = useZotOnboardingStore((state) => state.open);
	const step = useZotOnboardingStore((state) => state.step);
	const bridgeDraftKey = useComposerBridge((state) => state.draftKey);
	const session = snapshot.coordinator;
	const draftKey = session
		? composerDraftKeyForSession({
				environmentId: EnvironmentId.make(environmentId),
				sessionId: session.id,
			})
		: null;
	// Open at mount means automatic (first use or resume); once shown, later
	// opens (replay) no longer wait for the composer.
	const settled = useRef(!open);
	const visible = zotGuideVisible({
		open,
		waitForComposer: !settled.current && composerMounted,
		draftKey,
		bridgeDraftKey,
	});
	if (visible) settled.current = true;
	const target = useGuideTarget(rootRef, visible ? step : null);
	useDetailsLease(visible && zotGuideNeedsDetails(step));
	useFocusReturn(rootRef, visible, draftKey);

	if (!visible) return null;
	return (
		<ZotGuideCard
			step={step}
			snapshot={snapshot}
			draftKey={draftKey}
			anchor={target ?? fallbackAnchor(rootRef)}
			anchored={target !== null}
		/>
	);
}

/** When the card closes and focus fell to the page, put it somewhere useful. */
function useFocusReturn(
	rootRef: RefObject<HTMLElement | null>,
	visible: boolean,
	draftKey: string | null,
) {
	const shown = useRef(false);
	useEffect(() => {
		if (visible) {
			shown.current = true;
			return;
		}
		if (!shown.current) return;
		shown.current = false;
		const active = document.activeElement;
		restoreZotGuideFocus(
			!active || active === document.body || !active.isConnected,
			rootRef.current,
			useComposerBridge.getState(),
			draftKey,
		);
	}, [rootRef, visible, draftKey]);
}

/** Tracks the marked control for `step` as panels mount, slide or hide. */
function useGuideTarget(
	rootRef: RefObject<HTMLElement | null>,
	step: ZotOnboardingStep | null,
) {
	const [element, setElement] = useState<Element | null>(null);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || step === null) {
			setElement(null);
			return;
		}
		const target = ZOT_GUIDE_TARGETS[step];
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() =>
				setElement(findZotGuideTarget(root, target)),
			);
		};
		setElement(findZotGuideTarget(root, target));
		const observer = new MutationObserver(update);
		observer.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["inert", "hidden"],
		});
		window.addEventListener("resize", update);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [rootRef, step]);
	useEffect(() => {
		element?.setAttribute(ACTIVE_ATTRIBUTE, "");
		return () => element?.removeAttribute(ACTIVE_ATTRIBUTE);
	}, [element]);
	return element;
}

/** Shows Details while a step needs it; restores it if the guide opened it. */
function useDetailsLease(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const lease = leaseDetailsPanel(useMastersStore);
		lease.acquire();
		return lease.release;
	}, [active]);
}

/**
 * Without a visible target the card sits below the top of the conversation
 * column (or the whole surface before that column mounts).
 */
const fallbackAnchor = (rootRef: RefObject<HTMLElement | null>) => ({
	getBoundingClientRect: () => {
		const root = rootRef.current;
		const area = root?.querySelector("[data-zot-guide-area]") ?? root;
		const rect = area?.getBoundingClientRect();
		const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
		const y = rect ? rect.top + 24 : 72;
		return new DOMRect(x, y, 0, 0);
	},
});

function ZotGuideCard({
	step,
	snapshot,
	draftKey,
	anchor,
	anchored,
}: {
	readonly step: ZotOnboardingStep;
	readonly snapshot: MasterSnapshot;
	/** This Zot's coordinator composer draft key, if it has a session. */
	readonly draftKey: string | null;
	readonly anchor: Element | { getBoundingClientRect: () => DOMRect };
	/** Whether `anchor` is the step's own control rather than the fallback. */
	readonly anchored: boolean;
}) {
	const { message } = useMessages("projects");
	const guide = useZotOnboardingStore();
	const bridge = useComposerBridge();
	const primary = useRef<HTMLButtonElement>(null);
	const placement = anchored ? PLACEMENT[step] : FALLBACK_PLACEMENT;
	return (
		<Popover
			open
			onOpenChange={(next, details) => {
				// Clicks on the real controls leave the guide up; only Escape
				// (or Skip) dismisses it.
				if (!next && details.reason === "escape-key") guide.dismiss();
			}}
		>
			<PopoverPopup
				anchor={anchor}
				side={placement.side}
				align={placement.align}
				sideOffset={10}
				initialFocus={primary}
				data-zot-guide-card=""
				className="w-80"
				onKeyDown={(event) => {
					if (event.key === "ArrowRight") guide.next();
					if (event.key === "ArrowLeft") guide.back();
				}}
			>
				<ZotGuideBody
					step={step}
					hasRepositories={snapshot.master.repositories.length > 0}
					onTryExample={
						canInsertZotExample(bridge, draftKey)
							? () =>
									insertZotExample(
										bridge,
										draftKey,
										message("projects:masters_guide_brief_example_text"),
									)
							: null
					}
					targetHidden={!anchored}
					primaryRef={primary}
					onSkip={guide.dismiss}
					onBack={guide.back}
					onNext={guide.next}
				/>
			</PopoverPopup>
		</Popover>
	);
}

/** The card's content; explanation only, its sole effect is the callbacks. */
export function ZotGuideBody({
	step,
	hasRepositories,
	onTryExample,
	targetHidden,
	primaryRef,
	onSkip,
	onBack,
	onNext,
}: {
	readonly step: ZotOnboardingStep;
	readonly hasRepositories: boolean;
	/** Present only when the example can go into this Zot's own composer. */
	readonly onTryExample: (() => void) | null;
	readonly targetHidden: boolean;
	readonly primaryRef?: RefObject<HTMLButtonElement | null>;
	readonly onSkip: () => void;
	readonly onBack: () => void;
	readonly onNext: () => void;
}) {
	const { message } = useMessages("projects");
	const index = ZOT_ONBOARDING_STEPS.indexOf(step);
	const last = index === ZOT_ONBOARDING_STEPS.length - 1;
	const content: Record<ZotOnboardingStep, ReactNode> = {
		welcome: (
			<>
				<p>{message("projects:masters_guide_welcome_body")}</p>
				<p>{message("projects:masters_guide_welcome_preview")}</p>
			</>
		),
		repositories: (
			<>
				<p>{message("projects:masters_guide_repositories_body")}</p>
				<p>
					{hasRepositories
						? message("projects:masters_guide_repositories_optional")
						: message("projects:masters_guide_repositories_empty")}
				</p>
			</>
		),
		brief: (
			<>
				<p>{message("projects:masters_guide_brief_body")}</p>
				{onTryExample ? (
					<div className="flex items-center gap-2">
						<Button variant="secondary" onClick={onTryExample}>
							{message("projects:masters_guide_brief_example")}
						</Button>
						<span className="text-[11px]">
							{message("projects:masters_guide_brief_example_hint")}
						</span>
					</div>
				) : null}
			</>
		),
		slaves: (
			<>
				<p>{message("projects:masters_guide_slaves_body")}</p>
				<p>{message("projects:masters_guide_slaves_controls")}</p>
			</>
		),
		continuity: (
			<>
				<p>{message("projects:masters_guide_continuity_body")}</p>
				<p>{message("projects:masters_guide_continuity_memory")}</p>
			</>
		),
	};
	return (
		<div className="flex flex-col gap-2.5 px-1.5 py-1 text-[12px] leading-[18px]">
			<div className="flex items-center gap-2">
				<PopoverTitle className="min-w-0 flex-1 text-[13px] leading-5 font-medium">
					{message(`projects:masters_guide_${step}_title`)}
				</PopoverTitle>
				<span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
					{message("projects:masters_guide_step_count", {
						current: index + 1,
						total: ZOT_ONBOARDING_STEPS.length,
					})}
				</span>
			</div>
			<div className="flex flex-col gap-1.5 text-muted-foreground">
				{content[step]}
				{targetHidden ? (
					<p className="text-[11px]">
						{message("projects:masters_guide_target_hidden")}
					</p>
				) : null}
			</div>
			<div className="flex items-center gap-1 pt-0.5">
				<Button
					variant="ghost"
					className="text-muted-foreground"
					onClick={onSkip}
				>
					{message("projects:masters_guide_skip")}
				</Button>
				<span className="flex-1" />
				{index > 0 ? (
					<Button variant="ghost" onClick={onBack}>
						{message("projects:masters_guide_back")}
					</Button>
				) : null}
				<Button ref={primaryRef} onClick={onNext}>
					{last
						? message("projects:masters_guide_done")
						: message("projects:masters_guide_next")}
				</Button>
			</div>
		</div>
	);
}
