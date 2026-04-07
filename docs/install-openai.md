# Integrating with OpenAI SDK

## Overview

Register the `send_money_turn` tool in your OpenAI API calls using the tool JSON definition shipped in this repo.

## Tool Definition

The tool schema is at:

```
adapters/openai/send-money-tool.json
```

Use it in your OpenAI chat completion calls as a function tool.

## Minimal Integration

```python
import json
from openai import OpenAI

client = OpenAI()

# Load the tool definition
with open("adapters/openai/send-money-tool.json") as f:
    tool_def = json.load(f)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "send 50 EUR to john on revolut"}],
    tools=[tool_def],
)
```

## Handling Tool Calls

When the model returns a `send_money_turn` tool call:

1. Extract the `text` (and optional `image_path`, `session_key`, `reset`) arguments
2. Pass them to the local `send_money_turn` runner
3. Return the runner's `reply` and `options` back to the model as the tool result
4. Keep the same `session_key` across turns so the flow resumes instead of restarting

## Next Steps

- [Configure authentication](authentication.md)
