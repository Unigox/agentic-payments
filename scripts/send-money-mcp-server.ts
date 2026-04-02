#!/usr/bin/env -S node --experimental-strip-types
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  registerSendMoneyMcpTool,
  SEND_MONEY_MCP_SERVER_NAME,
  SEND_MONEY_MCP_SERVER_VERSION,
} from "./send-money-mcp.ts";

async function main() {
  const server = new McpServer({
    name: SEND_MONEY_MCP_SERVER_NAME,
    version: SEND_MONEY_MCP_SERVER_VERSION,
  });

  registerSendMoneyMcpTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
