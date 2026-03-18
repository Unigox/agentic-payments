# EUR Payment Methods

## Method Reference

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

## Detail Field Formats

- `revtag`: Revolut username with @ prefix (e.g. `@username`)
- `iban`: International Bank Account Number (e.g. `EE382200221020145685`)
- `full_name`: Recipient's legal name as on bank account
- `bank_name`: Bank institution name (only for "Other Bank")

## Notes

- Revolut with `revtag` uses network 47 (Revolut Username)
- Revolut with `iban` uses network 3 (SEPA)
- All SEPA banks use network 3
- Wise has its own network 46
