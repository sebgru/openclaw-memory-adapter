import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { normalizeConfig, normalizeResults } from "./client.js";
import { FactsFailure, ownerPrivateGuard } from "./facts.js";

export const MAIL_UNAVAILABLE_NOTICE = "Mail search unavailable in this context (owner private chat only, or the mail lane failed); do not infer that no matching mail exists.";
const MAIL_INTENT = /\b(?:e-?mails?|mails?|mailbox|inbox|posteingang|postfach)\b|письм|почт[аеуы]/iu;

/** Off by default; `mail.enabled` is ignored while the adapter is disabled. */
export function mailSettings(config = {}) {
  const mail = config.mail ?? {};
  return {
    enabled: config.enabled !== false && mail.enabled === true,
    intentRouting: mail.intentRouting === true,
  };
}

/** Explicit, deterministic mail intent in the query text (DE/EN/RU). */
export function hasMailIntent(query) {
  return MAIL_INTENT.test(String(query ?? ""));
}

/**
 * Private mail lane. The mail capability token is sent only after the same
 * owner-private guard as facts (owner flag, owner-private audience, direct
 * user turn, root/direct session key, no forwarding). Every refusal or
 * failure is reported as unavailable, never as an empty result.
 */
export function createMail(api, config) {
  const settings = mailSettings(config);
  const { guard } = ownerPrivateGuard(settings.enabled);
  function diagnose(stage, error) {
    const reason = error instanceof FactsFailure ? error.reason : "UNKNOWN";
    // Static codes only: never the query, URL, token or result text.
    api.logger?.warn?.(`memory-adapter: mail unavailable stage=${stage} reason=${reason}`);
  }
  async function search(ctx, query, maxResults) {
    guard(ctx);
    let secret;
    try { secret = getPreparedPluginSecretInput("memory-adapter", "mail.accessToken").value; }
    catch { throw new FactsFailure("SECRET_UNPREPARED"); }
    if (typeof secret !== "string" || !secret) throw new FactsFailure("SECRET_UNPREPARED");
    let normalized, endpoint;
    try {
      normalized = normalizeConfig({ ...config, scope: "all", maxResults });
      endpoint = new URL(normalized.endpoint);
    } catch { throw new FactsFailure("INVALID_ENDPOINT"); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new FactsFailure("INVALID_ENDPOINT");
    const params = new URLSearchParams({ q: String(query).trim().slice(0, normalized.maxQueryLength), scope: "mail", profile: "tool", limit: String(normalized.maxResults) });
    // Re-check immediately before the token leaves the process.
    guard(ctx);
    let response;
    try {
      response = await fetch(`${normalized.endpoint}/unified/search?${params}`, {
        method: "GET", redirect: "error",
        headers: { accept: "application/json", "x-mail-access": secret },
        signal: AbortSignal.timeout(Math.min(normalized.timeoutMs, 6000)),
      });
    } catch (error) {
      throw new FactsFailure(error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : "TRANSPORT");
    }
    if (!response.ok) throw new FactsFailure(`HTTP_${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new FactsFailure("RESPONSE_SHAPE"); }
    if (payload?.coverage?.mail !== "searched") throw new FactsFailure("MAIL_NOT_SEARCHED");
    // Authority may have ended while the request was in flight.
    guard(ctx);
    return normalizeResults(payload, normalized.maxResults, normalized.maxResultTextLength, normalized.deduplicateResults);
  }
  return {
    enabled: settings.enabled,
    intentRouting: settings.intentRouting,
    /** Resolves `{ response }` or `{ unavailable: true }`; never rejects. */
    async lane(ctx, query, maxResults, stage) {
      try {
        return { response: await search(ctx, query, maxResults) };
      } catch (error) {
        diagnose(stage, error);
        return { unavailable: true };
      }
    },
  };
}
