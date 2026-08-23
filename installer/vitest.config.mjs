// Plain node-environment vitest config for the installer's unit tests. Deliberately NOT the
// workers pool (defineWorkersConfig) that the root vitest.config.ts uses — the installer never
// runs inside a Worker, it's a Node CLI, so it needs Node's real fs/child_process/crypto.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
	root: repoRoot,
	test: {
		include: ["test/installer.test.ts"],
		environment: "node",
	},
});
