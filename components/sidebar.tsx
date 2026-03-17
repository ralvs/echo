"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

const navItems = [
	{
		href: "/",
		label: "Overview",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<rect x="3" y="3" width="7" height="7" rx="1" />
				<rect x="14" y="3" width="7" height="7" rx="1" />
				<rect x="3" y="14" width="7" height="7" rx="1" />
				<rect x="14" y="14" width="7" height="7" rx="1" />
			</svg>
		),
	},
	{
		href: "/thoughts",
		label: "Thoughts",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
		),
	},
	{
		href: "/capture",
		label: "Capture",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="12" r="10" />
				<line x1="12" y1="8" x2="12" y2="16" />
				<line x1="8" y1="12" x2="16" y2="12" />
			</svg>
		),
	},
];

export function Sidebar() {
	const pathname = usePathname();

	return (
		<aside className="fixed left-0 top-0 bottom-0 w-[220px] bg-surface-1 border-r border-border-subtle flex flex-col z-50">
			<div className="p-5 pb-2">
				<Link href="/" className="flex items-center gap-2.5 group">
					<div className="relative w-8 h-8 flex items-center justify-center">
						<div className="absolute inset-0 rounded-full bg-amber-glow/20 group-hover:bg-amber-glow/30 transition-colors" />
						<div className="absolute inset-[6px] rounded-full bg-amber-glow/40" />
						<div className="absolute inset-[10px] rounded-full bg-amber-glow" />
					</div>
					<span className="font-display text-xl text-text-primary tracking-wide">
						Echo
					</span>
				</Link>
			</div>

			<nav className="flex-1 px-3 py-4 space-y-0.5" aria-label="Main navigation">
				{navItems.map((item) => {
					const isActive =
						item.href === "/"
							? pathname === "/"
							: pathname.startsWith(item.href);

					return (
						<Link
							key={item.href}
							href={item.href}
							className="relative flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] text-sm font-medium transition-colors group"
						>
							{isActive && (
								<motion.div
									layoutId="sidebar-active"
									className="absolute inset-0 bg-amber-faint rounded-[var(--radius-sm)] border border-border-active"
									transition={{ type: "spring", stiffness: 400, damping: 30 }}
								/>
							)}
							<span
								className={`relative z-10 transition-colors ${
									isActive ? "text-amber-glow" : "text-text-tertiary group-hover:text-text-secondary"
								}`}
							>
								{item.icon}
							</span>
							<span
								className={`relative z-10 transition-colors ${
									isActive ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary"
								}`}
							>
								{item.label}
							</span>
						</Link>
					);
				})}
			</nav>

			<div className="p-4 border-t border-border-subtle">
				<p className="text-[10px] font-mono text-text-tertiary tracking-wider uppercase">
					Echo v1.0
				</p>
			</div>
		</aside>
	);
}
