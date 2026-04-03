#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as QRCode from "qrcode";
import { PNG } from "pngjs";

import { decodeTonConnectUniversalLinkFromImagePath } from "./qr-decode.ts";

const SAMPLE_TC_LINK = "tc://?v=2&id=17051a42b960dd99f0a75589efb2210371230a7d274246bc48073e89e661ca5e&trace_id=019d510c-b56a-75ee-99e8-926b5aaaf916&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fwww.unigox.com%2Fapi%2Ftonconnect-manifest%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%22e72b645a2904fe70a743c8a1f2d82979cecfe66f443109b493074bf5ae9ca22f%22%7D%5D%7D&ret=none";

test("decodeTonConnectUniversalLinkFromImagePath extracts a tc link from a QR screenshot", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tonconnect-qr-")), "tc-link.png");
  const buffer = await QRCode.toBuffer(SAMPLE_TC_LINK, { type: "png", width: 512, margin: 1 });
  fs.writeFileSync(file, buffer);

  const decoded = await decodeTonConnectUniversalLinkFromImagePath(file);
  assert.equal(decoded, SAMPLE_TC_LINK);
});

test("decodeTonConnectUniversalLinkFromImagePath returns undefined when no TonConnect QR is present", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tonconnect-empty-")), "blank.png");
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  fs.writeFileSync(file, PNG.sync.write(png));

  const decoded = await decodeTonConnectUniversalLinkFromImagePath(file);
  assert.equal(decoded, undefined);
});
