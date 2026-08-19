#!/usr/bin/env node
// mock-openai — a small OpenAI-compatible server for smoke-testing redcode
// against a machine you control, on any OS.
//
//   GET  /v1/models            -> the model list (what /connect probes)
//   POST /v1/chat/completions  -> a scripted SSE stream, shaped exactly like
//                                 OpenAI's, including the final usage-only
//                                 chunk (pi's client sends
//                                 stream_options.include_usage and reads it).
//
// No dependencies, no TLS, listens on loopback only. The Windows CI smoke test
// runs the real pi, the real redcode profile and the real client against this
// server, so a green run proves the whole stack except the last hop.
//
//   node scripts/mock-openai.mjs [port]    (default 18901)
//
//   MOCK_API_KEY  default "mock-key"
//   MOCK_MODEL    default "mock-1"

import http from "node:http";
import process from "node:process";

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 18901);
const apiKey = process.env.MOCK_API_KEY ?? "mock-key";
const modelId = process.env.MOCK_MODEL ?? "mock-1";

// What the scripted reply says, split across two deltas so the stream has the
// same shape a real answer does (role, text…, finish, usage).
const REPLY = "redcode-mock-ok";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function badKey(res) {
  json(res, 401, { error: { message: "invalid api key", type: "auth", code: "invalid_api_key" } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const auth = req.headers.authorization ?? "";

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (auth !== `Bearer ${apiKey}`) return badKey(res);
    return json(res, 200, {
      object: "list",
      data: [{ id: modelId, object: "model", owned_by: "redcode-ci" }],
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (auth !== `Bearer ${apiKey}`) return badKey(res);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const base = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
      };
      const chunk = (choices) => res.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`);
      // Small gaps between chunks: enough that a client which buffered the
      // whole stream before reading would still be exercised by the timing.
      chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      setTimeout(() => chunk([{ index: 0, delta: { content: REPLY.slice(0, 8) }, finish_reason: null }]), 50);
      setTimeout(() => chunk([{ index: 0, delta: { content: REPLY.slice(8) }, finish_reason: null }]), 120);
      setTimeout(() => chunk([{ index: 0, delta: {}, finish_reason: "stop" }]), 200);
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [],
            usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }, 260);
    });
    return;
  }

  json(res, 404, {
    error: { message: `no such endpoint: ${req.method} ${url.pathname}`, type: "invalid_request", code: "not_found" },
  });
});

server.listen(port, "127.0.0.1", () => {
  const shown = apiKey === "mock-key" ? "mock-key" : "<set via MOCK_API_KEY>";
  console.log(`mock-openai: http://127.0.0.1:${port}/v1  key: ${shown}  model: ${modelId}`);
});