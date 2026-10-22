import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./env.js";

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export type RenderFormat = ImageFormat | "pdf";

export interface RenderInput {
	html?: string;
	url?: string;
	format: RenderFormat;
	width: number;
	height: number;
	fullPage?: boolean;
}

export interface RenderResult {
	key: string;
	contentType: string;
	bytes: number;
}

export class RenderInputError extends Error {}

const MAX_HTML_BYTES = 2_000_000;
const MIN_VIEWPORT = 16;
const MAX_VIEWPORT = 4000;
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];

function ipv4ToInt(host: string): number | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

function isPrivateHost(hostname: string): boolean {
	let host = hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
	if (host.includes(":")) {
		if (host === "::1" || host === "::") return true;
		if (host.startsWith("::ffff:")) {
			const rest = host.slice(7);
			const hextets = rest.includes(":") ? rest.split(":").map((h) => Number.parseInt(h, 16)) : null;
			if (hextets?.length === 2 && hextets.every(Number.isInteger)) {
				host = `${hextets[0] >> 8}.${hextets[0] & 255}.${hextets[1] >> 8}.${hextets[1] & 255}`;
			} else {
				host = rest;
			}
		} else {
			const firstHextet = Number.parseInt(host.split(":", 1)[0], 16);
			if (
				(firstHextet & 0xfe00) === 0xfc00 ||
				(firstHextet & 0xffc0) === 0xfe80 ||
				(firstHextet & 0xff00) === 0xff00
			) {
				return true;
			}
			return false;
		}
	}
	const ipv4 = ipv4ToInt(host);
	if (ipv4 === null) return false;
	const firstOctet = ipv4 >>> 24;
	return (
		firstOctet === 0 ||
		firstOctet === 10 ||
		firstOctet === 127 ||
		firstOctet >= 224 ||
		ipv4 >>> 20 === 0xac1 ||
		ipv4 >>> 16 === 0xc0a8 ||
		ipv4 >>> 16 === 0xa9fe ||
		ipv4 >>> 22 === 0x191
	);
}

export function validateRenderInput(raw: unknown): RenderInput {
	if (typeof raw !== "object" || raw === null) throw new RenderInputError("Body must be a JSON object");
	const body = raw as Record<string, unknown>;

	const html = body.html === undefined ? undefined : String(body.html);
	const url = body.url === undefined ? undefined : String(body.url);
	if ((html === undefined) === (url === undefined)) {
		throw new RenderInputError("Provide exactly one of `html` or `url`");
	}
	if (html !== undefined && new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
		throw new RenderInputError("`html` exceeds the 2 MB limit");
	}
	if (url !== undefined) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new RenderInputError("`url` is not a valid URL");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new RenderInputError("`url` must use http or https");
		}
		if (isPrivateHost(parsed.hostname)) {
			throw new RenderInputError("`url` host is not allowed");
		}
	}

	const format = (body.format ?? "png") as RenderFormat;
	if (format !== "pdf" && !IMAGE_FORMATS.includes(format)) {
		throw new RenderInputError("`format` must be one of png, jpeg, webp, pdf");
	}

	const width = Number(body.width ?? 1280);
	const height = Number(body.height ?? 800);
	for (const [name, value] of [["width", width], ["height", height]] as const) {
		if (!Number.isInteger(value) || value < MIN_VIEWPORT || value > MAX_VIEWPORT) {
			throw new RenderInputError(`\`${name}\` must be an integer between ${MIN_VIEWPORT} and ${MAX_VIEWPORT}`);
		}
	}

	const fullPage = body.fullPage === true;
	if (fullPage && format === "pdf") throw new RenderInputError("`fullPage` only applies to image formats");

	return { html, url, format, width, height, fullPage };
}

export async function renderToBucket(env: Env, input: RenderInput): Promise<RenderResult> {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: input.width, height: input.height });
		const nav = { waitUntil: "networkidle2" as const, timeout: 45_000 };
		if (input.url) await page.goto(input.url, nav);
		else await page.setContent(input.html!, nav);

		let data: Uint8Array;
		let ext: string;
		let contentType: string;
		if (input.format === "pdf") {
			data = new Uint8Array(
				await page.pdf({
					printBackground: true,
					width: `${input.width}px`,
					height: `${input.height}px`,
				}),
			);
			ext = "pdf";
			contentType = "application/pdf";
		} else {
			data = new Uint8Array(await page.screenshot({ type: input.format, fullPage: input.fullPage }));
			ext = input.format === "jpeg" ? "jpg" : input.format;
			contentType = `image/${input.format}`;
		}

		const key = `renders/${crypto.randomUUID()}.${ext}`;
		await env.FILES.put(key, data, { httpMetadata: { contentType } });
		return { key, contentType, bytes: data.byteLength };
	} finally {
		await browser.close();
	}
}
