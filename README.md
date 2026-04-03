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
- **TON wallet auth** — there are now two first-class TON login paths:
  - **agent-side derivation**: the user gives the exact raw TON address plus either the wallet mnemonic phrase or the TON private key / secret key for that same wallet. The agent treats the raw address as the source of truth, tries the supported TON wallet versions until one matches that exact address, and stores the matched derivation as `UNIGOX_TON_WALLET_VERSION` for later runs.
  - **fresh TonConnect link / QR**: the agent creates a fresh live TonConnect deep link that the user opens in the wallet. If needed, the user can scan a QR generated from that exact live link on another device. Old screenshots of earlier QR codes are not reusable login credentials.
- **Browser login helper from a fresh `tc://` link** — if the user is already on `unigox.com` and the site is showing a fresh TonConnect login link in `tc://...` form, the skill can consume that live link and approve it locally with the stored TON key for the exact wallet. This is meant to help the user finish the UNIGOX website login so they can reach settings and export the separate signing key. It is not QR-image decoding; it is specifically the copyable `tc://` link path.
- **Agent email** — useful for onboarding and recovery when neither wallet path is ready yet. You can later link either an EVM wallet or a TON wallet.
- When the only remaining blocker is the exported UNIGOX signing key, explain the practical browser-login paths the user can use to get into unigox.com settings and export it: scan a fresh UNIGOX TonConnect QR in the wallet, copy the fresh `tc://` TonConnect link into the wallet if the site shows that instead of a QR, or log in on unigox.com directly from the user's mobile or desktop wallet.
- If the user does not see the signing-key export option yet, explain that this is a beta feature and the account likely still needs agentic-payments access enabled. The next step is to ask UNIGOX via `hello@unigox.com` or Intercom chat to enable it, then retry the export.

⚠️ **Security:**
- Do not hold large amounts in this wallet. Treat it as a spending wallet, not a vault. Load only what you need for upcoming transfers.
- Use a newly created / isolated wallet for UNIGOX agent setup and key sharing. Do **not** use your main wallet.
- Secure your login key, signing key, or TON private key. If someone gains access to them, they can authenticate or sign as the agent.
- TON auth only covers login / JWT acquisition. Advanced EVM-signed actions still require the exported EVM signing key.
- The skill can verify login with the first EVM key, but it does not currently auto-export the second key from UNIGOX. That export still has to happen manually on unigox.com, and some accounts will not see the export option until early beta access is enabled.
- We are building more secure key management options for agents. For now, standard precautions apply.

### 4. Install the skill
Add Agentic Payments to your OpenClaw agent.

## Adapter Compatibility

This project can stay in one repo.

The portability rule is:
- one shared transfer engine
- one canonical machine interface
- thin runtime adapters on top

Current layout:
- shared transfer engine: `scripts/transfer-orchestrator.ts`
- canonical session-aware runner: `scripts/run-transfer-turn.ts`
- canonical portable tool contract: `scripts/send-money-tool.ts`
- Codex local skill adapter: root `SKILL.md`
- OpenClaw adapter: `SKILL.md`
- OpenAI tool definition: `adapters/openai/send-money-tool.json`
- Anthropic tool definition: `adapters/anthropic/send-money-tool.json`

For OpenAI and Anthropic, the safest integration is to call the same `send_money_turn` tool with:
- `text`
- `session_key`
- optional `reset`

The host application should keep the same `session_key` across turns so the send flow can resume correctly instead of restarting.

The engine remains responsible for:
- auth state
- saved recipient resolution
- quotes
- KYC
- payout detail collection
- settlement state

The adapter remains responsible for:
- tool transport
- button / quick-reply rendering
- host-specific tool plumbing

## Cross-Platform Compatibility Contract

GitHub must stay the source of truth for every supported runtime.

Do not ship Codex-only, OpenClaw-only, OpenAI-only, or Anthropic-only payment logic forks. The same transfer engine and runner contract must remain the authority for all four.

Canonical files:
- shared flow engine: `scripts/transfer-orchestrator.ts`
- canonical runner: `scripts/run-transfer-turn.ts`
- canonical tool contract: `scripts/send-money-tool.ts`
- Codex local skill adapter: root `SKILL.md`
- OpenClaw adapter: `SKILL.md`
- OpenAI adapter contract: `adapters/openai/send-money-tool.json`
- Anthropic local MCP server: `scripts/send-money-mcp.ts`, `scripts/send-money-mcp-server.ts`

Every compatibility change should follow this release rule:
1. Implement the behavior in the shared engine or canonical runner first.
2. Update adapter files only for transport / invocation differences.
3. Run the shared script test suite:
   - `npm test --prefix scripts`
4. Recheck that every adapter still points to the same `send_money_turn` contract.
5. Update this README and `adapters/README.md` if the install path, supported platforms, or adapter contract changed.
6. Commit and push the change to GitHub before syncing any VM/runtime copy.

Durable packaging rule:
- Codex distribution should stay local-first. The preferred end-user install path is a local plugin wrapper installed by `scripts/install-codex-plugin.sh`, which writes the documented home-local marketplace entry in `~/.agents/plugins/marketplace.json` and points `~/plugins/agentic-payments` back at this repo instead of a copied fork.
- OpenClaw distribution should keep using the root `SKILL.md` plus the same runner contract.
- OpenAI distribution should keep using the tool schema in `adapters/openai/send-money-tool.json`.
- Anthropic distribution should stay local-first. The preferred user install path is a drag-and-drop Claude Desktop extension (`.mcpb`) generated from this same repo and commit, not a separate logic fork.
- When Anthropic desktop packaging is added, the `.mcpb` bundle must be built from the same GitHub commit as the source and documented in the release notes so Claude, OpenAI, OpenClaw, and Codex stay aligned.

