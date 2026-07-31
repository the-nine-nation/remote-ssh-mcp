import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio MCP server lists and calls all six tools", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.SSH_MCP_ALLOWED_HOSTS = "test";
  env.SSH_MCP_SSH_CONFIG = "/definitely/not/a/real/ssh-config";
  env.SSH_MCP_AUDIT_LOG = "/tmp/remote-ssh-mcp-test-audit.jsonl";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "remote-ssh-mcp-test",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "ssh_close",
        "ssh_interrupt",
        "ssh_list",
        "ssh_open",
        "ssh_peek",
        "ssh_run",
      ],
    );
    const runTool = listed.tools.find((tool) => tool.name === "ssh_run");
    const peekTool = listed.tools.find((tool) => tool.name === "ssh_peek");
    assert.equal(runTool?.inputSchema.required?.includes("timeout_sec"), false);
    assert.equal(
      (
        peekTool?.inputSchema.properties?.lines as
          | { default?: unknown }
          | undefined
      )?.default,
      50,
    );
    assert.equal(
      (
        peekTool?.inputSchema.properties?.wait_sec as
          | { default?: unknown }
          | undefined
      )?.default,
      0,
    );
    const result = await client.callTool({
      name: "ssh_list",
      arguments: {},
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      status: "ok",
      connection_count: 0,
      opening_count: 0,
      max_sessions: 8,
      sessions: [],
    });
  } finally {
    await client.close();
  }
});
