import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { verifyMessage, Wallet } from "ethers";

import {
  approveWalletConnectUriWithWallet,
  parseWalletConnectUri,
} from "./walletconnect-session.ts";
import type { SessionTypes } from "@walletconnect/types";

class FakeWalletKit extends EventEmitter {
  responses: Array<{ topic: string; response: { id: number; jsonrpc: string; result?: unknown; error?: { code: number; message: string } } }> = [];
  approvedNamespaces: SessionTypes.Namespaces | undefined;
  activeSessions: Record<string, SessionTypes.Struct> = {};
  proposalEvent: {
    id: number;
    params: {
      id: number;
      expiryTimestamp: number;
      relays: Array<{ protocol: string }>;
      proposer: { publicKey: string; metadata: { name: string; description: string; url: string; icons: string[] } };
      requiredNamespaces: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
      optionalNamespaces: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
      pairingTopic: string;
    };
    verifyContext: Record<string, unknown>;
  };
  requests: Array<{
    id: number;
    topic: string;
    params: {
      chainId: string;
      request: { method: string; params: unknown[] };
    };
    verifyContext: Record<string, unknown>;
  }>;

  constructor(
    proposalEvent: {
      id: number;
      params: {
        id: number;
        expiryTimestamp: number;
        relays: Array<{ protocol: string }>;
        proposer: { publicKey: string; metadata: { name: string; description: string; url: string; icons: string[] } };
        requiredNamespaces: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
        optionalNamespaces: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
        pairingTopic: string;
      };
      verifyContext: Record<string, unknown>;
    },
    requests: Array<{
      id: number;
      topic: string;
      params: {
        chainId: string;
        request: { method: string; params: unknown[] };
      };
      verifyContext: Record<string, unknown>;
    }> = [],
  ) {
    super();
    this.proposalEvent = proposalEvent;
    this.requests = requests;
  }

  async pair(_params: { uri: string }): Promise<void> {
    queueMicrotask(() => {
      this.emit("session_proposal", this.proposalEvent);
    });
  }

  async approveSession(params: { id: number; namespaces: SessionTypes.Namespaces }): Promise<void> {
    this.approvedNamespaces = params.namespaces;
    this.activeSessions[`session-${params.id}`] = {
      topic: `session-${params.id}`,
      pairingTopic: this.proposalEvent.params.pairingTopic,
      relay: { protocol: "irn" },
      expiry: Math.floor(Date.now() / 1000) + 3600,
      acknowledged: true,
      controller: "controller",
      namespaces: params.namespaces,
      requiredNamespaces: this.proposalEvent.params.requiredNamespaces,
      optionalNamespaces: this.proposalEvent.params.optionalNamespaces,
      self: {
        publicKey: "self",
        metadata: {
          name: "Agentic Payments",
          description: "test",
          url: "https://www.unigox.com",
          icons: [],
        },
      },
      peer: {
        publicKey: this.proposalEvent.params.proposer.publicKey,
        metadata: this.proposalEvent.params.proposer.metadata,
      },
    };
    for (const request of this.requests) {
      queueMicrotask(() => {
        this.emit("session_request", request);
      });
    }
  }

  async respondSessionRequest(params: {
    topic: string;
    response: { id: number; jsonrpc: string; result?: unknown; error?: { code: number; message: string } };
  }): Promise<void> {
    this.responses.push(params);
  }

  getActiveSessions(): Record<string, SessionTypes.Struct> {
    return this.activeSessions;
  }
}

test("parseWalletConnectUri extracts topic, version, and relay metadata", () => {
  const parsed = parseWalletConnectUri(
    "wc:266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05@2?relay-protocol=irn&symKey=6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2",
  );

  assert.equal(parsed.topic, "266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05");
  assert.equal(parsed.version, 2);
  assert.equal(parsed.relayProtocol, "irn");
  assert.equal(parsed.symKey, "6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2");
});

test("approveWalletConnectUriWithWallet approves the session and responds to account and signature requests", async () => {
  const wallet = new Wallet("0x1111111111111111111111111111111111111111111111111111111111111111");
  const message = "0x48656c6c6f20554e49474f58";
  const proposal = {
    id: 77,
    params: {
      id: 77,
      expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      relays: [{ protocol: "irn" }],
      proposer: {
        publicKey: "peer-public-key",
        metadata: {
          name: "UNIGOX",
          description: "UNIGOX",
          url: "https://www.unigox.com",
          icons: [],
        },
      },
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["eth_accounts", "personal_sign"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
      optionalNamespaces: {},
      pairingTopic: "pairing-topic",
    },
    verifyContext: {},
  };
  const requests = [
    {
      id: 1,
      topic: "session-77",
      params: {
        chainId: "eip155:1",
        request: {
          method: "eth_accounts",
          params: [],
        },
      },
      verifyContext: {},
    },
    {
      id: 2,
      topic: "session-77",
      params: {
        chainId: "eip155:1",
        request: {
          method: "personal_sign",
          params: [message, wallet.address],
        },
      },
      verifyContext: {},
    },
  ];
  const fakeWalletKit = new FakeWalletKit(proposal, requests);

  const result = await approveWalletConnectUriWithWallet({
    uri: "wc:266081884b684924211ce2e68e0808e18c6c7f82cda45dcf59837aca50979a05@2?relay-protocol=irn&symKey=6fba76027bd0bc22245b7c5223201ee3e07ac3856e02224ab0c6a4a7f498abe2",
    privateKey: wallet.privateKey,
    projectId: "test-project",
    sessionKey: "walletconnect-test",
  }, {
    walletKit: fakeWalletKit,
  });

  assert.deepEqual(result.requestedChains, ["eip155:1"]);
  assert.deepEqual(result.approvedChains, ["eip155:1"]);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.handledMethods.sort(), ["eth_accounts", "personal_sign"]);
  assert.deepEqual(fakeWalletKit.approvedNamespaces?.eip155?.accounts, [`eip155:1:${wallet.address}`]);
  assert.equal(fakeWalletKit.responses.length, 2);
  assert.deepEqual(fakeWalletKit.responses[0]?.response.result, [wallet.address]);

  const signature = String(fakeWalletKit.responses[1]?.response.result);
  assert.equal(
    verifyMessage(Buffer.from("Hello UNIGOX"), signature),
    wallet.address,
  );
});
