#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs/promises";

import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function isPngImage(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).toString("hex") === PNG_SIGNATURE;
}

function isJpegImage(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function toClampedArray(data: Uint8Array | Buffer): Uint8ClampedArray {
  return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
}

function extractMatchingLink(text: string | undefined, pattern: RegExp): string | undefined {
  const value = (text || "").trim();
  if (!value) return undefined;
  const match = value.match(pattern);
  return match?.[0];
}

function extractTonConnectLink(text: string | undefined): string | undefined {
  return extractMatchingLink(text, /tc:\/\/\?[^\s]+/i);
}

function extractWalletConnectLink(text: string | undefined): string | undefined {
  return extractMatchingLink(text, /wc:[^\s]+/i);
}

function decodeQrPixels(buffer: Buffer): { data: Uint8ClampedArray; width: number; height: number } {
  if (isPngImage(buffer)) {
    const decoded = PNG.sync.read(buffer);
    return {
      data: toClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    };
  }

  if (isJpegImage(buffer)) {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    if (!decoded?.data || !decoded.width || !decoded.height) {
      throw new Error("I could not decode that JPEG screenshot.");
    }
    return {
      data: toClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    };
  }

  throw new Error("I can only read PNG or JPEG screenshots for these browser-login QR flows right now.");
}

async function decodeQrTextFromImagePath(imagePath: string): Promise<string | undefined> {
  const normalizedPath = imagePath.trim();
  if (!normalizedPath) {
    throw new Error("I need a local image path for the QR screenshot.");
  }

  let file: Buffer;
  try {
    file = await fs.readFile(normalizedPath);
  } catch {
    throw new Error(`I couldn't open that screenshot path (${normalizedPath}).`);
  }

  const { data, width, height } = decodeQrPixels(file);
  const decoded = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return decoded?.data;
}

export async function decodeTonConnectUniversalLinkFromImagePath(imagePath: string): Promise<string | undefined> {
  return extractTonConnectLink(await decodeQrTextFromImagePath(imagePath));
}

export async function decodeWalletConnectUriFromImagePath(imagePath: string): Promise<string | undefined> {
  return extractWalletConnectLink(await decodeQrTextFromImagePath(imagePath));
}
