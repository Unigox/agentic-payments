# Payment Detail Field Validators

For this skill, the **frontend + payment-network API are the source of truth** for both:
1. which fields to request
2. how those fields should be validated

Do not invent country-specific rules when the network config already exposes them.

## Source of Truth Flow

Use this order:

1. `getPaymentMethodsForCurrency(currency)`
2. `getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug? })`
3. `validatePaymentDetailInput(details, fields, { countryCode, formatId })`

What the helper does:
- resolves the correct format using the same frontend rules:
  - `paymentMethodFormats`
  - `paymentMethodTypeFormats`
  - single-format fallback
- validates against each field’s API-exposed `validators[]`
- falls back to frontend validator-name behavior only when the API gives a `validatorName` without a regex `pattern`

## Frontend-Aligned Validation Behavior

Validation is field-config driven.
For each field:
- if `required=true`, non-empty input is mandatory
- if `validators[]` is present, apply those validators in order
- if no validators are present, accept the non-empty value as-is

## Named Validator Fallbacks

These are only used when the API returns a validator name without an inline regex pattern.
That mirrors how the frontend adapter resolves validator names.

Currently relevant fallback names for this skill expansion:

| Validator Name | Frontend-Aligned Rule |
|---|---|
| `indiaBankAccount` | digits only, length 10-16 |
| `indiaPhone` | accepts `+91XXXXXXXXXX`, `91XXXXXXXXXX`, or `XXXXXXXXXX` |
| `ifscCode` | `^[A-Z]{4}0[A-Z0-9]{6}$` |
| `upiId` | `^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$` |
| `fullName` | `^[a-zA-ZÀ-ÿ\u0100-\u017F\u0400-\u04FF\s'-]{2,50}$` |

When the API already sends a regex pattern, that regex wins.

## What This Means for Current Currencies

### INR
- `upi-india` exposes frontend/API validators for:
  - `upi_id`
  - `full_name`
  - `mobile_number` via `indiaPhone`
- `imps-neft-india` exposes frontend/API validators for:
  - `ifsc_code`
  - `account_number` via `indiaBankAccount`
  - `full_name`

### NGN
- `nip-nigeria` exposes frontend/API validators for:
  - `phone_number` on mobile-money formats
  - `full_name`
- Bank-account `account_number` currently has **no explicit validator** in the frontend/API config, so the skill should not impose extra hardcoded length rules.

### KES
- `pesalink` exposes frontend/API validators for:
  - `phone_number` on mobile-money formats
  - `paybill` on `mpesa-paybill`
  - `full_name`
- `mpesa-paybill.account_number` currently has **no explicit validator** in the frontend/API config, so it remains free-form.

### GHS
- `ghipss` exposes frontend/API validators for:
  - `phone_number` on mobile-money formats
  - `full_name`
- Bank-account `account_number` currently has **no explicit validator** in the frontend/API config.

## Minimal Normalization

The helper performs a few safe normalizations before validation/storage:
- `revtag` → strips leading `@`
- `iban` → removes spaces, uppercases
- `swift_code` → removes spaces, uppercases
- `ifsc_code` → removes spaces, uppercases

These are convenience normalizations only; validation still follows the frontend/API-derived rules above.

## Important Gap to Call Out

The backend API does **not** always serialize the full validator implementation.
Sometimes it only sends:
- `validatorName`
- `message`

without a regex `pattern`.

In those cases, the skill uses the existing frontend validator semantics for that validator name.
That is the only place where validation is not fully API-serialized, and it stays aligned to the frontend instead of ad-hoc local guesses.
