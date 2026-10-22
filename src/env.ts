import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
	BROWSER: Fetcher;
	FILES: R2Bucket;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	ADMIN_PASSWORD: string;
	COOKIE_ENCRYPTION_KEY: string;
}