### Supported Platforms

Supported today:
- Codex desktop / CLI as a local installed plugin that points at this repo
- OpenClaw as a packaged local skill
- OpenAI-based host apps or SDK integrations using the local `send_money_turn` tool definition
- Anthropic Claude Desktop using a local MCP server on the same machine
- Anthropic Claude Code using the same local MCP server

Not the target model for this repo:
- shared hosted MCP servers
- centralized wallet secrets
- shared runtime session state across users

### Codex local install

Codex should use this repo as a local plugin wrapper, not a copied fork.

Preferred install:

```bash
bash scripts/install-codex-plugin.sh
```

That creates:

- `~/plugins/agentic-payments -> <repo-root>`
- `~/.agents/plugins/marketplace.json` entry for `agentic-payments`

and enables:

- `[plugins."agentic-payments@local"]`

The plugin wrapper then points Codex back at the same repo-backed skill and scripts:

- root plugin manifest: `.codex-plugin/plugin.json`
- Codex plugin skill wrapper: `skills/send-money/SKILL.md`
- canonical skill instructions: `SKILL.md`

If the repo is not cloned yet, the simplest path is:

```bash
git clone https://github.com/grape404/agentic-payments.git
cd agentic-payments
bash scripts/install-codex-plugin.sh
```

If you only want the raw Codex skill without the plugin wrapper, the legacy fallback still exists:

```bash
bash scripts/install-codex-skill.sh
```

After install, restart Codex to pick up the new plugin.

### Claude Local MCP Setup

For Claude, this repo is designed for a local MCP server per tester device.

Key files:
- local MCP server wrapper: `scripts/send-money-mcp-server.sh`
- MCP server entrypoint: `scripts/send-money-mcp-server.ts`
- Claude Desktop example config: `adapters/anthropic/claude-desktop.mcp.example.json`
- Claude Desktop bundle manifest: `adapters/anthropic/manifest.json`
- committed drag-and-drop installer bundle: `adapters/anthropic/installed.mcpb`

The wrapper keeps dependency bootstrap local to the machine running the skill. Wallet secrets, `.env`, and transfer session state stay on that same device.

### Claude Desktop install

The preferred Anthropic install path is a committed local desktop bundle in this repo:

- `adapters/anthropic/installed.mcpb`

On macOS, after cloning or downloading the repo, install it with:

```bash
open /absolute/path/to/agentic-payments/adapters/anthropic/installed.mcpb
```

That should hand the bundle to Claude Desktop and open the extension install prompt.

To rebuild the bundle from source on the same commit:

```bash
npm run build:anthropic-bundle --prefix scripts
```

### 5. Initialize the agent
On first run, the skill walks you through setup by first asking which wallet connection path it should use for UNIGOX sign-in — **EVM** or **TON**. If you choose **EVM**, the onboarding sequence is now: first confirm you have already signed in on unigox.com with that wallet, then show the isolated-wallet warning, then ask which login wallet key you used and verify login with it, surface your current UNIGOX username, and only after that ask for the separate UNIGOX-exported signing key needed for signed actions inside UNIGOX. After the user pastes either EVM key, the flow tries to delete that message if the runtime supports it; otherwise it pauses and asks the user to delete the message themselves before continuing. If you choose **TON**, the onboarding sequence now asks for the exact raw TON address first, confirms that it is the correct wallet address/version, and then lets you finish login in either of two ways: send the mnemonic / TON private key for that same wallet so the agent can derive supported wallet versions locally until one matches, or use a fresh live TonConnect deep link / QR for that exact address. The matched derivation is stored as `UNIGOX_TON_WALLET_VERSION` for later re-auth. If neither wallet path is ready yet, it can temporarily fall back to email OTP for onboarding or recovery, then optionally link the wallet path you chose. For real transfer runs, the skill now blocks early on a missing exported signing key even after email OTP or TON login, so the user gets the export / beta-access explanation before recipient, quote, or trade execution instead of at the last secure step. After that it helps with payment methods and your first contacts. On later runs, the flow now checks stored auth first; if the saved login/signing credentials are already usable, it skips the auth-path questions, surfaces the current UNIGOX username and wallet balance immediately, and continues with the transfer. More details in the setup guide.

### 6. Fund your wallet
Two options:

- **Another UNIGOX user can fund you directly.** If you want an internal UNIGOX top-up, the agent should first show the current preflight economics for the intended payout when available: the current rate basis, the estimated total wallet coverage needed, and how much more you need to top up. Then it should clearly show your current UNIGOX username and tell the other UNIGOX user to send that amount to the username, while clearly marking whether the shown rate is still only an estimate or a locked quote. This route should not ask token + chain unless you switch to external deposit.
- **Already have crypto in another wallet?** Use the external / on-chain deposit route. The agent should keep this conversational and stepwise: first ask which token you want to deposit, then show the frontend-supported networks for that token, and only after you choose the network show the single matching deposit address. Those options come from the same frontend `bridge-cryptocurrencies` data the wallet UI uses, filtered by `enabled_for_deposit`, main user-facing assets, XAI exclusion, and supported address families (EVM, Solana, Tron, TON). Example of the current split: USDC supports EVM chains plus Solana, while USDT supports a different set that includes Tron and TON but not every USDC chain.
- **No crypto?** Use the skill to top up your wallet from your bank account. On-ramp is currently available in EUR, NGN, and KES, with more currencies coming soon.

### 7. Send money

```
> send €200 to john on revolut
```

Your agent resolves the recipient, walks method selection step by step, checks the balance early, and only then asks for final confirmation. Balance reporting now shows both the total wallet balance and the per-asset split (for example USDC and USDT), and the preflight makes it explicit that one SELL trade must be funded by a single asset rather than the combined total. Recipient gets paid only after you confirm.

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
