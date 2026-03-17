type TopicPillProps = {
	topic: string;
	count?: number;
	onClick?: () => void;
};

export function TopicPill({ topic, count, onClick }: TopicPillProps) {
	const Tag = onClick ? "button" : "span";
	return (
		<Tag
			onClick={onClick}
			className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-3 border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-default transition-colors cursor-default"
			{...(onClick ? { type: "button" as const } : {})}
		>
			<span>{topic}</span>
			{count !== undefined && (
				<span className="text-text-tertiary font-mono text-[10px]">{count}</span>
			)}
		</Tag>
	);
}
