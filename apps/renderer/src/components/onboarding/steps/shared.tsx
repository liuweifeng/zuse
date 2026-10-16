export function StepHeader({
	title,
	subtitle,
}: {
	title: string;
	subtitle: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<h2 className="text-xl font-semibold tracking-tight text-foreground">
				{title}
			</h2>
			<p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
				{subtitle}
			</p>
		</div>
	);
}
