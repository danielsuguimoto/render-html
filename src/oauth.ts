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

function isClientMetadataDocumentUrl(clientId: string): boolean {
	try {
		if (new URL(clientId).protocol !== "https:") return false;
	} catch {
		return false;
	}
	const afterAuthority = clientId.slice(clientId.indexOf("://") + 3);
	const boundary = afterAuthority.search(/[/?#]/);
	return boundary !== -1 && afterAuthority[boundary] === "/";
}

function basicClientId(header: string | null): string | null {
	if (!header) return null;
	const schemeEnd = header.search(/[ \t]/);
	if ((schemeEnd === -1 ? header : header.slice(0, schemeEnd)).toLowerCase() !== "basic") return null;
	try {
		const credentials = atob(header.slice(schemeEnd).trim());
		const separator = credentials.indexOf(":");
		if (separator === -1) return null;
		return decodeURIComponent(credentials.slice(0, separator).replace(/\+/g, " "));
	} catch {
		return null;
	}
}

export async function stripSharedSecretFromCimdClient(request: Request, tokenEndpointPath: string): Promise<Request> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== tokenEndpointPath) return request;
	const body = new URLSearchParams(await request.clone().text());
	const fromBasic = basicClientId(request.headers.get("authorization"));
	const stripBasic = fromBasic !== null && isClientMetadataDocumentUrl(fromBasic);
	const stripBodySecret =
		!stripBasic && body.get("client_id") !== null &&
		isClientMetadataDocumentUrl(body.get("client_id")!) && body.has("client_secret");
	if (!stripBasic && !stripBodySecret) return request;
	body.delete("client_secret");
	if (stripBasic && !body.has("client_id")) body.set("client_id", fromBasic);
	const headers = new Headers(request.headers);
	if (stripBasic) headers.delete("authorization");
	headers.set("content-length", String(body.toString().length));
	return new Request(request, { headers, body: body.toString() });
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
