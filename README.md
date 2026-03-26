# Agentic Payments

Agents can browse. Agents can code. Now they can pay.

Turn any OpenClaw agent into a payment terminal. Send money across borders with a single sentence.

```
> send €50 to john on revolut
```

## What Agentic Payments unlocks

**💸 Cross-border transfers**
Send fiat to 17+ countries. Revolut, Wise, SEPA, UPI / IMPS, NIP Nigeria, M-PESA, GHIPSS, and local bank transfers.

**🗣️ Natural language**
No forms, no dashboards. Tell your agent who to pay and how much.

**📇 Saved contacts**
Add recipients once. Pay them instantly every time after.

**🔐 Confirm before send**
Your agent never moves money without your explicit approval.

### Supported Currencies

EUR, GBP, USD, AUD, NGN, KES, GHS, INR, ZAR, UGX, ARS, ETB, RWF, XAF, KWD, EGP, SAR

More coming soon.

## How It Works

### 1. Sign up on UNIGOX
Create an account at [unigox.com](https://www.unigox.com) using an **EVM wallet, TON wallet, or your agent's email**, not your personal email. This account belongs to the agent.

Don't have a web3 wallet? Create one for free using [MetaMask](https://metamask.io/) or [Phantom](https://phantom.app/).

You can customize your username in the settings.

### 2. Request access
Send an email to **hello@unigox.com** requesting access to Agentic Payments. Include your UNIGOX username so we can enable your account.

### 3. Configure authentication
When the skill needs to sign in on UNIGOX, the first auth question should be:

> Which wallet connection path should I use to sign in on UNIGOX: **EVM wallet connection** or **TON wallet connection**?

Those are the two replayable wallet sign-in paths. Email remains useful, but as an onboarding / recovery fallback rather than the main wording for repeatable sign-in.

- **EVM login key** — the private key for the wallet you already use to sign in on UNIGOX. Do not ask for it until the user confirms they have already signed in on unigox.com with that wallet.
- **UNIGOX-exported EVM signing key** — a separate internal wallet key exported from unigox.com settings. This is the key the skill needs for signed actions like receipt confirmation / escrow release, escrow withdrawals, and bridge-outs. Save it as `UNIGOX_EVM_SIGNING_PRIVATE_KEY` (`UNIGOX_PRIVATE_KEY` still works as a legacy alias).
- **Before requesting either EVM key, show a hard warning**: 🚨 use a **NEWLY CREATED / ISOLATED wallet only** for UNIGOX / agent use, and **never** the user's main wallet.
- **After a user pastes either EVM key, the safest flow is required**: try to delete the key-containing message if the runtime/channel supports it; otherwise stop and tell the user to delete that message themselves before continuing.
- **TON wallet auth** — uses your TON wallet to get the UNIGOX JWT via the frontend TON routes. Good if you want TON-based login.
- **Agent email** — useful for onboarding and recovery when neither wallet path is ready yet. You can later link either an EVM wallet or a TON wallet.

⚠️ **Security:**
- Do not hold large amounts in this wallet. Treat it as a spending wallet, not a vault. Load only what you need for upcoming transfers.
- Use a newly created / isolated wallet for UNIGOX agent setup and key sharing. Do **not** use your main wallet.
- Secure your login key, signing key, or TON mnemonic. If someone gains access to them, they can authenticate or sign as the agent.
- TON auth only covers login / JWT acquisition. Advanced EVM-signed actions still require the exported EVM signing key.
- The skill can verify login with the first EVM key, but it does not currently auto-export the second key from UNIGOX. That export still has to happen manually on unigox.com.
- We are building more secure key management options for agents. For now, standard precautions apply.

### 4. Install the skill
Add Agentic Payments to your OpenClaw agent.

### 5. Initialize the agent
On first run, the skill walks you through setup by first asking which wallet connection path it should use for UNIGOX sign-in — **EVM** or **TON**. If you choose **EVM**, the onboarding sequence is now: first confirm you have already signed in on unigox.com with that wallet, then show the isolated-wallet warning, then ask which login wallet key you used and verify login with it, surface your current UNIGOX username, and only after that ask for the separate UNIGOX-exported signing key needed for signed actions inside UNIGOX. After the user pastes either EVM key, the flow tries to delete that message if the runtime supports it; otherwise it pauses and asks the user to delete the message themselves before continuing. If neither wallet path is ready yet, it can temporarily fall back to email OTP for onboarding or recovery, then optionally link the wallet path you chose. After that it helps with payment methods and your first contacts. On later runs, the flow now checks stored auth first; if the saved login/signing credentials are already usable, it skips the auth-path questions, surfaces the current UNIGOX username and wallet balance immediately, and continues with the transfer. More details in the setup guide.

### 6. Fund your wallet
Two options:

- **Already have crypto?** Send USDC or USDT to your UNIGOX wallet. The agent should do this conversationally: first ask which token you want to deposit, then show the frontend-supported networks for that token, and only after you choose the network show the single matching deposit address. Those options come from the same frontend `bridge-cryptocurrencies` data the wallet UI uses, filtered by `enabled_for_deposit`, main user-facing assets, XAI exclusion, and supported address families (EVM, Solana, Tron, TON). Example of the current split: USDC supports EVM chains plus Solana, while USDT supports a different set that includes Tron and TON but not every USDC chain.
- **No crypto?** Use the skill to top up your wallet from your bank account. On-ramp is currently available in EUR, NGN, and KES, with more currencies coming soon.

### 7. Send money

```
> send €200 to john on revolut
```

Your agent resolves the recipient, walks method selection step by step, checks the balance early, and only then asks for final confirmation. Recipient gets paid only after you confirm.

The orchestration layer also handles the real chat edges: saved vs new recipients, live payment-method/network selection, provider-first then network-specific detail collection, field-by-field validation, stale contact updates, save-contact-only mode, insufficient balance before trade creation, and no-vendor-match follow-up. See `references/transfer-flow.md`.

## Why UNIGOX?

UNIGOX is a Canadian-regulated money service business built from the ground up to be agent-friendly.

- **Non-custodial** - your wallet, your keys, your funds
- **API-first** - designed for programmatic access, not just humans clicking buttons
- **P2P + Licensed providers** - your agent gets the best rate from both sides automatically
- **17+ currencies** - Africa, Europe, Asia, Americas
- **12 blockchains** - deposit from wherever your crypto lives
- **Trades under 2 minutes** - 24/7/365

## For Businesses

Building a product that needs to move money? UNIGOX offers a B2B API for payouts to 17+ countries. Integrate once, pay out everywhere.

**Coming soon:**
- 🏦 Virtual EUR and GBP bank accounts - receive and send payments without a traditional bank
- 🌍 More on-ramp currencies - top up with local bank accounts from additional countries

Reach out at **hello@unigox.com** to learn more.

---

## Contact

- 🌐 [unigox.com](https://www.unigox.com)
- ✉️ hello@unigox.com
- ✈️ [@unigox_global](https://t.me/unigox_global) on Telegram
- 💼 [linkedin.com/company/unigox](https://linkedin.com/company/unigox)

---

## License

MIT
