# Integration: Code Structure

## Modules

| File | Owns |
|------|------|
| `scripts/transfer-orchestrator.ts` | The conversation: stages, prompts, what to ask next |
| `scripts/settlement-monitor.ts` | Turning a trade's status into a chat phase and prompt |
| `scripts/transfer-execution.ts` | The port: what the flow needs from a payments backend, and its typed failures |
| `scripts/partner-execution-client.ts` | The port implemented on Partner API orders |
| `scripts/partner-api-client.ts` | Partner API requests, the `X-API-Key` header, local signing, balance read |
| `scripts/payment-catalogue.ts` | Payout methods and field rules from the public catalogue, field validation |
| `scripts/partner-api-config.ts` | Reading settings from the environment and `.env` files |
| `scripts/contact-store.ts` | Local contacts |
| `scripts/run-transfer-turn.ts` | One chat turn from the command line, with session persistence |
| `scripts/send-money-mcp.ts`, `send-money-tool.ts` | MCP tools and the tool definition |

Dependencies point one way: orchestrator, then port, then Partner API client. The Partner API client knows
nothing about the conversation.

## Using the client directly

```ts
import { PartnerApiClient } from "./partner-api-client.ts";
import { loadPartnerApiConfigFromEnv } from "./partner-api-config.ts";

const { config, missingSettings } = loadPartnerApiConfigFromEnv();
if (!config) throw new Error(`Missing settings: ${missingSettings.join(", ")}`);

const api = new PartnerApiClient(config);
await api.verifyApiKey();
const sender = await api.ensureSender();          // registers the sender once, then reuses it
const balance = await api.getWalletBalance();     // USDC and USDT on XAI, whole units
```

## A payout, step by step

```ts
const saved = await api.createPaymentDetails({
  currency: "EUR",
  rail: "revolut-username",
  institutionId: "revolut",
  details: { revtag: "john" },
});

const quote = await api.quoteOfframp({
  paymentDetailsId: saved.paymentDetailsId,
  cryptoCurrency: "USDC",
  fiatCurrency: "EUR",
  fiatAmount: "50",
  providerScope: "licensed_only",
});

const order = await api.initiateOfframp(quote.quoteId);

// poll api.getOrder(order.orderId) until nextAction === "authorize_crypto_transfer"
await api.authorizeCryptoTransfer(order.orderId);  // signs locally, UNIGOX relays

// later, when the order allows it and the recipient confirmed:
await api.confirmFiatReceived(order.orderId);
```

The orchestrator does not call these directly. It calls the port (`createTradeRequest`, `waitForTradeMatch`,
`fundTradeEscrow`, `getTrade`, `confirmFiatReceived`, `authorizeRefund`), and `PartnerExecutionClient`
translates.

## Failures

`PartnerApiClient` throws `PartnerApiError` with the API's machine `code` (for example `NO_OFFERS_AVAILABLE`,
`KYC_NOT_CLEARED`, `INSUFFICIENT_BALANCE`). `PartnerExecutionClient` turns the ones the flow handles into
`TransferExecutionError` with a `reason`:

| `reason` | Raised when | What the flow does |
|----------|-------------|--------------------|
| `kyc_required` | The sender is not cleared | Runs the KYC steps |
| `no_match` | No provider serves the transfer, or only a next-day offer does | Says nothing was sent, offers retry or changes |
| `match_timeout` | No provider accepted within the wait | Keeps the order, offers status |
| `price_changed` | The price moved between quote and order | Says nothing was sent, offers retry |
| `insufficient_balance` | The wallet cannot cover the order at funding | Asks to fund the wallet |

API error messages are engineering detail. They are logged in the session's `lastError` and never shown to the
user; the orchestrator owns the wording.

## Signing

Two signatures are produced locally with the partner wallet key, both over data built by UNIGOX:

- **Escrow funding**: EIP-712 `ForwardRequest`, domain `SyntheticAssetForwarder` version `1`, as in the official
  SDK ([Unigox/sdk_javascript](https://github.com/Unigox/sdk_javascript)).
- **Refund**: EIP-712 `SafeTx` with the domain and types returned by `refund-authorization-parameters`.

Before signing, the client checks that the address UNIGOX expects is the address of the configured key.

## Important limitations

- One installation sends for one sender.
- Next-day (T+1) settlement, disputes and source-of-funds cases are not operated by the flow. Such orders move
  to manual follow-up.
- Webhooks are not used. The flow polls the order, which the Partner API supports.
- The flow uses the saved-payment-details route for every recipient. The Partner API's separate recipient
  route is not used.
