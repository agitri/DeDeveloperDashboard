/**
 * A real MCP server, for the adapter test and the commands test.
 *
 * Plain Node, spawned through the real `StdioClientTransport`, so the adapter
 * is exercised end to end rather than against a stub. Given a path as its first
 * argument it writes its pid there before serving: that file is how a test
 * proves a refused command never started a process, and how the round trip
 * proves the process is gone once the sync is over.
 *
 * Four resources, deliberately: one described and web-linkable, one that has to
 * be read, one that echoes the injected secret, and one annotated for models
 * alone — which must never reach the board.
 */
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const pidFile = process.argv[2];
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

const server = new Server({ name: "echo", version: "9.9.9" }, { capabilities: { resources: {}, tools: {} } });

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [
    {
      uri: "https://example.test/notes/one",
      name: "one",
      title: "Note one",
      description: "the first note",
      annotations: { audience: ["user"], priority: 0.5, lastModified: "2026-01-02T03:04:05Z" },
    },
    { uri: "file:///notes/two.md", name: "Two", mimeType: "text/markdown" },
    { uri: "https://example.test/env", name: "Env", description: `token:${process.env.DDD_TEST_TOKEN ?? "none"}` },
    {
      uri: "x://context",
      name: "Model context",
      description: "for the model",
      annotations: { audience: ["assistant"] },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
  contents: [{ uri: request.params.uri, text: `body of ${request.params.uri}` }],
}));

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "echoes its argument",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
}));

await server.connect(new StdioServerTransport());
