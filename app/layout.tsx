import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export const metadata: Metadata = {
	title: "Echo — Personal Knowledge Dashboard",
	description: "Browse, search, and manage your thoughts.",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en">
			<body>
				<Sidebar />
				<main className="ml-[220px] min-h-screen">{children}</main>
			</body>
		</html>
	);
}
