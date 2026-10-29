/**
 * Cloudflare Product Search
 *
 * Product search and autocomplete served from Cloudflare's network.
 * - /api/search        ranked product search (SuggestAPI GET /v1/autocomplete)
 * - /api/autocomplete  search-as-you-type suggestions (SuggestAPI GET /v1/typeahead)
 * - /api/ask           docs and content retrieval (Cloudflare AI Search), when configured
 * Everything else is served from ./public (the demo UI).
 */
import { createSuggestApiBrowserClient, SuggestApiError } from "@suggestapi/sdk/browser";
import type { SearchFilters, SearchMode } from "@suggestapi/sdk/browser";

export interface Env {
  ASSETS: Fetcher;
  /** SuggestAPI public (search) key. Set with `wrangler secret put SUGGESTAPI_PUBLIC_KEY`. */
  SUGGESTAPI_PUBLIC_KEY?: string;
  /** Logical SuggestAPI index that holds the product catalog. Defaults to "products". */
  SUGGESTAPI_INDEX?: string;
  /** Optional API base URL override. Defaults to https://api.suggestapi.com. */
  SUGGESTAPI_BASE_URL?: string;
  /** Optional Cloudflare AI Search instance binding for docs and content. */
  DOCS_SEARCH?: AiSearchInstance;
}

const MAX_QUERY_LENGTH = 200;
const SEARCH_MODES: readonly SearchMode[] = ["fts_only", "vector_only", "hybrid", "fts_rerank"];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    }

    try {
      switch (url.pathname) {
        case "/api/search":
          return await handleSearch(url, env);
        case "/api/autocomplete":
          return await handleAutocomplete(url, env);
        case "/api/ask":
          return await handleAsk(url, env);
        case "/api/health":
          return json({
            ok: true,
            productSearch: Boolean(env.SUGGESTAPI_PUBLIC_KEY),
            docsSearch: Boolean(env.DOCS_SEARCH)
          });
        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof BadRequest) {
        return json({ error: "bad_request", message: error.message }, 400);
      }
      if (error instanceof SuggestApiError) {
        return json(
          { error: "upstream_error", status: error.status, code: error.code, message: error.message },
          error.status >= 500 ? 502 : error.status
        );
      }
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

/** Ranked product search with optional mode and filters. */
async function handleSearch(url: URL, env: Env): Promise<Response> {
  const query = readQuery(url);
  const client = suggestApi(env);
  if (!client) return notConfigured("SUGGESTAPI_PUBLIC_KEY");

  const modeParam = url.searchParams.get("mode") ?? "hybrid";
  if (!SEARCH_MODES.includes(modeParam as SearchMode)) {
    throw new BadRequest(`mode must be one of ${SEARCH_MODES.join(", ")}`);
  }

  const result = await client.search.autocomplete({
    index: env.SUGGESTAPI_INDEX || "products",
    query,
    limit: readLimit(url, 12),
    mode: modeParam as SearchMode,
    filters: readFilters(url),
    userId: url.searchParams.get("user_id") ?? undefined
  });

  return json(result, 200, { "cache-control": "public, max-age=30" });
}

/** Fast prefix suggestions for a search-as-you-type box. */
async function handleAutocomplete(url: URL, env: Env): Promise<Response> {
  const query = readQuery(url);
  const client = suggestApi(env);
  if (!client) return notConfigured("SUGGESTAPI_PUBLIC_KEY");

  const result = await client.search.typeahead({
    index: env.SUGGESTAPI_INDEX || "products",
    query,
    limit: readLimit(url, 6)
  });

  return json(result, 200, { "cache-control": "public, max-age=60" });
}

/** Docs, policy, and help-center passages from a Cloudflare AI Search instance. */
async function handleAsk(url: URL, env: Env): Promise<Response> {
  const query = readQuery(url);
  if (!env.DOCS_SEARCH) return notConfigured("DOCS_SEARCH (ai_search binding)");

  const result = await env.DOCS_SEARCH.search({
    query,
    ai_search_options: {
      retrieval: { max_num_results: readLimit(url, 5) }
    }
  });

  return json({
    query: result.search_query,
    results: result.chunks.map((chunk) => ({
      id: chunk.id,
      source: chunk.item.key,
      title: typeof chunk.item.metadata?.title === "string" ? chunk.item.metadata.title : undefined,
      text: chunk.text,
      score: chunk.score
    }))
  });
}

function suggestApi(env: Env) {
  if (!env.SUGGESTAPI_PUBLIC_KEY) return null;
  return createSuggestApiBrowserClient({
    apiKey: env.SUGGESTAPI_PUBLIC_KEY,
    baseUrl: env.SUGGESTAPI_BASE_URL || undefined,
    // Bind fetch so it is not invoked with the SDK client as `this`.
    fetch: (input, init) => fetch(input, init)
  });
}

class BadRequest extends Error {}

function readQuery(url: URL): string {
  const query = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (!query) throw new BadRequest("q is required");
  if (query.length > MAX_QUERY_LENGTH) throw new BadRequest(`q must be ${MAX_QUERY_LENGTH} characters or fewer`);
  return query;
}

function readLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit)) throw new BadRequest("limit must be a number");
  return Math.min(Math.max(limit, 1), 50);
}

/** `filters` is a JSON object, e.g. {"category":["Pumps"],"price":{"gte":100,"lte":1000}}. */
function readFilters(url: URL): SearchFilters | undefined {
  const raw = url.searchParams.get("filters");
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SearchFilters;
  } catch {
    // fall through
  }
  throw new BadRequest("filters must be a JSON object");
}

function notConfigured(what: string): Response {
  return json({ error: "not_configured", message: `${what} is not configured` }, 501);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}
