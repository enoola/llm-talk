import { hostname, homedir } from "node:os"
import { readFileSync } from "node:fs"

export interface BusConfig {
  /** Absolute URL of api.php on the host. */
  url: string
  /** Shared secret matching BUS_TOKEN in api.php. */
  token: string
  /** This instance's name. Defaults to the machine hostname. */
  name: string
  /** Push a short "you are on a bus" note into each session's system prompt. */
  announce: boolean
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Retries on network/5xx failures. */
  retries: number
}

const DEFAULTS: BusConfig = {
  url: "",
  token: "",
  name: "",
  announce: true,
  timeoutMs: 15000,
  retries: 2,
}

/** Optional per-machine overrides: ~/.config/opencode/llm-talk.json */
function fileConfig(): Partial<BusConfig> {
  try {
    const raw = readFileSync(`${homedir()}/.config/opencode/llm-talk.json`, "utf8")
    return JSON.parse(raw) as Partial<BusConfig>
  } catch {
    return {}
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return ""
}

export type ResolvedConfig =
  | { ok: true; config: BusConfig }
  | { ok: false; error: string }

/**
 * Precedence: plugin options > environment > ~/.config/opencode/llm-talk.json.
 * The env layer lets every machine share one checked-in opencode.jsonc that
 * uses `{env:...}` substitution without the token living in the repo.
 */
export function resolveConfig(options: unknown): ResolvedConfig {
  const opts = (options ?? {}) as Record<string, unknown>
  const file = fileConfig()

  const url = firstString(opts.url, process.env.LLM_TALK_URL, file.url)
  const token = firstString(opts.token, process.env.LLM_TALK_TOKEN, file.token)
  const name = firstString(opts.name, process.env.LLM_TALK_NAME, file.name) || safeHostname()

  const missing: string[] = []
  if (!url) missing.push("url")
  if (!token) missing.push("token")
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `llm-talk is missing: ${missing.join(" and ")}. Set them in opencode.jsonc under ` +
        `plugins[].options, or export LLM_TALK_URL / LLM_TALK_TOKEN.`,
    }
  }

  let normalised = url
  if (!/^https?:\/\//i.test(normalised)) normalised = `https://${normalised}`

  return {
    ok: true,
    config: {
      url: normalised,
      token,
      name,
      announce: typeof opts.announce === "boolean" ? opts.announce : DEFAULTS.announce,
      timeoutMs: numberOr(opts.timeoutMs, DEFAULTS.timeoutMs, 1000, 120000),
      retries: numberOr(opts.retries, DEFAULTS.retries, 0, 5),
    },
  }
}

function safeHostname(): string {
  try {
    return hostname().replace(/[^A-Za-z0-9._-]+/g, "-") || "instance"
  } catch {
    return "instance"
  }
}

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
