# Payment Detail Field Validators

Use these patterns to validate user input before calling the UNIGOX API.
Fields and their required formats are returned by `getNetworkFieldConfig(networkSlug)`.
This file provides the validation rules the agent should apply client-side.

## Universal Validators

| Field | Pattern / Rule | Error Message |
|-------|---------------|---------------|
| `full_name` | `^[a-zA-ZÀ-ÿ\u0100-\u017F\u0400-\u04FF\s'-]{2,50}$` | 2-50 chars, letters/spaces/hyphens/apostrophes only |
| `email` | `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$` | Standard email format |
| `iban` | `^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$` | Country code + check digits + account (uppercase, no spaces) |
| `swift_code` | `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` | 8 or 11 char SWIFT/BIC code |
| `revtag` | `^[a-zA-Z0-9_-]+$` | Revolut username (no @, letters/numbers/underscores/hyphens) |
| `account_number` | `^\d+$` | Digits only |

## Country-Specific Phone Validators

| Country | Format | Example |
|---------|--------|---------|
| International | `+` followed by 7-15 digits | +254712345678 |
| Nigeria (+234) | +234 followed by 10 digits | +2348012345678 |
| Kenya (+254) | +254 followed by 9 digits | +254712345678 |
| Uganda (+256) | +256 7XXXXXXXX | +256712345678 |
| India (+91) | +91 followed by 10 digits | +919876543210 |
| Egypt (+20) | +20 followed by 10 digits | +201234567890 |
| Kuwait (+965) | +965 followed by 8 digits | +96512345678 |
| UAE (+971) | +971 followed by 9 digits | +971501234567 |
| Philippines (+63) | 63 followed by 8-12 digits | 639171234567 |
| Kazakhstan (+7/+997) | +7 or +997, starts with 0XX/6XX/7XX | +77012345678 |
| Sierra Leone (+232) | +232 7/8 followed by 7 digits | +2327812345678 |
| Morocco (+212) | +212 6/7 followed by 8 digits | +212612345678 |
| Malaysia (+60) | +60 followed by 9-10 digits | +60123456789 |
| China (+86) | +86 followed by 11 digits | +8613812345678 |

## Country-Specific Account Validators

| Country | Field | Pattern / Rule | Example |
|---------|-------|---------------|---------|
| US | `routing_number` | Exactly 9 digits | 021000089 |
| UK | `sort_code` | Format XX-XX-XX (6 digits with dashes) | 12-34-56 |
| UK | `account_number` | Exactly 8 digits | 12345678 |
| Nigeria | `account_number` (NUBAN) | Exactly 10 digits | 0123456789 |
| Argentina | `cbu_cvu` | Exactly 22 digits | 0000000000000000000000 |
| Mexico | `clabe` | Exactly 18 digits | 012345678901234567 |
| Turkey | `iban` | TR + 24 digits (26 total) | TR330006100519786457841326 |
| India | `account_number` | 10-16 digits | 1234567890 |
| India | `ifsc_code` | 4 letters + 0 + 6 alphanumeric (11 chars) | HDFC0001234 |
| India | `upi_id` | user@bank format | user@icici |
| Philippines | `account_number` | 10, 12, or 16 digits | 1234567890 |
| Australia | `bsb` | Format XXX-XXX (6 digits with dash) | 123-456 |
| Australia | `account_number` | 1-9 digits | 12345678 |
| Vietnam | `account_number` | 12-14 digits | 123456789012 |
| Kazakhstan | `card_number` | 16-19 digits (spaces/dashes OK) | 4400 1234 5678 9012 |

## Other Validators

| Field | Pattern / Rule | Notes |
|-------|---------------|-------|
| `paypal_username` | Email OR @username (3-20 chars) | PayPal accepts both |
| `alias` (Argentina) | 6-20 chars, letters/numbers/dots | CVU/CBU alias |

## How to Use

1. Call `getNetworkFieldConfig(networkSlug)` to get required fields
2. For each field, check if it has a known validator from this list
3. Validate user input before calling `createPaymentDetail()`
4. If validation fails, show the error message and ask the user to correct
5. For fields not in this list, accept any non-empty string

## Payment Method Type to Format Mapping

When a network returns `formats` instead of top-level `fields`, pick the right format based on the payment method type:

| Method Type Slug | Format ID |
|-----------------|-----------|
| `traditional-banks` | `banks` |
| `digital-banks` | `banks` |
| `mobile-money` | `mobile-money` |
| `mobile-wallets` | `mobile-money` |

If the method type doesn't match, default to `banks`.
