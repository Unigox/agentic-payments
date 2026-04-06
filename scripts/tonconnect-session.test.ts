import test from "node:test";
import assert from "node:assert/strict";

import { Base64, SessionCrypto, hexToByteArray } from "@tonconnect/protocol";

import {
  approveTonConnectUniversalLinkWithWallet,
  parseTonConnectUniversalLink,
} from "./tonconnect-session.ts";

test("parseTonConnectUniversalLink extracts the dapp session, manifest, and ton_proof payload", () => {
  const link = "tc://?v=2&id=17051a42b960dd99f0a75589efb2210371230a7d274246bc48073e89e661ca5e&trace_id=019d510c-b56a-75ee-99e8-926b5aaaf916&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fwww.unigox.com%2Fapi%2Ftonconnect-manifest%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%22e72b645a2904fe70a743c8a1f2d82979cecfe66f443109b493074bf5ae9ca22f%22%7D%5D%7D&ret=none";
  const parsed = parseTonConnectUniversalLink(link);

  assert.equal(parsed.dappSessionId, "17051a42b960dd99f0a75589efb2210371230a7d274246bc48073e89e661ca5e");
  assert.equal(parsed.traceId, "019d510c-b56a-75ee-99e8-926b5aaaf916");
  assert.equal(parsed.manifestUrl, "https://www.unigox.com/api/tonconnect-manifest");
  assert.equal(parsed.tonProofPayload, "e72b645a2904fe70a743c8a1f2d82979cecfe66f443109b493074bf5ae9ca22f");
});

test("approveTonConnectUniversalLinkWithWallet sends an encrypted connect event back to the dapp bridge", async () => {
  const dappSession = new SessionCrypto();
  const tonProofPayload = "e72b645a2904fe70a743c8a1f2d82979cecfe66f443109b493074bf5ae9ca22f";
  const link = `tc://?v=2&id=${dappSession.sessionId}&trace_id=test-trace&r=${encodeURIComponent(JSON.stringify({
    manifestUrl: "https://www.unigox.com/api/tonconnect-manifest",
    items: [
      { name: "ton_addr" },
      { name: "ton_proof", payload: tonProofPayload },
    ],
  }))}&ret=none`;

  let postedUrl = "";
  let postedBody = "";

  const result = await approveTonConnectUniversalLinkWithWallet({
    universalLink: link,
    walletAddress: "0:942dcad7691db2159cd34ac9045ec697f6ce009b659eec939e7b89ef88cb090e",
    network: "-239",
    publicKey: "abcd1234",
    stateInit: "state-init-boc",
    tonProof: {
      timestamp: 1775010000,
      domain: { lengthBytes: 14, value: "www.unigox.com" },
      payload: tonProofPayload,
      signature: "c2lnbmF0dXJl",
    },
  }, {
    resolveWalletInfo: async () => ({
      bridgeUrl: "https://bridge.example/bridge",
      appName: "tonkeeper",
    }),
    fetchImpl: async (input, init) => {
      postedUrl = String(input);
      postedBody = String(init?.body || "");
      return new Response("", { status: 200 });
    },
  });

  assert.equal(result.bridgeUrl, "https://bridge.example/bridge");
  assert.equal(result.dappSessionId, dappSession.sessionId);
  assert.equal(result.manifestUrl, "https://www.unigox.com/api/tonconnect-manifest");

  const sentUrl = new URL(postedUrl);
  assert.equal(sentUrl.searchParams.get("to"), dappSession.sessionId);
  assert.equal(sentUrl.searchParams.get("topic"), "connect");
  assert.equal(sentUrl.searchParams.get("trace_id"), "test-trace");

  const walletSessionId = sentUrl.searchParams.get("client_id");
  assert.ok(walletSessionId);

  const decrypted = dappSession.decrypt(
    Base64.decode(postedBody).toUint8Array(),
    hexToByteArray(walletSessionId!),
  );
  const event = JSON.parse(decrypted);

  assert.equal(event.event, "connect");
  assert.equal(event.payload.device.appName, "tonkeeper");
  assert.equal(event.payload.items[0].name, "ton_addr");
  assert.equal(event.payload.items[0].address, "0:942dcad7691db2159cd34ac9045ec697f6ce009b659eec939e7b89ef88cb090e");
  assert.equal(event.payload.items[1].name, "ton_proof");
  assert.equal(event.payload.items[1].proof.payload, tonProofPayload);
});
