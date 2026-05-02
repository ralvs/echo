"use client";

import { useState } from "react";
import type { Thought } from "@/lib/types";

type CaptureResult = Pick<Thought, "id" | "metadata" | "category" | "due_at" | "priority">;

export function useCapture() {
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<CaptureResult | null>(null);

	async function capture(content: string): Promise<CaptureResult | null> {
		if (!content.trim() || saving) return null;
		setSaving(true);
		setResult(null);
		try {
			const res = await fetch("/api/thoughts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			});
			const data = await res.json();
			if (res.ok) {
				setResult(data);
				return data;
			}
			return null;
		} finally {
			setSaving(false);
		}
	}

	function clearResult() {
		setResult(null);
	}

	return { saving, result, capture, clearResult };
}
