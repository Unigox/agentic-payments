# Installing on Claude Desktop

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed on macOS or Windows

## Overview

Claude Desktop requires **two install steps**, then a **restart**:

1. Open the `.mcpb` extension bundle
2. Upload the companion Skill ZIP
3. Restart Claude Desktop

> Both steps are required. The `.mcpb` registers the local MCP server that runs the payment engine. The Skill ZIP teaches Claude *when* to call that server. Without the Skill, Claude may not route payment requests to the local tools reliably.

## Video Tutorial

If you want to follow the install visually, watch:

- [Agentic Payments setup video](https://youtu.be/KRcdmkPhAtI)

---

## Step 1: Install the Extension (.mcpb)

The extension bundle lives at:

```
adapters/anthropic/installed.mcpb
```

**macOS — open from terminal:**

```bash
open /path/to/agentic-payments/adapters/anthropic/installed.mcpb
```

**macOS / Windows — open from Finder / Explorer:**

Double-click `installed.mcpb`. Claude Desktop should open and show an extension install prompt.

Click **Install** when prompted. You should see "Agentic Payments" appear under your extensions.

---

## Step 2: Upload the Skill ZIP

The Skill ZIP lives at:

```
adapters/anthropic/agentic-payments-skill.zip
```

1. Open Claude Desktop
2. Go to your profile icon (bottom-left) > **Settings** or **Customize**
3. Navigate to the **Skills** section
4. Click **Upload a skill**
5. Select `agentic-payments-skill.zip`
6. Confirm the skill appears in your skills list

---

## Step 3: Restart Claude Desktop

1. **Fully quit** Claude Desktop (not just close the window — use Cmd+Q on macOS or right-click tray icon > Quit on Windows)
2. Reopen Claude Desktop
3. The new MCP server code loads on restart

---

## Verify It Works

Start a new chat and type:

```
/agentic-payments
```

or:

```
I want to send money using Agentic Payments.
```

You should see the sign-in setup flow begin. If you have previously configured authentication, it should detect your saved credentials automatically.

---

## Updating

When the extension is updated (new `.mcpb` built from a newer commit):

1. Open the new `.mcpb` file (same as Step 1)
2. Re-upload the new Skill ZIP (same as Step 2)
3. **Restart Claude Desktop** (same as Step 3)

All three steps are needed on every update. The extension and Skill are separate install surfaces and must stay in sync.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Claude says "I don't have payment tools" | Skill ZIP not uploaded | Do Step 2 |
| Claude suggests TonConnect for an EVM wallet | Old extension still running | Do Step 3 (restart) |
| Claude routes to public connector search | Skill not active or extension disabled | Check both are installed, restart |
| Auth credentials not detected | MCP server running from stale bundle | Restart Claude Desktop |
| "MCP server not found" errors | `.mcpb` install failed | Redo Step 1, then restart |

---

## Rebuilding from Source

To rebuild both the extension and Skill ZIP from the current repo state:

```bash
npm run build:anthropic-bundle --prefix scripts
```

This produces:
- `adapters/anthropic/installed.mcpb`
- `adapters/anthropic/agentic-payments-skill.zip`

---

## Next Steps

- [Configure authentication](authentication.md) (wallet setup, sign-in paths)
