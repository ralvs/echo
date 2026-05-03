type TopicPillProps = {
	topic: string;
	count?: number;
	onClick?: () => void;
	href?: string;
};

export function TopicPill({ topic, count, onClick, href }: TopicPillProps) {
	const className =
		"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-3 border border-border-subtle text-xs text-text-secondary hover:text-amber-bright hover:border-border-active transition-colors";

	if (href) {
		return (
			<a href={href} className={className}>
				<span>{topic}</span>
				{count !== undefined && (
					<span className="text-text-tertiary font-mono text-[10px]">{count}</span>
				)}
			</a>
		);
	}

	const Tag = onClick ? "button" : "span";
	return (
		<Tag
			onClick={onClick}
			className={`${className} ${onClick ? "" : "cursor-default"}`}
			{...(onClick ? { type: "button" as const } : {})}
		>
			<span>{topic}</span>
			{count !== undefined && (
				<span className="text-text-tertiary font-mono text-[10px]">{count}</span>
			)}
		</Tag>
	);
}
