# Payment Detail Field Validation

## Source of truth

Field rules come from the rail definition returned by `GET /api/v1/supported/payment-rails`. Each field has:

- `key`: the name to send inside `details`
- `label`, `placeholder`: text shown when asking for the value
- `required`
- `pattern`: a regular expression, when the rail publishes one
- `options`: allowed values for choice fields

## What the skill checks locally

`validatePaymentDetailInput(details, fields)` in `scripts/payment-catalogue.ts`:

1. trims each value
2. normalizes a few fields the way their patterns expect:
   - `iban`, `swift_code`, `ifsc_code`: spaces removed, upper-cased
   - `revtag`: leading `@` removed
3. reports a missing required field
4. reports a value that does not match the field's `pattern`

A field without a pattern is accepted as typed. A pattern the JavaScript engine cannot compile is skipped.

## What UNIGOX checks

Saving payment details (`POST /api/v1/partner/users/{user_uuid}/payment-details`) validates the fields again
for the corridor. The local check exists so the user is told about a typo at the field, not after confirmation.
The API remains the authority.

## No local rule tables

The skill keeps no per-country or per-validator rule tables. If a rail's rules change, the next catalogue read
picks them up.
