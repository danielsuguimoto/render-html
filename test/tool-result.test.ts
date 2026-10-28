import assert from "node:assert/strict";
import { specTypeSchemas } from "@modelcontextprotocol/server";
import { toolResult, toBase64 } from "../src/mcp.js";

const origin = "https://render-html.example.workers.dev";

function randomBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i += 65_536) {
		crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, size)));
	}
	return bytes;
}

// toBase64 round-trips arbitrary bytes, including payloads spanning chunks
for (const size of [0, 1, 0x8000, 0x8001, 100_000]) {
	const bytes = randomBytes(size);
	assert.deepEqual(new Uint8Array(Buffer.from(toBase64(bytes), "base64")), bytes, `size ${size}`);
}

// render_image: image content block carries the media bytes
const pngData = randomBytes(100_000);
pngData.set([0x89, 0x50, 0x4e, 0x47], 0); // PNG magic
const image = toolResult(origin, {
	key: "renders/abc.png",
	contentType: "image/png",
	bytes: pngData.byteLength,
	data: pngData,
}) as {
	content: [
		{ type: string; data: string; mimeType: string },
		{ type: string; text: string },
	];
};
assert.equal(image.content.length, 2);
assert.equal(image.content[0].type, "image");
assert.equal(image.content[0].mimeType, "image/png");
assert.deepEqual(
	new Uint8Array(Buffer.from(image.content[0].data, "base64")),
	pngData,
	"image block data decodes to the rendered bytes",
);
assert.match(image.content[1].text, new RegExp(`^${origin}/files/renders/abc\\.png`));
specTypeSchemas.CallToolResult.parse(image);

// render_pdf: embedded resource block carries the PDF bytes
const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]); // %PDF...
const pdf = toolResult(origin, {
	key: "renders/def.pdf",
	contentType: "application/pdf",
	bytes: pdfData.byteLength,
	data: pdfData,
}) as {
	content: [
		{ type: string; resource: { uri: string; mimeType: string; blob: string } },
		{ type: string; text: string },
	];
};
assert.equal(pdf.content[0].type, "resource");
assert.equal(pdf.content[0].resource.mimeType, "application/pdf");
assert.equal(pdf.content[0].resource.uri, `${origin}/files/renders/def.pdf`);
assert.deepEqual(new Uint8Array(Buffer.from(pdf.content[0].resource.blob, "base64")), pdfData);
specTypeSchemas.CallToolResult.parse(pdf);

console.log("all assertions passed");
