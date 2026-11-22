# Conversational Transfer Flow

This document maps the chat flow implemented in `scripts/transfer-orchestrator.ts`.
The flow talks to UNIGOX only through the port in `scripts/transfer-execution.ts`, which
`scripts/partner-execution-client.ts` implements on the public Partner API.

## Flow Map

1. **Entry / intent parse**
   - Detect whether the user wants to **send money now** or **save or update a contact for later**.
   - Parse any recipient, amount, or currency hints from the first message.

2. **Setup gate (transfer only)**
   - Check that the four Partner API settings are present (see `docs/authentication.md`).
   - If any are missing, reply with their names and stop. The stage is `awaiting_setup`.
   - Keys are never requested or accepted in chat.
   - Once settings exist, the next turn continues and shows the sender and the wallet balance.

3. **Recipient gate**
   - Ask whether this is for a **saved contact** or a **new recipient** when not already obvious.
   - Resolve saved contacts from `contacts.json`, then from payout details saved under the sender on UNIGOX.

4. **Currency gate**
   - Confirm or collect the payout currency.
   - If the user changes currency mid-flow, clear the payment-method selection and re-collect.

5. **Payment-method gate**
   - Read live methods from the catalogue (`scripts/payment-catalogue.ts`): rails from
     `/api/v1/supported/payment-rails`, institutions from `/api/v1/supported/institutions`.
   - Ask for the bank or provider first.
   - If it can be paid over several rails (for example Revolut by SEPA or by username), ask for the rail next.

6. **Field-collection gate**
   - Resolve the fields for that institution on that rail. A rail with several formats applies the format
     that matches the institution's type.
   - Collect fields one by one and validate each against the pattern the rail publishes.
   - Optional fields can be skipped.

7. **Saved-contact revalidation**
   - Saved details are re-validated against the current field rules. Stale or incomplete details are
     re-collected field by field.

8. **Contact persistence gate**
   - New recipient: ask whether to save the contact.
   - Save-only flow exits here after confirmation.

9. **Amount gate**
   - Collect the amount if missing. A changed amount requires re-confirmation.

10. **Balance preflight gate**
    - Read the partner wallet's USDC and USDT.
    - Save the payout details under the sender.
    - Price the transfer per asset and pick the asset that covers it alone.
    - If no single asset covers it, stop and do **not** place an order. The stage is `awaiting_balance_resolution`.

11. **KYC gate**
    - The sender must be verified before every transfer.
    - If not verified: ask for the full legal name, then the country, then return the verification link.
      Stages: `awaiting_kyc_full_name`, `awaiting_kyc_country`, `awaiting_kyc_completion`.

12. **Confirmation gate**
    - Summarize sender, balance, estimate, recipient, method and details.
    - Require explicit confirmation before any money movement.

13. **Execution gate**
    - Take a live quote and place the order, unless the quote costs more crypto than the confirmed estimate.
      In that case nothing is placed and the user is asked to confirm the new price
      (`awaiting_new_price_confirmation`).
    - Wait for a provider to accept the order.
    - If the order asks for more personal details (for example address fields for EUR and GBP payouts),
      collect and submit them (`awaiting_partner_payment_details_input`).
    - Fund the order's escrow by signing locally with the partner wallet key.

14. **Settlement monitoring gate**
    - Poll the order and translate its status into chat stages: waiting for payout, awaiting receipt
      confirmation, release started, completed, ended without payout, or manual follow-up.

15. **Receipt confirmation gate**
    - Asked only when the provider does not confirm delivery itself.
    - `received` confirms and releases the escrow. `not received` keeps the escrow locked and moves to
      manual follow-up. Anything else also keeps it locked.

16. **Refund**
    - If a funded order stops without a payout, the refund back to the partner wallet is signed
      automatically. The destination is fixed by UNIGOX and cannot be changed by the skill.

## Happy Path Summary

`intent -> setup check -> recipient -> currency -> method -> rail? -> details -> save? -> amount -> balance preflight -> KYC check -> confirm -> quote -> order -> provider accepts -> escrow funded -> payout -> receipt confirmed (when needed) -> completed`

## Main Unhappy Paths

### Missing settings
- Reply with the missing setting names. Do not ask for keys in chat.

### Sender not verified
- Run the KYC steps, return the verification link, and continue once UNIGOX approves.

### Invalid field
- Re-prompt on the exact field that failed validation.

### Insufficient balance
- Show the wallet balance, the estimate and the shortfall.
- Stop before placing an order.
- Tell the user to add USDC or USDT in My Wallet on unigox.com, then recheck. The user can also change the amount.
- The balance of one asset must cover the transfer on its own; USDC and USDT are not combined.

### Live price higher than confirmed
- Place nothing. Show the new price and ask to confirm or cancel.

### No provider
- Tell the user nothing was sent. Offer retry, or a different amount, method or currency.

### Provider accepted, wallet short at funding
- Nothing leaves the wallet. Ask the user to fund it and then ask for status; the skill funds the escrow then.

### Recipient says fiat was not received
- Do not confirm. Keep the escrow locked and move to manual follow-up.

### Unknown order state
- Disputes, next-day (T+1) orders and any status the flow does not know go to manual follow-up. Nothing is
  released or signed automatically except the refund described above.

### Change currency or method mid-flow
- Clear dependent state (rail, collected fields, confirmation) and re-run selection and validation.
