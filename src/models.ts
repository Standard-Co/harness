// Image input: which models accept images, which images we pass, and how a
// file becomes pi-ai `ImageContent`. Shared by the kernel's `ipython` tool
// (images a cell emits) and the CLI (images attached to the user's prompt).

import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";

/** The image formats every vision provider we target accepts. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Largest base64 payload passed per image (5 MB, the strictest common provider limit). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** Images passed from one cell; extras are dropped with a diagnostic. */
export const MAX_IMAGES_PER_CELL = 4;

export interface ModelLookup {
	getModel(provider: string, modelId: string): { readonly input: readonly string[] } | undefined;
}

/** True when the catalog knows the model and lists "image" among its inputs. */
export function modelAcceptsImages(models: ModelLookup, ref: { provider: string; modelId: string } | undefined): boolean {
	if (ref === undefined) return false;
	return models.getModel(ref.provider, ref.modelId)?.input.includes("image") ?? false;
}

export function isImageMimeType(mime: string): mime is ImageMimeType {
	return (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/** The image format from magic bytes, or undefined when the bytes are not a supported image. */
export function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
	const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImageCheck = { ok: true; image: ImageContent } | { ok: false; reason: string };

/**
 * Validate one base64 image payload: strips a `data:` URL prefix and whitespace, enforces the size cap, and takes the
 * MIME type from the bytes so a mislabeled image cannot make the provider reject the whole request.
 */
export function checkBase64Image(payload: unknown, declaredMime: string): ImageCheck {
	if (typeof payload !== "string") return { ok: false, reason: `${declaredMime} payload is not a base64 string` };
	const data = payload.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
	if (data.length === 0) return { ok: false, reason: `${declaredMime} payload is empty` };
	if (data.length > MAX_IMAGE_BASE64_BYTES) {
		return { ok: false, reason: `image is ${formatBytes(data.length)} base64, over the ${formatBytes(MAX_IMAGE_BASE64_BYTES)} limit; downscale or crop it first` };
	}
	if (data.length % 4 === 1 || !BASE64.test(data)) return { ok: false, reason: `${declaredMime} payload is not valid base64` };
	const mime = sniffImageMime(Buffer.from(data.slice(0, 64), "base64"));
	if (mime === undefined) return { ok: false, reason: `${declaredMime} payload is not a PNG, JPEG, GIF, or WebP image` };
	return { ok: true, image: { type: "image", data, mimeType: mime } };
}

/** Read an image file as `ImageContent`. Throws with a message fit for a CLI user. */
export async function readImageFile(path: string): Promise<ImageContent> {
	const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
		throw new Error(`cannot read image ${path}: ${error.code ?? error.message}`);
	});
	const mime = sniffImageMime(bytes);
	if (mime === undefined) throw new Error(`${path} is not a PNG, JPEG, GIF, or WebP image`);
	const checked = checkBase64Image(bytes.toString("base64"), mime);
	if (!checked.ok) throw new Error(`${path}: ${checked.reason}`);
	return checked.image;
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
