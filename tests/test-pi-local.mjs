#!/usr/bin/env node
/**
 * Local end-to-end test: loads the real extension through the pi CLI while the
 * Command Code API is replaced by a deterministic local mock server.
 */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const TEST_MODEL = "cc-offline-cache-model"

function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = resolve(PROJECT_DIR, "node_modules", ".bin")
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => resolve(entry, "pi"))
    .filter((candidate) => !candidate.startsWith(localBin))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return undefined
}

const PI_BIN = findPiBinary()
if (!PI_BIN) {
  console.log("[pi-local] SKIP — pi is not on PATH")
  process.exit(0)
}

const piCheck = spawnSync(PI_BIN, ["--help"], { stdio: "ignore" })
if (piCheck.error) {
  console.log(`[pi-local] SKIP — pi failed to start: ${piCheck.error.message}`)
  process.exit(0)
}

let requestCount = 0
let modelListRequestCount = 0
let lastRequestBody
let lastRequestHeaders = {}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/provider/v1/models") {
    modelListRequestCount += 1
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: TEST_MODEL,
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "DeepSeek V4 Flash",
            context_length: 1_000_000,
          },
          {
            id: "cc-second-model",
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "Qwen 3.7 Max",
            context_length: 1_000_000,
          },
        ],
      }),
    )
    return
  }

  if (req.method !== "POST" || req.url !== "/alpha/generate") {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  requestCount += 1
  lastRequestHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  )

  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString("utf-8")
  })
  req.on("end", () => {
    try {
      lastRequestBody = JSON.parse(body)
    } catch {
      lastRequestBody = undefined
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    })
    res.write(`${JSON.stringify({ type: "text-delta", text: "mock-pi-ok" })}\n`)
    res.write(
      `${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } })}\n`,
    )
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

const tempHome = mkdtempSync(join(tmpdir(), "pi-cc-home-"))
const env = {
  ...process.env,
  HOME: tempHome,
  USERPROFILE: tempHome,
  PI_CODING_AGENT_DIR: join(tempHome, "custom-pi-agent"),
  COMMANDCODE_API_BASE: apiBase,
  COMMANDCODE_API_KEY: "mock-key",
  COMMANDCODE_MODELS_URL: `${apiBase}/provider/v1/models`,
}

function runPi(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, {
      cwd: PROJECT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nTIMEOUT after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function runRpcQuery(timeoutMs = 30_000) {
  const child = spawn(
    PI_BIN,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      EXT_PATH,
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""
  let buffer = ""
  let sawPromptAccepted = false
  let sawAssistantMessage = false
  let sawTextDelta = false
  const events = []

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, timeoutMs)

    const finish = (ok) => {
      clearTimeout(timer)
      try {
        child.stdin.write(`${JSON.stringify({ type: "quit" })}\n`)
      } catch {
        // ignore shutdown race
      }
      child.kill()
      resolve(ok)
    }

    child.stdin.write(
      `${JSON.stringify({ id: "prompt-1", type: "prompt", message: "say mock token" })}\n`,
    )

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf-8")
      stdout += text
      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          events.push(event)
          if (event.type === "response" && event.id === "prompt-1" && event.success === true) {
            sawPromptAccepted = true
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            sawTextDelta = true
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            sawAssistantMessage = true
            finish(true)
          }
        } catch {
          // ignore non-JSON output
        }
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("close", () => {
      if (!sawAssistantMessage) finish(false)
    })
  })

  const ok = await done
  return {
    ok,
    stdout,
    stderr,
    events,
    sawPromptAccepted,
    sawAssistantMessage,
    sawTextDelta,
  }
}

