# archon-mcp-client

🚀 Live: https://archonspecs.dev

A completely silent, standards-compliant [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) client bridge that natively proxies Claude Desktop `stdio` requests directly into an Archon `SSE` remote backend over HTTPS.

Unlike other public MCP proxies, this package guarantees complete `stdout` JSON-RPC hygiene, preventing log pollution that crashes Claude Desktop's strict parsers.

## Usage

You do not need to install this library. Just configure your `claude_desktop_config.json` to execute it remotely via `npx`. Find more information and full documentation at [https://archonspecs.dev/docs.html](https://archonspecs.dev/docs.html).

```json
{
  "mcpServers": {
    "archon-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "archon-mcp-client",
        "https://archonspecs.dev/mcp/sse?apiKey=your_api_key_here"
      ]
    }
  }
}
```

## Archon — AI Backend Architecture Compiler

🌐 Website: https://archonspecs.dev  
📚 Docs: https://archonspecs.dev/docs.html  
📦 Library: https://archonspecs.dev/library.html