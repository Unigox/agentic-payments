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
  - **methodId**: numeric institution id reported by the catalogue; informational, `0` when unknown
  - **methodSlug**: institution slug (`institution_id` on the Partner API); this is what the skill matches on
  - **networkId**: numeric rail id reported by the catalogue; informational, `0` when unknown
  - **network**: human-readable network name
  - **networkSlug**: rail slug on the Partner API (important when one institution can be paid over several rails)
  - **selectedFormatId**: optional rail format id when the rail has several formats
  - **details**: key-value pairs required by the method
  - **lastValidatedAt**: optional timestamp of the last successful validation against the live field rules

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
