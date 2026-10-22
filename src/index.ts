import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app.js";
import type { Env } from "./env.js";
import { mcpApiHandler } from "./mcp.js";

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const origin = new URL(request.url).origin;
		return new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler,
			defaultHandler: app,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			clientRegistrationEndpoint: "/oauth/register",
			scopesSupported: ["render"],
			requiredScopes: ["render"],
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				resource_name: "render-html",
			},
		}).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
