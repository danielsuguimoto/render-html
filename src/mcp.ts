import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env.js";
import { IMAGE_FORMATS, renderToBucket, validateRenderInput, type RenderResult } from "./render.js";

const SOURCE = {
	html: z.string().max(2_000_000).optional().describe("HTML markup to render. Provide exactly one of `html` or `url`."),
	url: z.string().url().optional().describe("Public http(s) URL to capture. Provide exactly one of `html` or `url`."),
};
const VIEWPORT = {
	width: z.number().int().min(16).max(4000).default(1280).describe("Capture viewport width in CSS pixels."),
	height: z.number().int().min(16).max(4000).default(800).describe("Capture viewport height in CSS pixels."),
};

export function toBase64(data: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < data.length; i += chunk) {
		binary += String.fromCharCode(...data.subarray(i, i + chunk));
	}
	return btoa(binary);
}

// Inline media doubles the render's memory footprint (raw bytes + ~1.33x base64).
// Cap it so a large render can't exhaust the Worker's 128 MB limit.
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export function toolResult(origin: string, result: RenderResult) {
	const url = `${origin}/files/${result.key}`;
	const text = `${url} (${result.bytes} bytes, expires in 30 days)`;
	if (result.bytes > MAX_INLINE_BYTES) {
		return { content: [{ type: "text" as const, text: `${text} — too large to return inline` }] };
	}
	const base64 = toBase64(result.data);
	const media =
		result.contentType === "application/pdf"
			? {
					type: "resource" as const,
					resource: { uri: url, mimeType: result.contentType, blob: base64 },
				}
			: { type: "image" as const, data: base64, mimeType: result.contentType };
	return {
		content: [
			media,
			{
				type: "text" as const,
				text,
			},
		],
	};
}

function toolError(error: unknown) {
	return {
		isError: true as const,
		content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
	};
}

function buildServer(env: Env, origin: string): McpServer {
	const server = new McpServer({ name: "render-html", version: "0.1.0" });

	server.registerTool(
		"render_image",
		{
			description:
				"Render HTML markup or a public URL to an image (PNG, JPEG, or WebP) using a headless browser. Returns the image inline as base64 image content plus a URL to the generated file, kept for 30 days.",
			inputSchema: z.object({
				...SOURCE,
				...VIEWPORT,
				format: z.enum(IMAGE_FORMATS).default("png").describe("Image format."),
				fullPage: z
					.boolean()
					.default(false)
					.describe("Capture the full scrollable page instead of only the viewport."),
			}),
		},
		async (args) => {
			try {
				const input = validateRenderInput({ ...args, format: args.format });
				return toolResult(origin, await renderToBucket(env, input));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"render_pdf",
		{
			description:
				"Render HTML markup or a public URL to a PDF using a headless browser. Returns the PDF inline as base64 resource content plus a URL to the generated file, kept for 30 days.",
			inputSchema: z.object({
				...SOURCE,
				...VIEWPORT,
			}),
		},
		async (args) => {
			try {
				const input = validateRenderInput({ ...args, format: "pdf" });
				return toolResult(origin, await renderToBucket(env, input));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	return server;
}

export const mcpApiHandler = {
	fetch(request: Request, env: Env): Promise<Response> {
		const origin = new URL(request.url).origin;
		const handler = createMcpHandler(() => buildServer(env, origin), {
			onerror: (error) => console.error("mcp:", error),
		});
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Env>;
