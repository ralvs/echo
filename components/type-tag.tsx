type TypeTagProps = {
	type: string;
};

export function TypeTag({ type }: TypeTagProps) {
	const normalized = type.toLowerCase().replace(/\s+/g, "_");
	return <span className={`type-tag type-${normalized}`}>{type.replace(/_/g, " ")}</span>;
}
