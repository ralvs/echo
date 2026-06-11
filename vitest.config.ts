import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "supabase/functions/_shared"),
			"@": path.resolve(__dirname, "."),
		},
	},
});
