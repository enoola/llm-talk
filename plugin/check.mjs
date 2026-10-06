#!/usr/bin/env node
/**
 * llm-talk connectivity check — plain Node, no dependencies, no build step.
 *
 *   node check.mjs https://your-domain.tld/llmtalk/api.php
 *   LLM_TALK_TOKEN=secret node check.mjs
 *
 * Env (matches what the plugin reads):
 *   LLM_TALK_URL    api.php endpoint
 *   LLM_TALK_TOKEN  shared secret
 *   LLM_TALK_NAME   this machine's instance name (default: hostname)
 *
 * Flags:
 *   --send "text"   also post a self-test message to --to (default: the name)
 *   --to NAME       recipient for --send
 */

import { hostname } from "node:os"

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const url = (argv.find((a) => a.startsWith("http")) ?? process.env.LLM_TALK_URL ?? "").trim()
const token = (process.env.LLM_TALK_TOKEN ?? "").trim()
const name = (process.env.LLM_TALK_NAME ?? hostname().replace(/[^A-Za-z0-9._-]+/g, "-") ?? "instance").trim()
const sendText = flag("send", "")
const to = flag("to", name)

if (!url || !token) {
  console.error(
    "Missing configuration.\n" +
      "  pass the endpoint as an argument and set LLM_TALK_TOKEN, e.g.\n" +
      "  LLM_TALK_TOKEN=secret node check.mjs https://example.tld/llmtalk/api.php",
  )
  process.exit(2)
}

const call = async (params, method = "GET") => {
  const target = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") target.searchParams.set(key, String(value))
  }
  const headers = { accept: "application/json", "x-bus-token": token }
  let body
  if (method === "POST") {
    headers["content-type"] = "application/json"
    body = JSON.stringify(Object.fromEntries(target.searchParams))
    target.search = ""
  }
  const response = await fetch(target.toString(), { method, headers, body, signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  try {
    const json = JSON.parse(text)
    return { status: response.status, json }
  } catch {
    return { status: response.status, json: { ok: false, error: `non-JSON body: ${text.slice(0, 200)}` } }
  }
}

const fail = (message, hint) => {
  console.error(`\n  FAIL  ${message}`)
  if (hint) console.error(`        ${hint}`)
  process.exit(1)
}

try {
  const health = await call({ action: "health" })
  if (!health.json?.ok) fail(`health check: ${health.json?.error ?? "no response"}`, "is the URL correct and is api.php uploaded?")
  if (health.json.configured === false)
    fail("server still has the placeholder BUS_TOKEN", "edit BUS_TOKEN at the top of api.php on the server")
  if (health.json.storePublic === true)
    fail("the store file sits inside the web root and is publicly readable", "set BUS_DATA_FILE to a path outside public_html")

  console.log(`  ok    endpoint reachable (${url})`)
  console.log(`  ok    PHP ${health.json.php}, ${health.json.messages} message(s) stored`)
  console.log(`  ok    store at ${health.json.store} (writable: ${health.json.writable})`)

  const peers = await call({ action: "peers", to: name })
  if (!peers.json?.ok) fail(`peers: ${peers.json?.error ?? "no response"}`, "is LLM_TALK_TOKEN identical to BUS_TOKEN on the server?")
  console.log(`  ok    authenticated as "${name}", ${peers.json.unread} unread, ${peers.json.peers.length} peer(s) known`)
  if (peers.json.peers.length > 0) {
    for (const peer of peers.json.peers.slice(0, 5)) console.log(`          - ${peer.name} (${peer.messages} sent)`)
  }

  if (sendText) {
    const sent = await call({ action: "send", from: name, to, text: sendText, kind: "note" }, "POST")
    if (!sent.json?.ok) fail(`send: ${sent.json?.error ?? "no response"}`)
    console.log(`  ok    sent message #${sent.json.id} to "${to}"`)

    if (to !== name) {
      const inbox = await call({ action: "inbox", to, after: 0, limit: 100 })
      if (!inbox.json?.ok) fail(`inbox: ${inbox.json?.error ?? "no response"}`)
      const mine = inbox.json.messages.filter((m) => m.id === sent.json.id)
      if (mine.length === 0) fail(`message #${sent.json.id} is not visible in "${to}"'s inbox`)
      console.log(`  ok    message #${sent.json.id} is readable by "${to}"`)
    }
  }

  console.log("\n  All checks passed.\n")
} catch (error) {
  fail(`could not reach ${url}: ${error?.cause?.code ?? error?.code ?? error?.message ?? error}`, "check the URL, your network, and that the host is serving PHP")
}
