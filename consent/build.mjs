import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const ECHO_PUBLISHABLE_KEY = requireEnv("ECHO_PUBLISHABLE_KEY");

const template = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const output = template
	.replace("__SUPABASE_URL__", SUPABASE_URL)
	.replace("__ECHO_PUBLISHABLE_KEY__", ECHO_PUBLISHABLE_KEY);

mkdirSync(new URL("./dist", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/index.html", import.meta.url), output);
