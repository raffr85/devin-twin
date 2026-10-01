// Minimal MCP client used by `dlb status`/`doctor`.

export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "dlb-cli", version: "0" });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, isError: res.isError };
    }
  } finally {
    await client.close().catch(() => {});
  }
}
