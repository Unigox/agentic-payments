# Payment Methods Reference

UNIGOX payment methods are now **API-driven**.
Do not hardcode IDs for non-EUR flows when the public payment-method endpoints already expose them.

Use:
- `getPaymentMethodsForCurrency(currency)` for live methods + network IDs
- `getPaymentMethodFieldConfig({ currency, methodSlug, networkSlug? })` for the exact required fields
- `validatePaymentDetailInput(details, fields, { countryCode, formatId })` for frontend-aligned validation before `createPaymentDetail()`

Important:
- field selection should follow the frontend/API config, not local country guesses
- validation should come from each field’s API `validators[]`
- if the API gives only a `validatorName` without a regex, use the existing frontend validator behavior for that validator name

## EUR (stable reference)

EUR methods are few and relatively stable, so keeping a quick lookup here is still useful.

| Method | methodId | networkId | Network Name | Required Fields |
|--------|----------|-----------|--------------|-----------------|
| Revolut | 2 | 47 | Revolut Username | `revtag` |
| Revolut (IBAN) | 2 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| Wise | 1 | 46 | Wise Network | `iban`, `full_name` |
| N26 | 123 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| LHV Bank | 119 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| Coop Pank | 121 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| Abanca | 377 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| ActivoBank | 364 | 3 | European Transfer (SEPA) | `iban`, `full_name` |
| Other Bank | 519 | 3 | European Transfer (SEPA) | `iban`, `full_name`, `bank_name` |

## INR (India)

Live currency query currently exposes:

| Method | Method Slug | Type | Network | Network Slug | Required Fields |
|--------|-------------|------|---------|--------------|-----------------|
| UPI Payment | `upi-payment` | `mobile-wallets` | UPI India | `upi-india` | `upi_id`, `full_name`, optional `mobile_number`, optional `bank_or_wallet_name` |
| IMPS or NEFT Transfer | `imps-or-neft-transfer` | `traditional-banks` | IMPS or NEFT India | `imps-neft-india` | `bank_name`, `ifsc_code`, `account_number`, `full_name` |

Notes:
- IMPS support is **dynamic**, exposed by the `imps-or-neft-transfer` method on network `imps-neft-india`
- The field config comes from the payment-network API, not a hardcoded local list

## NGN (Nigeria)

Nigeria is heavily API-driven. The live method list currently includes hundreds of institutions on network `nip-nigeria`.

Common examples from the live API:

| Method | Method Slug | Type | Network | Network Slug | Required Fields |
|--------|-------------|------|---------|--------------|-----------------|
| Access Bank | `access-bank` | `traditional-banks` | NIP Nigeria (NIBSS Instant Payments) | `nip-nigeria` | `account_number`, optional `full_name` |
| Kuda Bank | `kuda-bank` | `digital-banks` | NIP Nigeria (NIBSS Instant Payments) | `nip-nigeria` | `account_number`, optional `full_name` |
| Moniepoint | `moniepoint` | `digital-banks` | NIP Nigeria (NIBSS Instant Payments) | `nip-nigeria` | `account_number`, optional `full_name` |
| Palmpay | `palmpay` | `digital-banks` | NIP Nigeria (NIBSS Instant Payments) | `nip-nigeria` | `account_number`, optional `full_name` |

Notes:
- The set of Nigerian banks / digital banks should be fetched live via `getPaymentMethodsForCurrency("NGN")`
- The network config also exposes a `mobile-money` format, but the live currency method list should decide which methods are actually usable
- For bank `account_number`, the current frontend/API config does not expose an explicit validator, so the skill should not add one on its own

## KES (Kenya)

Kenya currently resolves through network `pesalink`.

| Method | Method Slug | Type | Network | Network Slug | Required Fields |
|--------|-------------|------|---------|--------------|-----------------|
| M-PESA | `m-pesa` | `mobile-money` | Pesalink | `pesalink` | `phone_number`, optional `full_name` |
| Airtel Money | `airtel-money` | `mobile-money` | Pesalink | `pesalink` | `phone_number`, optional `full_name` |
| M-PESA Paybill | `mpesa-paybill` | `mobile-wallets` | Pesalink | `pesalink` | `paybill`, `account_number`, optional `full_name` |
| KCB (Kenya Commercial Bank) | `kenya-commercial-bank` | `traditional-banks` | Pesalink | `pesalink` | `account_number`, optional `full_name` |
| M-Shwari | `m-shwari` | `digital-banks` | Pesalink | `pesalink` | `account_number`, optional `full_name` |

Notes:
- `pesalink` exposes multiple formats; do **not** assume the first format is correct
- `mpesa-paybill` must resolve to the method-specific `mpesa-paybill` format via the frontend/API `paymentMethodFormats` mapping rather than the generic `mobile-money` fields
- `mpesa-paybill.account_number` is currently free-form because the frontend/API config does not attach a validator to it

## GHS (Ghana)

Ghana currently resolves through network `ghipss`.

| Method | Method Slug | Type | Network | Network Slug | Required Fields |
|--------|-------------|------|---------|--------------|-----------------|
| MTN Mobile Money (MoMo) | `momo` | `mobile-wallets` | GHIPSS | `ghipss` | `phone_number`, optional `full_name` |
| Vodafone Cash | `Vodafone-cash` | `mobile-money` | GHIPSS | `ghipss` | `phone_number`, optional `full_name` |
| Telecel Cash | `telecel-cash` | `mobile-money` | GHIPSS | `ghipss` | `phone_number`, optional `full_name` |
| Ecobank Ghana | `ecobank-ghana` | `traditional-banks` | GHIPSS | `ghipss` | `account_number`, optional `full_name` |
| Zeepay Ghana | `zeepay-ghana` | `digital-banks` | GHIPSS | `ghipss` | `account_number`, optional `full_name` |

Notes:
- Ghana mobile-money validation comes from the frontend/API validator config on `ghipss`
- Bank and digital-bank methods remain API-driven via the live currency endpoint
- For bank `account_number`, the current frontend/API config does not expose an explicit validator

## Detail Field Formats

- `revtag`: Revolut username with `@` in user-facing examples, but normalize to the raw username when validating / storing
- `iban`: International Bank Account Number (e.g. `EE382200221020145685`)
- `full_name`: Recipient's legal name as on bank or payment account
- `bank_name`: Bank institution name
- `upi_id`: India UPI ID in `user@bank` format
- `ifsc_code`: India bank IFSC code
- `account_number`: Bank account or reference number (country-specific validation may apply)
- `phone_number`: E.164-style phone number for mobile-money flows
- `mobile_number`: India UPI-linked phone number (optional)
- `paybill`: Kenya M-PESA Paybill number
