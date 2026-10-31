import assert from "node:assert/strict";
import { getOAuthApi, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import worker, { oauthOptions } from "../src/index.js";
import type { Env } from "../src/env.js";
import { REFRESH_TOKEN_TTL_SECONDS } from "../src/oauth.js";

const ORIGIN = "https://render-html.example.com";
const CLIENT_ID = "https://client.example.com/oauth.json";
const REDIRECT_URI = "https://client.example.com/callback";
const VERIFIER = "v".repeat(64);
const DAY = 86400;

// Model KV expiration against the test clock; exercise the real provider in workerd.
class MemoryKV {
	entries = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
	async get(key: string, options?: string | { type?: string }) {
		const record = this.entries.get(key);
		if (!record || (record.expiration !== undefined && record.expiration <= Date.now() / 1000)) {
			this.entries.delete(key);
			return null;
		}
		return (typeof options === "string" ? options : options?.type) === "json"
			? JSON.parse(record.value)
			: record.value;
	}
	async put(key: string, value: string, options?: KVNamespacePutOptions) {
		const expiration = options?.expiration ??
			(options?.expirationTtl === undefined ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
		if (expiration !== undefined) assert.ok(expiration >= Date.now() / 1000 + 60, "KV minimum TTL");
		this.entries.set(key, { value, expiration, metadata: options?.metadata });
	}
	async delete(key: string) {
		this.entries.delete(key);
	}
	async list({ prefix = "" } = {}) {
		const keys = [];
		for (const [name, record] of this.entries) {
			if (name.startsWith(prefix) && await this.get(name) !== null) {
				keys.push({ name, expiration: record.expiration, metadata: record.metadata });
			}
		}
		return { keys, list_complete: true, cacheStatus: null };
	}
}

function environment(): Env {
	return {
		OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
		ADMIN_PASSWORD: "local-test-password",
		COOKIE_ENCRYPTION_KEY: "a".repeat(64),
	} as Env;
}

function tokenRequest(body: Record<string, string>, authorization?: string): Request {
	return new Request(`${ORIGIN}/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...(authorization ? { Authorization: authorization } : {}),
		},
		body: new URLSearchParams(body),
	});
}

async function authorizeUrl(clientId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `${ORIGIN}/authorize?${new URLSearchParams({
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: "render",
		state: "test-state",
		resource: `${ORIGIN}/mcp`,
		code_challenge: challenge,
		code_challenge_method: "S256",
	})}`;
}

async function codeFor(env: Env, clientId: string, options = oauthOptions(ORIGIN)): Promise<string> {
	const api = getOAuthApi(options, env);
	const request = await api.parseAuthRequest(new Request(await authorizeUrl(clientId)));
	const { redirectTo } = await api.completeAuthorization({
		request, userId: "admin", metadata: {}, scope: request.scope, props: { user: "admin" },
	});
	return new URL(redirectTo).searchParams.get("code")!;
}

function codeBody(clientId: string, code: string) {
	return { grant_type: "authorization_code", client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: REDIRECT_URI };
}

function refreshBody(clientId: string, refreshToken: string) {
	return { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken };
}

function toolsRequest(accessToken: string): Request {
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

async function register(env: Env, ctx: ExecutionContext, method?: string) {
	const response = await worker.fetch(new Request(`${ORIGIN}/oauth/register`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: "test", redirect_uris: [REDIRECT_URI],
			...(method ? { token_endpoint_auth_method: method } : {}),
		}),
	}), env, ctx);
	assert.equal(response.status, 201);
	return response.json() as Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method: string }>;
}

export default {
	async fetch(_request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
		const realFetch = globalThis.fetch;
		const realNow = Date.now;
		const realWarn = console.warn;
		let now = realNow();
		let metadataState: number | "network" | "invalid" = 200;
		const logs: unknown[][] = [];
		const passed: string[] = [];
		Date.now = () => now;
		console.warn = (...args: unknown[]) => { logs.push(args); };
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			assert.equal(url, CLIENT_ID, "No real upstream calls are allowed in this test");
			if (metadataState === "network") throw new TypeError("Network connection lost.");
			if (metadataState === "invalid") return Response.json({ client_id: "wrong" });
			return Response.json({ client_id: CLIENT_ID, client_name: "CIMD test", redirect_uris: [REDIRECT_URI],
				token_endpoint_auth_method: "none" },
				{ status: metadataState, headers: { "Cache-Control": "no-store" } });
		}) as typeof fetch;
		try {
			// Before the fix a metadata outage is reported as permanently invalid credentials.
			const env = environment();
			const options = oauthOptions(ORIGIN);
			const legacyOptions: OAuthProviderOptions<Env> = { ...options, onError: () => {}, refreshTokenIdleTTL: undefined };
			const code = await codeFor(env, CLIENT_ID);
			let response = await worker.fetch(tokenRequest(codeBody(CLIENT_ID, code)), env, ctx);
			assert.equal(response.status, 200);
			const initial = await response.json() as { access_token: string; refresh_token: string };
			const request = () => tokenRequest(refreshBody(CLIENT_ID, initial.refresh_token));
			const before = JSON.stringify([...((env.OAUTH_KV as unknown) as MemoryKV).entries]);
			metadataState = 503;
			response = await new OAuthProvider(legacyOptions).fetch(request(), env, ctx);
			assert.equal(response.status, 401);
			assert.equal((await response.json() as { error: string }).error, "invalid_client");
			passed.push("reproduce original invalid_client on CIMD outage with the real provider");

			for (const state of [503, 429, "network", "invalid", 404] as const) {
				metadataState = state;
				response = await worker.fetch(request(), env, ctx);
				assert.equal(response.status, 503);
				assert.equal(response.headers.get("Retry-After"), "30");
				assert.equal(response.headers.get("Cache-Control"), "no-store");
				assert.equal((await response.json() as { error: string }).error, "temporarily_unavailable");
				assert.equal(JSON.stringify([...((env.OAUTH_KV as unknown) as MemoryKV).entries]), before);
			}
			response = await worker.fetch(new Request(await authorizeUrl(CLIENT_ID)), env, ctx);
			assert.equal(response.status, 503, "authorize must not misreport a metadata outage as a bad request");
			metadataState = 200;
			response = await worker.fetch(request(), env, ctx);
			assert.equal(response.status, 200, "the same refresh token works after metadata recovers");
			passed.push("CIMD failures fail closed without mutating grants; retry succeeds after recovery");

			const start = now;
			for (const migrate of [false, true]) {
				now = start;
				const lifetimeEnv = environment();
				const lifetimeClient = await register(lifetimeEnv, ctx, "none");
				const lifetimeCode = await codeFor(lifetimeEnv, lifetimeClient.client_id, legacyOptions);
				response = await new OAuthProvider(legacyOptions).fetch(tokenRequest(codeBody(lifetimeClient.client_id, lifetimeCode)), lifetimeEnv, ctx);
				assert.equal(response.status, 200);
				let lifetimeToken = (await response.json() as { refresh_token: string }).refresh_token;
				const provider = new OAuthProvider(migrate ? options : legacyOptions);
				now += 20 * DAY * 1000;
				response = await provider.fetch(tokenRequest(refreshBody(lifetimeClient.client_id, lifetimeToken)), lifetimeEnv, ctx);
				assert.equal(response.status, 200);
				lifetimeToken = (await response.json() as { refresh_token: string }).refresh_token;
				now += 11 * DAY * 1000;
				response = await provider.fetch(tokenRequest(refreshBody(lifetimeClient.client_id, lifetimeToken)), lifetimeEnv, ctx);
				assert.equal(response.status, migrate ? 200 : 400);
				if (!migrate) assert.equal((await response.json() as { error: string }).error, "invalid_grant");
			}
			now = start;
			passed.push("reproduce absolute 30-day expiry; existing live grants adopt rolling expiry on refresh");

			// Exercise password + consent + PKCE over the production HTTP handlers.
			const publicEnv = environment();
			const client = await register(publicEnv, ctx, "none");
			assert.equal(client.client_secret, undefined);
			const consentUrl = await authorizeUrl(client.client_id);
			response = await worker.fetch(new Request(consentUrl), publicEnv, ctx);
			assert.equal(response.status, 200);
			const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
			const html = await response.text();
			const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
			assert.ok(handle);
			response = await worker.fetch(new Request(consentUrl, {
				method: "POST", headers: { Cookie: cookies, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ handle, decision: "approve", password: publicEnv.ADMIN_PASSWORD }),
			}), publicEnv, ctx);
			assert.equal(response.status, 302);
			const approvedCode = new URL(response.headers.get("Location")!).searchParams.get("code")!;
			response = await worker.fetch(tokenRequest({ ...codeBody(client.client_id, approvedCode), code_verifier: "wrong" }), publicEnv, ctx);
			assert.equal(response.status, 400);
			response = await worker.fetch(tokenRequest(codeBody(client.client_id, approvedCode)), publicEnv, ctx);
			assert.equal(response.status, 200);
			const publicTokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
			assert.equal(publicTokens.expires_in, 3600);
			const tokenSummary = await getOAuthApi(oauthOptions(ORIGIN), publicEnv).unwrapToken(publicTokens.access_token);
			assert.ok(tokenSummary, "token is stored and decryptable");
			assert.equal(tokenSummary.audience, `${ORIGIN}/mcp`);
			response = await worker.fetch(toolsRequest(publicTokens.access_token), publicEnv, ctx);
			assert.equal(response.status, 200, "fresh token authenticates to the real MCP handler");
			const tools = await response.text();
			assert.ok(tools.includes('"render_image"') && tools.includes('"render_pdf"'));
			passed.push("DCR public client: real password consent and PKCE");

			const firstRefresh = publicTokens.refresh_token;
			response = await worker.fetch(tokenRequest(refreshBody(client.client_id, firstRefresh)), publicEnv, ctx);
			assert.equal(response.status, 200);
			response = await worker.fetch(tokenRequest(refreshBody(client.client_id, firstRefresh)), publicEnv, ctx);
			assert.equal(response.status, 200, "retry after a lost refresh response remains valid");
			let refreshToken = (await response.json() as { refresh_token: string }).refresh_token;
			response = await worker.fetch(tokenRequest(refreshBody(client.client_id, refreshToken)), publicEnv, ctx);
			assert.equal(response.status, 200);
			refreshToken = (await response.json() as { refresh_token: string }).refresh_token;
			response = await worker.fetch(tokenRequest(refreshBody(client.client_id, firstRefresh)), publicEnv, ctx);
			assert.equal(response.status, 400, "old refresh is rejected after its replacement is used");
			passed.push("refresh rotation preserves lost-response recovery and rejects obsolete tokens");

			// Active grants survive both the original 30-day grant and 90-day DCR lifetime.
			for (let i = 0; i < 5; i++) {
				now += 29 * DAY * 1000;
				response = await worker.fetch(tokenRequest(refreshBody(client.client_id, refreshToken)), publicEnv, ctx);
				assert.equal(response.status, 200, `active refresh at day ${(i + 1) * 29}`);
				const next = await response.json() as { refresh_token: string; expires_in: number };
				assert.equal(next.expires_in, 3600);
				refreshToken = next.refresh_token;
			}
			response = await worker.fetch(toolsRequest(publicTokens.access_token), publicEnv, ctx);
			assert.equal(response.status, 401, "access tokens still expire after one hour");
			passed.push("active refresh survives 145 days and DCR renewal; access tokens stay short-lived");
			now += (REFRESH_TOKEN_TTL_SECONDS + 1) * 1000;
			response = await worker.fetch(tokenRequest(refreshBody(client.client_id, refreshToken)), publicEnv, ctx);
			assert.equal(response.status, 400);
			assert.equal((await response.json() as { error: string }).error, "invalid_grant");
			passed.push("30 days of inactivity expires the grant instead of making tokens immortal");

			const replayEnv = environment();
			const replayClient = await register(replayEnv, ctx, "none");
			const replayCode = await codeFor(replayEnv, replayClient.client_id);
			response = await worker.fetch(tokenRequest(codeBody(replayClient.client_id, replayCode)), replayEnv, ctx);
			assert.equal(response.status, 200);
			const replayTokens = await response.json() as { refresh_token: string };
			response = await worker.fetch(tokenRequest(codeBody(replayClient.client_id, replayCode)), replayEnv, ctx);
			assert.equal(response.status, 400, "authorization code is single use");
			response = await worker.fetch(tokenRequest(refreshBody(replayClient.client_id, replayTokens.refresh_token)), replayEnv, ctx);
			assert.equal(response.status, 400, "replaying an authorization code revokes its grant");
			passed.push("authorization code replay is rejected and revokes the compromised grant");

			// Confidential clients must keep authenticating; do not downgrade them to public.
			const confidentialEnv = environment();
			const confidential = await register(confidentialEnv, ctx);
			assert.equal(confidential.token_endpoint_auth_method, "client_secret_basic");
			assert.ok(confidential.client_secret);
			const confidentialCode = await codeFor(confidentialEnv, confidential.client_id);
			const basic = `Basic ${btoa(`${confidential.client_id}:${confidential.client_secret}`)}`;
			const { client_id: _clientId, ...exchange } = codeBody(confidential.client_id, confidentialCode);
			response = await worker.fetch(tokenRequest(exchange, basic), confidentialEnv, ctx);
			assert.equal(response.status, 200);
			const confidentialTokens = await response.json() as { refresh_token: string };
			for (const secret of [undefined, "incorrect"]) {
				response = await worker.fetch(tokenRequest({ ...refreshBody(confidential.client_id, confidentialTokens.refresh_token),
					...(secret ? { client_secret: secret } : {}),
				}), confidentialEnv, ctx);
				assert.equal(response.status, 401);
				assert.equal((await response.json() as { error: string }).error, "invalid_client");
			}
			response = await worker.fetch(tokenRequest({ ...refreshBody(confidential.client_id, confidentialTokens.refresh_token),
				client_secret: confidential.client_secret }), confidentialEnv, ctx);
			assert.equal(response.status, 200, "default registration retains basic/post compatibility");
			const confidentialRefresh = (await response.json() as { refresh_token: string }).refresh_token;
			response = await worker.fetch(tokenRequest({ token: confidentialRefresh }, basic), confidentialEnv, ctx);
			assert.equal(response.status, 200);
			response = await worker.fetch(tokenRequest({ grant_type: "refresh_token", refresh_token: confidentialRefresh }, basic), confidentialEnv, ctx);
			assert.equal(response.status, 400);
			passed.push("confidential Basic/post authentication stays strict and revocation still works");

			const strictClient = await register(confidentialEnv, ctx, "client_secret_basic");
			const strictCode = await codeFor(confidentialEnv, strictClient.client_id);
			response = await worker.fetch(tokenRequest({ ...codeBody(strictClient.client_id, strictCode),
				client_secret: strictClient.client_secret! }), confidentialEnv, ctx);
			assert.equal(response.status, 401, "explicit Basic registration must not accept post authentication");
			const { client_id: _strictClientId, ...strictExchange } = codeBody(strictClient.client_id, strictCode);
			response = await worker.fetch(tokenRequest(strictExchange,
				`Basic ${btoa(`${strictClient.client_id}:${strictClient.client_secret}`)}`), confidentialEnv, ctx);
			assert.equal(response.status, 200);
			response = await worker.fetch(tokenRequest(refreshBody("unknown-client", "invalid-refresh")), confidentialEnv, ctx);
			assert.equal(response.status, 401);
			assert.equal((await response.json() as { error: string }).error, "invalid_client");
			passed.push("explicit auth methods and unknown-client rejection are not relaxed");

			const serializedLogs = JSON.stringify(logs.filter(args => args[0] === "oauth_error"));
			assert.ok(serializedLogs.includes("metadata_resolution_failed"));
			assert.ok(serializedLogs.includes("token_endpoint_auth_method_mismatch"));
			for (const secret of [initial.refresh_token, initial.access_token, confidential.client_secret, publicEnv.ADMIN_PASSWORD]) {
				assert.ok(!serializedLogs.includes(secret), "diagnostic logs must not expose credentials");
			}
			passed.push("structured OAuth diagnostics distinguish failure reasons without credentials");
			return Response.json({ passed });
		} catch (error) {
			return Response.json({ passed, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }, { status: 500 });
		} finally {
			globalThis.fetch = realFetch;
			Date.now = realNow;
			console.warn = realWarn;
		}
	},
};
