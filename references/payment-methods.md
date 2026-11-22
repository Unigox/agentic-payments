# Payment Methods Reference

Payout methods are **read live from the public UNIGOX Partner API**. Nothing in this file is hardcoded in the code.

## Where they come from

| What | Endpoint | Notes |
|------|----------|-------|
| Rails for a currency | `GET /api/v1/supported/payment-rails?currency=EUR&direction=offramp` | Each rail lists its fields, or several formats each with their own fields |
| Institutions on a rail | `GET /api/v1/supported/institutions?rail=iban-sepa&currency=EUR` | At most 100 per page; `search` matches name or slug |
| Currencies with payouts | `GET /api/v1/supported/corridors` | Shows licensed and P2P availability per currency |

All three are public and need no API key.

## How the skill uses them

`scripts/payment-catalogue.ts`:

- `getPaymentMethodsForCurrency(currency, searchTerms)` lists institutions and the rails each can be paid over.
  A rail larger than one page is searched with the words the user typed instead of being paged.
- `getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug })` returns the fields to collect.
- `validatePaymentDetailInput(details, fields)` checks required fields and the rail's patterns.

Terms: the skill's "method" is the API's **institution** (`institution_id`), and its "network" is the API's **rail**.

## Rules the catalogue applies

- A rail with no fields is not offered: there is nothing to save as its details.
- A rail with several formats applies the format whose `institution_types` contains the institution's type.
- A format marked `has_liquidity: false` is not offered.
- The pseudo-field `institution_id` that some rails list is not collected: the institution is the method itself.

## Examples seen on the live API (2026-11-22)

These are illustrations, not a specification. Query the endpoints for the current state.

| Currency | Rail | Institution example | Fields |
|----------|------|---------------------|--------|
| EUR | `iban-sepa` | Revolut and about 3,600 other institutions | `full_name`, `iban` |
| EUR | `revolut-username` | Revolut | `revtag` |
| GBP | `faster-payments` | UK banks | `full_name`, `sort_code`, `account_number` |
| NGN | `nip-nigeria` | Kuda Bank and about 750 other institutions | banks: `account_number`, optional `full_name`; mobile money: `phone_number` |
| KES | `pesalink` | M-PESA, KCB | mobile money: `phone_number`; banks: `account_number` |
| INR | `imps-neft-india` | Indian banks | `bank_name`, `ifsc_code`, `account_number`, `full_name` |
| INR | `upi-india` | UPI | `upi_id`, `full_name` |
| GHS | `ghipss` | mobile money wallets and banks | mobile money: `phone_number`; banks: `account_number` |

## Provider preference

`settings.json` holds `tradePartner`: `licensed` (default), `p2p` or `all`. It is sent to the API as
`provider_scope` (`licensed_only`, `p2p_only`, `all`). Some currencies are served only by P2P providers and
appear only when the setting allows them.
