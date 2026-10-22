import {
	AuthorizationError,
	CimdFetchError,
	type AuthRequest,
	type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";
import { appPage, consentPage, loginPage } from "./pages.js";
import { RenderInputError, renderToBucket, validateRenderInput } from "./render.js";
import {
	clearSessionCookieHeader,
	hasSession,
	sessionCookieHeader,
	sessionCookieValue,
	verifyPassword,
} from "./session.js";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 600;

function loginFailKey(request: Request): string {
	return `login-fail:${request.headers.get("cf-connecting-ip") ?? "local"}`;
}

async function loginLocked(request: Request, env: Env): Promise<boolean> {
	const attempts = Number(await env.OAUTH_KV.get(loginFailKey(request)));
	return attempts >= LOGIN_MAX_ATTEMPTS;
}

async function recordLoginFailure(request: Request, env: Env): Promise<void> {
	const key = loginFailKey(request);
	const attempts = Number(await env.OAUTH_KV.get(key)) || 0;
	await env.OAUTH_KV.put(key, String(attempts + 1), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
}

function isSecure(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

async function requireSession(request: Request, env: Env): Promise<Response | null> {
	if (await hasSession(request, env)) return null;
	return new Response(null, { status: 302, headers: { Location: "/login" } });
}

async function serveFile(env: Env, key: string): Promise<Response> {
	if (!key.startsWith("renders/") || key.includes("..")) return new Response("Not found", { status: 404 });
	const object = await env.FILES.get(key);
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
	headers.set("Cache-Control", "public, max-age=2592000, immutable");
	headers.set("ETag", object.httpEtag);
	return new Response(object.body, { headers });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (request.method === "GET") {
		if (await hasSession(request, env)) return Response.redirect(new URL(request.url).origin + "/", 302);
		return new Response(loginPage(), { headers: HTML_HEADERS });
	}
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	if (await loginLocked(request, env)) {
		return new Response(loginPage("Too many attempts. Try again later."), { status: 429, headers: HTML_HEADERS });
	}
	const form = await request.formData();
	const password = String(form.get("password") ?? "");
	if (!(await verifyPassword(password, env))) {
		await recordLoginFailure(request, env);
		return new Response(loginPage("Wrong password."), { status: 401, headers: HTML_HEADERS });
	}
	await env.OAUTH_KV.delete(loginFailKey(request));
	const headers = new Headers({ Location: "/" });
	headers.append("Set-Cookie", sessionCookieHeader(await sessionCookieValue(env), isSecure(request)));
	return new Response(null, { status: 302, headers });
}

async function handleApiRender(request: Request, env: Env): Promise<Response> {
	if (!(await hasSession(request, env))) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	let input;
	try {
		input = validateRenderInput(await request.json());
	} catch (error) {
		if (error instanceof RenderInputError) return Response.json({ error: error.message }, { status: 400 });
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		const result = await renderToBucket(env, input);
		const origin = new URL(request.url).origin;
		return Response.json({ url: `${origin}/files/${result.key}`, key: result.key, bytes: result.bytes });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Render failed" },
			{ status: 502 },
		);
	}
}

function consentView(
	details: ConsentDescription,
	handle: string,
	action: string,
	needsPassword: boolean,
	error?: string,
) {
	return {
		clientName: details.clientName,
		clientDomain: details.clientDomain,
		redirectHost: details.redirectHost,
		redirectIsLoopback: details.redirectIsLoopback,
		scopes: details.scope,
		handle,
		action,
		needsPassword,
		error,
	};
}

async function renderConsent(
	request: Request,
	env: Env,
	authRequest: AuthRequest,
	needsPassword: boolean,
	error?: string,
) {
	const oauth = env.OAUTH_PROVIDER;
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	consent.headers.set("Cache-Control", "no-store");
	const action = `/authorize${new URL(request.url).search}`;
	return new Response(consentPage(consentView(details, consent.handle, action, needsPassword, error)), {
		headers: consent.headers,
	});
}

async function authorize(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const remember = { secret: env.COOKIE_ENCRYPTION_KEY, subject: "admin" };
	try {
		if (request.method === "POST") {
			const form = await request.formData();
			const handle = String(form.get("handle") ?? "");
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}
			const authed = await hasSession(request, env);
			if (!authed) {
				if (await loginLocked(request, env)) {
					return new Response("Too many attempts. Try again later.", { status: 429 });
				}
				if (!(await verifyPassword(String(form.get("password") ?? ""), env))) {
					await recordLoginFailure(request, env);
					const authRequest = await oauth.parseAuthRequest(request);
					return renderConsent(request, env, authRequest, true, "Wrong password.");
				}
				await env.OAUTH_KV.delete(loginFailKey(request));
			}
			const approved = await oauth.approveConsent(request, handle, { remember });
			const { redirectTo } = await oauth.completeAuthorization({
				request: approved.request,
				userId: "admin",
				metadata: {},
				scope: approved.request.scope,
				props: { user: "admin" },
			});
			approved.headers.set("Location", redirectTo);
			return new Response(null, { status: 302, headers: approved.headers });
		}

		const authRequest = await oauth.parseAuthRequest(request);
		const authed = await hasSession(request, env);
		if (authed && (await oauth.isConsentRemembered(request, authRequest, remember))) {
			const { redirectTo } = await oauth.completeAuthorization({
				request: authRequest,
				userId: "admin",
				metadata: {},
				scope: authRequest.scope,
				props: { user: "admin" },
			});
			return Response.redirect(redirectTo, 302);
		}
		return renderConsent(request, env, authRequest, !authed);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) {
			return Response.redirect(error.redirectTo, 302);
		}
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
			return new Response(message, { status: 400 });
		}
		throw error;
	}
}

export const app = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (pathname === "/authorize") return authorize(request, env);
		if (pathname === "/login") return handleLogin(request, env);
		if (pathname === "/logout" && request.method === "POST") {
			const headers = new Headers({ Location: "/login" });
			headers.append("Set-Cookie", clearSessionCookieHeader(isSecure(request)));
			return new Response(null, { status: 302, headers });
		}
		if (pathname === "/") {
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			const denied = await requireSession(request, env);
			if (denied) return denied;
			return new Response(appPage(), { headers: HTML_HEADERS });
		}
		if (pathname === "/api/render" && request.method === "POST") return handleApiRender(request, env);
		if (pathname.startsWith("/files/") && request.method === "GET") {
			return serveFile(env, pathname.slice("/files/".length));
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
