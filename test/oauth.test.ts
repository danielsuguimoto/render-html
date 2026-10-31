import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev("test/oauth.test-worker.ts", {
	config: "test/wrangler.jsonc",
	local: true,
	persist: false,
	logLevel: "error",
	experimental: { disableExperimentalWarning: true, watch: false },
});

try {
	const response = await worker.fetch();
	const result = await response.json() as { passed: string[]; error?: string };
	assert.equal(response.status, 200, JSON.stringify(result));
	for (const name of result.passed) console.log(`PASS ${name}`);
} finally {
	await worker.stop();
}
