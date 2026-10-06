import type { BusConfig } from "./config"

export const KINDS = ["note", "question", "answer", "handoff", "result", "ack", "alert"] as const
export type MessageKind = (typeof KINDS)[number]

export interface PeerMessage {
  id: number
  from: string
  to: string
  kind: string
  text: string
  ts: number
  thread?: string
}

export interface PeerInfo {
  name: string
  messages: number
  lastID: number
  lastTS: number
  lastText: string
}

export interface InboxResult {
  ok: true
  to: string
  count: number
  pending: number
  storeLastID: number
  messages: PeerMessage[]
}

export interface PeersResult {
  ok: true
  me: string
  unread: number
  total: number
  storeLastID: number
  peers: PeerInfo[]
}

export interface SendResult {
  ok: true
  id: number
  from: string
  to: string
  kind: string
  queued: boolean
}

export class BusError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "BusError"
  }
}

export class BusClient {
  constructor(private readonly config: BusConfig) {}

  async health(signal?: AbortSignal): Promise<string> {
    const res = await this.request({ action: "health" }, { method: "GET", signal, auth: false })
    return res
  }

  async send(
    input: { from: string; to: string; text: string; kind?: string; thread?: string },
    signal?: AbortSignal,
  ): Promise<SendResult> {
    return this.request<SendResult>({ action: "send", ...input }, { method: "POST", signal })
  }

  async inbox(
    input: { to: string; after?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<InboxResult> {
    return this.request<InboxResult>({ action: "inbox", ...input }, { method: "GET", signal })
  }

  async peers(input: { to: string; after?: number }, signal?: AbortSignal): Promise<PeersResult> {
    return this.request<PeersResult>({ action: "peers", ...input }, { method: "GET", signal })
  }

  private async request<T = string>(
    params: Record<string, string | number | undefined>,
    opts: { method: "GET" | "POST"; signal?: AbortSignal; auth?: boolean },
  ): Promise<T> {
    const url = new URL(this.config.url)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue
      url.searchParams.set(key, String(value))
    }

    const attempts = opts.auth === false ? 1 : this.config.retries + 1
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (opts.signal?.aborted) throw new BusError("Cancelled.")
      try {
        return await this.attempt<T>(url, opts)
      } catch (error) {
        lastError = error
        const retryable = error instanceof BusError && (error.status === undefined || error.status >= 500)
        if (!retryable || attempt === attempts) break
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
      }
    }

    if (lastError instanceof BusError) throw lastError
    throw new BusError(`Could not reach ${url.origin}${url.pathname}: ${(lastError as Error)?.message ?? "unknown error"}`)
  }

  private async attempt<T>(url: URL, opts: { method: "GET" | "POST"; signal?: AbortSignal; auth?: boolean }): Promise<T> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const headers: Record<string, string> = { accept: "application/json" }
      if (opts.auth !== false) headers["x-bus-token"] = this.config.token

      let body: string | undefined
      if (opts.method === "POST") {
        headers["content-type"] = "application/json"
        body = JSON.stringify(Object.fromEntries(url.searchParams))
        url.search = ""
      }

      const response = await fetch(url.toString(), {
        method: opts.method,
        headers,
        body,
        signal: controller.signal,
      })

      const text = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new BusError(
          `HTTP ${response.status} with a non-JSON body: ${text.slice(0, 200) || "(empty)"}`,
          response.status,
        )
      }

      if (!response.ok || (payload as { ok?: boolean })?.ok === false) {
        const message = (payload as { error?: string })?.error ?? `HTTP ${response.status}`
        throw new BusError(message, response.status)
      }

      return payload as T
    } catch (error) {
      if (controller.signal.aborted && !opts.signal?.aborted) {
        throw new BusError(`Timed out after ${this.config.timeoutMs}ms.`, 504)
      }
      throw error
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }
}
