# Onboarding: First Run Setup

## When to Trigger

On a send request, the runner checks for the four Partner API settings. If any is missing it replies with the
names of the missing ones and stops. Relay that reply and walk the user through the steps below.

Saving a contact does not need settings.

## Step 1: Explain

Tell the user, in plain words:

- this skill sends money through UNIGOX and pays from their UNIGOX partner wallet
- it needs a Partner API key and the partner wallet key, kept in a local settings file
- **keys are never typed into the chat**
- nothing is sent without an explicit confirmation

## Step 2: Partner account

If the user has no UNIGOX partner account, point them to business onboarding at
[unigox.com/business](https://unigox.com/business). After approval they receive the API key.

## Step 3: Settings

The user adds four values to the skill's `.env` file (or, on Claude Desktop, the extension settings):

- `UNIGOX_API_KEY`
- `UNIGOX_WALLET_PRIVATE_KEY`
- `UNIGOX_XAI_RPC_URL`
- `UNIGOX_SENDER_EMAIL`

`docs/authentication.md` explains each one. `.env.example` is a template.

Do not offer to write the keys into the file for them from chat. They edit the file themselves.

## Step 4: Funding

The partner wallet must hold USDC or USDT before a transfer can be placed. Funding happens on unigox.com:
sign in with the partner account, open **My Wallet**, and either send USDC or USDT on XAI to the wallet
address or use **Add Money** to deposit from another chain.

The skill shows the balance at the start of a send flow and before confirmation.

## Step 5: KYC

UNIGOX requires the sender to be verified before every transfer. On the first send the runner asks for the
full legal name and the country, then returns a verification link. After UNIGOX approves, the user says so and
the flow continues. Relay the runner's KYC replies closely.

## Step 6: Add contacts

Offer to save recipients so later sends only need a name and an amount:

- "add mom as a contact"
- "save John for EUR on Revolut"

## Returning Sessions

When settings are present the runner starts directly with the sender and the wallet balance. Do not repeat
onboarding.

## Security Reminders

- Never ask for, repeat, or store a key in chat, in `contacts.json`, or in any tracked file.
- The wallet key controls the whole partner wallet balance. Recommend a partner account that holds only what
  the agent may spend.
- If the user pastes something that looks like a key, tell them to delete the message and replace the key.
