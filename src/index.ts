import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { app } from "./app.js";
import type { Env } from "./env.js";
import { mcpApiHandler } from "./mcp.js";
import { onOAuthError, REFRESH_TOKEN_TTL_SECONDS } from "./oauth.js";

export function oauthOptions(origin: string): OAuthProviderOptions<Env> {
	return {
		apiRoute: "/mcp",
		apiHandler: mcpApiHandler,
		defaultHandler: app,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		scopesSupported: ["render"],
		requiredScopes: ["render"],
		refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
		refreshTokenIdleTTL: REFRESH_TOKEN_TTL_SECONDS,
		clientIdMetadataDocumentEnabled: true,
		onError: onOAuthError,
		resourceMetadata: {
			resource: `${origin}/mcp`,
			authorization_servers: [origin],
			resource_name: "render-html",
		},
	};
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const origin = new URL(request.url).origin;
		return new OAuthProvider<Env>(oauthOptions(origin)).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
