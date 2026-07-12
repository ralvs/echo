import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "Echo — Personal Knowledge Dashboard",
	description: "Browse, search, and manage your thoughts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
