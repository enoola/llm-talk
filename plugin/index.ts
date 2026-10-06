import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./config"
import { BusClient, BusError, KINDS, type PeerMessage } from "./client"

const CURSOR_KEY = "inbox_cursor"

export default Plugin.define({
  id: "llm-talk",
  async setup(ctx) {
    const resolved = resolveConfig(ctx.options)
    if (!resolved.ok) {
      console.error(`[llm-talk] disabled: ${resolved.error}`)
      return
    }

    const config = resolved.config
    const bus = new BusClient(config)

    console.log(`[llm-talk] "${config.name}" -> ${config.url}`)

    // Nudge each session so the model knows peers exist and how to address them.
    if (config.announce) {
      await ctx.session.hook("context", (event) => {
        event.system.push({
          type: "text",
          text:
            `You are the OpenCode instance "${config.name}" and you share a message bus with other ` +
            `OpenCode instances. Use peer_send to hand work to a peer or to ask one a question, and ` +
            `peer_inbox to collect what they sent you. Call peer_who to discover who is out there. ` +
            `Address peers by name, or "*" to broadcast. Only message a peer when it is genuinely useful.`,
        })
      })
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "peer",
        description: "Message bus shared with other OpenCode instances",
      })

      editor.add({
        name: "send",
        description:
          `Send a message to another OpenCode instance on the shared bus. This instance is "${config.name}". ` +
          `Use "to: '*'" to broadcast. Prefer a specific peer; use the "handoff" kind when transferring ownership of a task, ` +
          `"question" when you need an answer, and "result" when reporting an outcome.`,
        input: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: `Recipient instance name, or "*" for every instance. Not "${config.name}".`,
            },
            text: { type: "string", description: "Message body. Plain text, may be multi-line." },
            kind: { type: "string", enum: [...KINDS], description: "Message category (default: note)." },
            thread: { type: "string", description: "Optional shared subject so replies stay grouped." },
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        options: { namespace: "peer", codemode: true },
        execute: async (input, context) => {
          const { to, text, kind, thread } = input as {
            to: string
            text: string
            kind?: string
            thread?: string
          }
          await context.progress({ status: `sending to ${to}` })

          try {
            const sent = await bus.send(
              { from: config.name, to: to.trim(), text, kind, thread },
              context.signal,
            )
            return {
              content:
                `Sent message #${sent.id} to ${sent.to} (${sent.kind}).` +
                (sent.to === "*" ? " It is queued for every other instance." : ""),
            }
          } catch (error) {
            return { content: failure("send", error) }
          }
        },
      })

      editor.add({
        name: "inbox",
        description:
          `Read messages other OpenCode instances have sent to "${config.name}". ` +
          `By default returns only messages newer than the last read point, then advances that read point, so calling it ` +
          `again shows nothing until someone new writes. Pass after: 0 to re-read the whole mailbox without advancing. ` +
          `Call this before deciding you are blocked on another instance.`,
        input: {
          type: "object",
          properties: {
            after: {
              type: "number",
              description:
                "Only return messages with an id above this. Omit to continue from the last read point; pass 0 to replay everything.",
            },
            limit: { type: "number", description: "Maximum messages to return (default 20, max 100)." },
          },
          additionalProperties: false,
        },
        options: { namespace: "peer", codemode: true },
        execute: async (input, context) => {
          const { after, limit } = input as { after?: number; limit?: number }
          await context.progress({ status: "checking inbox" })

          const stored = ((await ctx.storage.get(CURSOR_KEY)) as number | undefined) ?? 0
          const from = typeof after === "number" && Number.isFinite(after) ? Math.max(0, Math.trunc(after)) : stored

          try {
            const result = await bus.inbox({ to: config.name, after: from, limit }, context.signal)

            let newest = from
            for (const message of result.messages) newest = Math.max(newest, message.id)
            if (typeof after !== "number" && newest > stored) {
              await ctx.storage.set(CURSOR_KEY, newest)
            }

            return { content: renderInbox(result, from) }
          } catch (error) {
            return { content: failure("inbox", error) }
          }
        },
      })

      editor.add({
        name: "who",
        description:
          `List the other OpenCode instances that have used the shared bus, most recently active first, ` +
          `with how many messages each has sent and your unread count against each. Use this to discover peer names ` +
          `before calling peer_send.`,
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "peer", codemode: true },
        execute: async (_input, context) => {
          await context.progress({ status: "listing peers" })

          const stored = ((await ctx.storage.get(CURSOR_KEY)) as number | undefined) ?? 0
          try {
            const result = await bus.peers({ to: config.name, after: stored }, context.signal)

            if (result.peers.length === 0) {
              return {
                content:
                  `No peers yet on ${config.url}. You are "${config.name}". ` +
                  `Other instances will appear here once they send their first message.`,
              }
            }

            const lines = result.peers.map((peer) => {
              const last = peer.lastText ? ` — last: ${truncate(peer.lastText, 100)}` : ""
              return `- ${peer.name}: ${peer.messages} message(s), last active ${relative(peer.lastTS)}${last}`
            })
            return {
              content:
                `You are "${config.name}". ${result.unread} unread message(s). ${result.peers.length} peer(s):\n` +
                lines.join("\n"),
            }
          } catch (error) {
            return { content: failure("peers", error) }
          }
        },
      })
    })
  },
})

function renderInbox(
  result: { count: number; pending: number; messages: PeerMessage[]; storeLastID: number },
  from: number,
): string {
  if (result.count === 0) {
    return from > 0
      ? `Inbox empty. No new messages since id ${from}. The store's latest id is ${result.storeLastID}.`
      : `Inbox empty. No peer has messaged you yet. The store's latest id is ${result.storeLastID}.`
  }

  const header =
    result.count === 1
      ? "1 new message:"
      : `${result.count} new message(s) in arrival order:`

  const body = result.messages
    .map((message) => {
      const thread = message.thread ? ` [thread: ${message.thread}]` : ""
      return `#${message.id} from ${message.from} (${message.kind}, ${relative(message.ts)})${thread}\n${message.text}`
    })
    .join("\n\n")

  const tail =
    result.pending > result.count
      ? `\n\n(${result.pending - result.count} older unread message(s) not shown. Raise "limit" or pass a lower "after".)`
      : ""

  return `${header}\n\n${body}${tail}`
}

function failure(action: string, error: unknown): string {
  if (error instanceof BusError) {
    if (error.status === 401) {
      return `llm-talk "${action}" was rejected (401): the shared token does not match BUS_TOKEN in api.php. Check LLM_TALK_TOKEN on this machine.`
    }
    if (error.status === 500) {
      return `llm-talk "${action}" failed on the server: ${error.message}`
    }
    return `llm-talk "${action}" failed (${error.status ?? "network"}): ${error.message}`
  }
  return `llm-talk "${action}" failed: ${(error as Error)?.message ?? String(error)}`
}

function relative(ts: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000) - ts)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
