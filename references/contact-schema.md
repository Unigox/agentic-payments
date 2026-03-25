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
          "methodSlug": "revolut",
          "networkId": 47,
          "network": "Network Name",
          "networkSlug": "revolut-username",
          "selectedFormatId": "optional-format-id",
          "details": {
            "field1": "value1"
          },
          "lastValidatedAt": "2026-03-25T11:55:00.000Z"
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
  - **methodSlug**: live API slug for re-resolving the frontend/API field config later
  - **networkId**: UNIGOX payment_network_id
  - **network**: human-readable network name
  - **networkSlug**: live API slug for the exact payout network (important when one method has multiple networks)
  - **selectedFormatId**: optional resolved format ID when the network exposes multiple frontend/API formats
  - **details**: key-value pairs required by the method
  - **lastValidatedAt**: optional timestamp of the last successful frontend/API validation

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
        "methodSlug": "revolut",
        "networkId": 47,
        "network": "Revolut Username",
        "networkSlug": "revolut-username",
        "details": {
          "revtag": "svetlana"
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
