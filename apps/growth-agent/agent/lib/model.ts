import type { AgentLimitsDefinition, AgentModelOptionsDefinition, AgentReasoningDefinition } from "eve";
const GROWTH_MODEL = "zai/glm-5.2";

const GROWTH_PROVIDER_ORDER = ["wafer", "zai"] as const;
const GROWTH_REASONING: AgentReasoningDefinition = "none";
const GROWTH_LIMITS: AgentLimitsDefinition = {
  // This is a session-wide backstop, not a per-call cap: Eve checks exact provider usage between
  // model calls. The stream-byte guard in agent-session.ts covers a single runaway streaming call.
  maxOutputTokensPerSession: 80_000,
  sessionTimeoutMs: 45 * 60 * 1000,
};

/**
 * Z.AI's NATIVE thinking switch, which is what actually turns glm-5.2's reasoning off.
 *
 * WHY THE GENERIC `reasoning` FIELD IS NOT ENOUGH: the AI SDK's provider-agnostic effort level is
 * translated to each provider's native API by the gateway, and the gateway's translation table
 * covers OpenAI, Anthropic, Google/Vertex and Bedrock only. Z.AI is not in it, so `reasoning:
 * "none"` is accepted and then silently dropped. We measured exactly that: across a 150-request run
 * on 2026-08-11 with `reasoning: "none"` already set, reasoning was still 64.0% of generated tokens
 * (221,215 of 345,871) — statistically indistinguishable from the 62.2% baseline before the flag
 * existed. An earlier 50-request run read 36.7% and briefly looked like a partial win; it was
 * sample noise.
 *
 * Z.AI's own API takes `thinking: { type: "enabled" | "disabled" }`, and glm-5.2 supports the
 * toggle (the gateway catalog lists `reasoning_options: [{type:"toggle"}, {type:"effort", values:
 * ["high","xhigh"]}]` — note there is no "low", which is why there is no cheap middle ground).
 * Vercel's docs are explicit that a reasoning-related entry in `providerOptions` "takes full
 * precedence" over the top-level `reasoning` value, so this is the setting that wins.
 *
 * Keyed under BOTH `zai` and `wafer` deliberately. The model id's namespace is `zai`, but the
 * request is routed to the `wafer` provider, and the gateway's documentation is ambiguous about
 * which of the two names it matches provider options against (its own examples use the model
 * namespace in one place and the serving provider in another). Unknown keys are ignored, so
 * covering both is free and removes the guess.
 */
const GROWTH_THINKING_PROVIDER_OPTIONS = {
  zai: { thinking: { type: "disabled" } },
  wafer: { thinking: { type: "disabled" } },
} as const;

/**
 * The full model handle to spread into `defineAgent`. Spread rather than destructured at each call
 * site so that anything added here later (reasoning effort, context window) reaches all four agents
 * without four more edits.
 */
export function getGrowthModelConfig(): { limits: AgentLimitsDefinition, model: string, modelOptions: AgentModelOptionsDefinition, reasoning: AgentReasoningDefinition } {
  return {
    limits: GROWTH_LIMITS,
    model: GROWTH_MODEL,
    reasoning: GROWTH_REASONING,
    modelOptions: {
      providerOptions: {
        // Spread first so the gateway block below cannot be shadowed by a future key collision.
        ...GROWTH_THINKING_PROVIDER_OPTIONS,
        gateway: {
          order: [...GROWTH_PROVIDER_ORDER],
          // NO `disallowPromptTraining` / `zeroDataRetention` FILTER HERE, and that is a measured
          // decision rather than an oversight -- please read before adding one back.
          //
          // Both read like free safety wins. They are not: they are FILTERS over the eligible
          // provider set, and glm-5.2's providers differ ~8x in speed, so narrowing the set moves
          // which one serves you. We ran `disallowPromptTraining: true` for one full analysis run on
          // 2026-08-10 and measured the result from eve's own step telemetry (`eve logs --events`,
          // 92 model calls): 65 tok/s aggregate, median 60, max 130, unimodal. That is `alibaba`'s
          // ~59 tok/s, not Wafer's ~466 -- i.e. the filter silently excluded Wafer despite the
          // gateway catalog flagging it as compliant, and cost roughly 7x throughput to do it.
          //
          // So: trust a measured run over the catalog's compliance flags. If a privacy filter is
          // ever required, add it AND re-measure tok/s, and expect to trade most of the speed for
          // it. The provider-independent control that does not cost throughput is the PII gate on
          // the sql-query route (backend lib/growth/sql-privacy.ts), which keeps end-user personal
          // data out of prompts no matter who serves them.
        },
      },
    },
  };
}
