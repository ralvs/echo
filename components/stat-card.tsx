"use client";

import { motion } from "motion/react";

type StatCardProps = {
	label: string;
	value: string | number;
	subtitle?: string;
	delay?: number;
};

export function StatCard({ label, value, subtitle, delay = 0 }: StatCardProps) {
	return (
		<motion.div
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.5, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
			className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-5 hover:border-border-default transition-colors"
		>
			<p className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase mb-3">
				{label}
			</p>
			<p className="font-display text-3xl text-text-primary">{value}</p>
			{subtitle && (
				<p className="text-xs text-text-secondary mt-1.5">{subtitle}</p>
			)}
		</motion.div>
	);
}
