# Contact Schema

## Structure

```json
{
  "contacts": {
    "<key>": {
      "name": "Full Legal Name",
      "aliases": ["nickname1", "nickname2", "relation"],
      "paymentMethods": {
        "<CURRENCY>": {
          "method": "Method Name",
          "methodId": 2,
          "networkId": 47,
          "network": "Network Name",
          "details": {
            "field1": "value1"
          }
        }
      },
      "notes": "Optional notes"
    }
  },
  "_meta": {
    "lastUpdated": "2026-03-18"
  }
}
```

## Fields

- **key**: short identifier, lowercase (e.g. "mom", "john", "artur")
- **name**: full legal name as it appears on their bank/payment account
- **aliases**: all names the user might call this person (including relationship terms)
- **paymentMethods**: one entry per currency, each with:
  - **method**: human-readable method name
  - **methodId**: UNIGOX payment_method_id
  - **networkId**: UNIGOX payment_network_id
  - **network**: human-readable network name
  - **details**: key-value pairs required by the method

## Example

```json
{
  "mom": {
    "name": "Svetlana Example",
    "aliases": ["mom", "mother", "mama", "mum", "svetlana"],
    "paymentMethods": {
      "EUR": {
        "method": "Revolut",
        "methodId": 2,
        "networkId": 47,
        "network": "Revolut Username",
        "details": {
          "revtag": "@svetlana"
        }
      }
    }
  }
}
```

## Alias Resolution

Matching is case-insensitive. Checked in order:
1. Exact key match
2. Exact name match
3. Any alias match

First match wins. Aliases should include:
- Relationship terms ("mom", "dad", "wife")
- First name
- Nicknames
- Any term the user naturally uses
