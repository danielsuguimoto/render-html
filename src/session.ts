import type { Env } from "./env.js";

const COOKIE_NAME = "rh_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function b64(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function sign(payload: string, secret: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
	return b64(signature);
}

export async function sessionCookieValue(env: Env): Promise<string> {
	const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const signature = await sign(`admin.${expires}`, env.COOKIE_ENCRYPTION_KEY);
	return `${expires}.${signature}`;
}

export async function hasSession(request: Request, env: Env): Promise<boolean> {
	const raw = request.headers.get("Cookie") ?? "";
	const match = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
	if (!match) return false;
	const [expiresRaw, signature] = match[1].split(".");
	const expires = Number(expiresRaw);
	if (!Number.isInteger(expires) || expires < Date.now() / 1000 || !signature) return false;
	const expected = await sign(`admin.${expires}`, env.COOKIE_ENCRYPTION_KEY);
	if (expected.length !== signature.length) return false;
	return crypto.subtle.timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(signature));
}

export function sessionCookieHeader(value: string, secure: boolean): string {
	return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
	return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function verifyPassword(candidate: string, env: Env): Promise<boolean> {
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return crypto.subtle.timingSafeEqual(await digest(candidate), await digest(env.ADMIN_PASSWORD));
}
