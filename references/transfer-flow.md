# Conversational Transfer Flow

This document defines the higher-level chat/orchestration flow implemented in `scripts/transfer-orchestrator.ts`.

## Flow Map

1. **Entry / intent parse**
   - Detect whether the user wants to **send money now** or **save/update a contact for later**.
   - Parse any recipient, amount, or currency hints from the first message.

2. **Auth gate (transfer only)**
   - If replayable UNIGOX auth is missing, ask exactly:
     - **EVM wallet connection**
     - **TON wallet connection**
     - fallback: **email OTP**
   - Do not continue to execution until auth/onboarding is completed.

3. **Recipient gate**
   - Ask whether this is for a **saved contact** or a **new recipient** when not already obvious.
   - Resolve saved contacts from `contacts.json` by key / name / alias.
   - If not found, switch to new-recipient capture.

4. **Currency gate**
   - Confirm or collect the fiat payout currency.
   - If the user changes currency mid-flow, clear the payment-method selection and re-collect currency-dependent details.

5. **Payment-method gate**
   - Fetch live methods from `getPaymentMethodsForCurrency(currency)`.
   - Match the user's chosen method against the live API list.
   - If the method exposes multiple payout networks (for example Revolut SEPA vs Revolut Username), ask for the exact network.

6. **Field-collection gate**
   - Resolve the authoritative field schema with `getPaymentMethodFieldConfig({ currency, methodId/methodSlug, networkId/networkSlug })`.
   - Collect fields one by one.
   - Validate each field with `validatePaymentDetailInput()`.
   - Normalize values before storing (for example `@revtag` → `revtag`).
   - Optional fields can be skipped.

7. **Saved-contact revalidation**
   - If an existing contact already has payout details for the selected currency, re-validate them against the current API/frontend field schema.
   - If the saved data is stale or incomplete, ask the user to update it field by field.

8. **Contact persistence gate**
   - New recipient → ask whether to save the contact.
   - Existing stale contact → ask whether to update the saved details.
   - Save-only flow exits here after confirmation.

9. **Amount gate**
   - Collect the amount if missing.
   - If the user changes amount later, keep the recipient/method details but require re-confirmation.

10. **Confirmation gate**
    - Summarize recipient, currency, payment method/network, and normalized details.
    - Require explicit confirmation before any money movement.

11. **Execution gate**
    - `getWalletBalance()`
    - `ensurePaymentDetail()`
    - `createTradeRequest()`
    - `waitForTradeMatch()`
    - optionally `getTradeRequest()` / `getTrade()` for status follow-up

12. **Status / resolution gate**
    - If matched, report trade request ID + trade ID / status.
    - If pending timeout, keep the flow open for later status checks.
    - If no vendor match, offer retry / amount change / method change / currency change.

## Happy Path Summary

`intent -> recipient -> currency -> method -> network? -> details -> save/update? -> amount -> confirm -> balance check -> payment detail ensure -> trade request -> vendor match`

## Main Unhappy Paths

### Missing auth
- Block execution and ask for wallet sign-in path before continuing.

### Invalid field
- Re-prompt on the exact field that failed validation.

### Existing contact with stale details
- Re-validate saved details against the current API field config.
- Re-collect only what needs fixing.

### Insufficient balance
- Stop before `ensurePaymentDetail()` / `createTradeRequest()`.
- Ask the user to fund the wallet or change the amount.

### No vendor match / matching timeout reached
- Keep the contact data intact.
- Offer retry or switching method / currency / amount.

### Wait-for-match timeout
- Mark the trade request as pending and support later `status` checks.

### Save contact only
- Stop after successful contact save/update. Do not execute the transfer.

### Change currency or method mid-flow
- Clear dependent state (selected network, collected fields, confirmation state).
- Re-run the live API selection and validation path.
