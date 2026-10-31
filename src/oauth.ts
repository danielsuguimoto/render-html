import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

export function clientMetadataUnavailable(): Response {
	console.warn("oauth_error", {
		code: "temporarily_unavailable",
		status: 503,
		category: "client-id-metadata-document",
		reason: "metadata_resolution_failed",
	});
	return Response.json(
		{
			error: "temporarily_unavailable",
			error_description: "Client metadata could not be verified. Retry later with the same credentials.",
		},
		{
			status: 503,
			headers: { "Cache-Control": "no-store", Pragma: "no-cache", "Retry-After": "30" },
		},
	);
}

type OAuthFailure = Parameters<NonNullable<OAuthProviderOptions<Env>["onError"]>>[0];

export function onOAuthError({ code, status, internal }: OAuthFailure): Response | void {
	// A failed CIMD lookup is not proof of invalid credentials. Never discard a grant for it.
	const metadataUnavailable = code === "invalid_client" &&
		internal.category === "client-id-metadata-document" && internal.reason === "metadata_resolution_failed";
	if (metadataUnavailable) return clientMetadataUnavailable();
	console.warn("oauth_error", {
		code,
		status,
		category: internal.category,
		reason: internal.reason,
	});
}
