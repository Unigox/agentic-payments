import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveTonWalletCandidates,
  parseTonPrivateKeyInput,
  resolveTonWalletCandidate,
} from "./unigox-client.ts";

const VALID_TON_PRIVATE_KEY = "4444444444444444444444444444444444444444444444444444444444444444";

test("TON wallet candidate resolver matches the supplied address across supported wallet versions", () => {
  const parsed = parseTonPrivateKeyInput(VALID_TON_PRIVATE_KEY);
  assert.ok(parsed);

  const candidates = deriveTonWalletCandidates(parsed.publicKey, 0);
  assert.ok(candidates.length >= 5);

  const v5Candidate = candidates.find((candidate) => candidate.version === "v5r1");
  assert.ok(v5Candidate);

  const resolved = resolveTonWalletCandidate({
    publicKey: parsed.publicKey,
    workchain: 0,
    address: v5Candidate.address,
  });

  assert.equal(resolved.matched?.version, "v5r1");
  assert.equal(resolved.matched?.address, v5Candidate.address);
  assert.match(resolved.matched?.stateInit || "", /^[A-Za-z0-9+/=]+$/);
});

test("TON wallet candidate resolver prefers the stored wallet version when no address override is present", () => {
  const parsed = parseTonPrivateKeyInput(VALID_TON_PRIVATE_KEY);
  assert.ok(parsed);

  const resolved = resolveTonWalletCandidate({
    publicKey: parsed.publicKey,
    workchain: 0,
    preferredVersion: "v3r2",
  });

  assert.equal(resolved.matched?.version, "v3r2");
  assert.ok(resolved.matched?.address.startsWith("0:"));
});