try {
  console.log("[pi-local] first offline start without a cache")
  const onlineModelsUrl = env.COMMANDCODE_MODELS_URL
  env.COMMANDCODE_MODELS_URL = "http://127.0.0.1:1/provider/v1/models"
  const modelsCachePath = join(env.PI_CODING_AGENT_DIR, "commandcode-models.json")
  rmSync(modelsCachePath, { force: true })
  const firstOfflineList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(firstOfflineList.code, 0, firstOfflineList.stderr)
  assert.doesNotMatch(firstOfflineList.stderr, /Failed to load extension/)
  assert.match(
    firstOfflineList.stdout || firstOfflineList.stderr,
    /No models (?:matching|available)/,
  )
  assert.match(firstOfflineList.stderr, /no valid cached catalog/)
  assert.match(firstOfflineList.stderr, /until \/reload succeeds/)
  assert.throws(() => accessSync(modelsCachePath, constants.R_OK), /ENOENT|no such file/i)

  // A fresh process re-runs the extension entrypoint, which is the same path /reload uses.
  console.log("[pi-local] recover models after empty offline start")
  env.COMMANDCODE_MODELS_URL = onlineModelsUrl
  modelListRequestCount = 0
  const recoveryList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(recoveryList.code, 0, recoveryList.stderr)
  const recoveryOutput = recoveryList.stdout || recoveryList.stderr
  assert.match(recoveryOutput, /cc-offline-cache-model/)
  assert.match(recoveryOutput, /cc-second-model/)
  assert.doesNotMatch(recoveryList.stderr, /no valid cached catalog/)
  assert.doesNotMatch(recoveryList.stderr, /Failed to load extension/)
  assert.equal(modelListRequestCount, 1)
  assert.doesNotThrow(() => accessSync(modelsCachePath, constants.R_OK))

  console.log("[pi-local] list models through real extension")
  modelListRequestCount = 0
  const list = await runPi(["--no-extensions", "-e", EXT_PATH, "--list-models"], 20_000)
  assert.equal(list.code, 0, list.stderr)
  const listOutput = list.stdout || list.stderr
  assert.match(listOutput, /commandcode/)
  assert.match(listOutput, /cc-offline-cache-model/)
  assert.match(listOutput, /cc-second-model/)
  assert.equal(modelListRequestCount, 1)
  assert.doesNotThrow(() => accessSync(modelsCachePath, constants.R_OK))

  console.log("[pi-local] list cached models while model discovery is offline")
  env.COMMANDCODE_MODELS_URL = "http://127.0.0.1:1/provider/v1/models"
  const offlineList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(offlineList.code, 0, offlineList.stderr)
  const offlineListOutput = offlineList.stdout || offlineList.stderr
  assert.match(offlineListOutput, /cc-offline-cache-model/)
  assert.match(offlineListOutput, /cc-second-model/)
  assert.match(offlineList.stderr, /Using the cached catalog/)

  console.log("[pi-local] use a cached model while model discovery is offline")
  requestCount = 0
  const offlinePrint = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    30_000,
  )
  assert.equal(offlinePrint.code, 0, offlinePrint.stderr)
  assert.match(offlinePrint.stdout, /mock-pi-ok/)
  assert.match(offlinePrint.stderr, /Using the cached catalog/)
  assert.equal(requestCount, 1)
  env.COMMANDCODE_MODELS_URL = onlineModelsUrl

  console.log("[pi-local] print mode through real extension and mock API")
  requestCount = 0
  const print = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    30_000,
  )
  assert.equal(print.code, 0, print.stderr)
  assert.match(print.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.ok(
    typeof lastRequestHeaders.authorization === "string" &&
      lastRequestHeaders.authorization.startsWith("Bearer "),
    "should send a bearer Authorization header",
  )
  assert.equal(lastRequestBody?.params?.model, TEST_MODEL)

  console.log("[pi-local] RPC prompt through real extension and mock API")
  requestCount = 0
  const rpc = await runRpcQuery()
  assert.equal(
    rpc.ok,
    true,
    JSON.stringify(
      { stderr: rpc.stderr, stdout: rpc.stdout, events: rpc.events.slice(-10) },
      null,
      2,
    ),
  )
  assert.equal(rpc.sawPromptAccepted, true)
  assert.equal(rpc.sawAssistantMessage, true)
  assert.equal(rpc.sawTextDelta, true)
  assert.equal(requestCount, 1)

  console.log("[pi-local] PASS")
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
