import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Expose-Headers": "X-Cache, X-Cache-Age, X-Cache-Key, X-Cache-Write",
};

async function hashQuery(query: string): Promise<string> {
  const data = new TextEncoder().encode(query);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Round bbox values to ~0.01 degree grid (~1km) so nearby requests share cache
function normalizeBbox(query: string): string {
  return query.replace(
    /(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)/g,
    (_match, s, w, n, e) => {
      const round = (v: string) => (Math.round(parseFloat(v) * 100) / 100).toFixed(2);
      return `${round(s)},${round(w)},${round(n)},${round(e)}`;
    }
  );
}

async function fetchOverpass(normalized: string): Promise<{ data?: unknown; error?: string; status?: number }> {
  const overpassUrl = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(normalized);
  const delays = [0, 3000];
  let res: Response | null = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      res = await fetch(overpassUrl, { signal: ac.signal });
    } catch (e: unknown) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === "AbortError") {
        return { error: "Overpass timeout", status: 504 };
      }
      throw e;
    }
    clearTimeout(timer);
    if (res.status !== 429) break;
  }
  if (!res || !res.ok) {
    const upstream = res?.status || 502;
    return { error: "Overpass error", status: upstream === 429 ? 429 : upstream >= 500 ? upstream : 502 };
  }
  return { data: await res.json() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // --- Batch mode: { queries: [{ id, query }] } ---
    if (Array.isArray(body.queries)) {
      return handleBatch(body.queries);
    }

    // --- Single query mode (backwards compatible) ---
    return handleSingle(body.query);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function handleBatch(queries: { id: string; query: string }[]) {
  if (!queries.length || queries.length > 20) {
    return new Response(JSON.stringify({ error: "queries must be 1-20 items" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Normalize all queries and compute cache keys
  const items = await Promise.all(queries.map(async (q) => {
    const normalized = normalizeBbox(q.query);
    const cacheKey = await hashQuery(normalized);
    return { id: q.id, query: q.query, normalized, cacheKey };
  }));

  // Batch cache lookup: fetch all keys at once
  const cacheKeys = items.map((i) => i.cacheKey);
  const { data: cachedRows, error: cacheError } = await sb
    .from("overpass_cache")
    .select("query_hash, response, created_at")
    .in("query_hash", cacheKeys);

  if (cacheError) {
    console.error("Batch cache read failed:", JSON.stringify(cacheError));
  }

  const cacheMap = new Map<string, { response: unknown; created_at: string }>();
  if (cachedRows) {
    for (const row of cachedRows) {
      const age = Date.now() - new Date(row.created_at).getTime();
      if (age < CACHE_TTL_MS) {
        cacheMap.set(row.query_hash, row);
      }
    }
  }

  // Stream NDJSON: all cache hits first (instant), then misses sequentially
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const misses: typeof items = [];

      // Phase 1: emit all cache hits immediately
      for (const item of items) {
        const cached = cacheMap.get(item.cacheKey);
        if (cached) {
          const age = Math.round((Date.now() - new Date(cached.created_at).getTime()) / 1000);
          const line = JSON.stringify({
            id: item.id,
            cache: "HIT",
            age,
            data: cached.response,
          }) + "\n";
          controller.enqueue(encoder.encode(line));
        } else {
          misses.push(item);
        }
      }

      // Phase 2: fetch misses from Overpass sequentially
      for (const item of misses) {
        const result = await fetchOverpass(item.normalized);
        if (result.error) {
          const line = JSON.stringify({
            id: item.id,
            cache: "MISS",
            error: result.error,
            status: result.status,
          }) + "\n";
          controller.enqueue(encoder.encode(line));
          continue;
        }

        // Cache the result
        const { error: upsertError } = await sb.from("overpass_cache").upsert(
          {
            query_hash: item.cacheKey,
            response: result.data,
            created_at: new Date().toISOString(),
          },
          { onConflict: "query_hash" }
        );
        if (upsertError) {
          console.error("Cache upsert failed:", JSON.stringify(upsertError));
        }

        const line = JSON.stringify({
          id: item.id,
          cache: "MISS",
          data: result.data,
          write: upsertError ? "FAIL" : "OK",
        }) + "\n";
        controller.enqueue(encoder.encode(line));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    },
  });
}

async function handleSingle(query: unknown) {
  if (!query || typeof query !== "string") {
    return new Response(JSON.stringify({ error: "Missing query" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const normalized = normalizeBbox(query);
  const cacheKey = await hashQuery(normalized);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Check cache
  const { data: cached, error: cacheError } = await sb
    .from("overpass_cache")
    .select("response, created_at")
    .eq("query_hash", cacheKey)
    .maybeSingle();

  if (cacheError) {
    console.error("Cache read failed:", JSON.stringify(cacheError));
  }

  if (cached) {
    const age = Date.now() - new Date(cached.created_at).getTime();
    if (age < CACHE_TTL_MS) {
      return new Response(JSON.stringify(cached.response), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Cache": "HIT",
          "X-Cache-Age": String(Math.round(age / 1000)),
        },
      });
    }
  }

  const result = await fetchOverpass(normalized);
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status || 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Store in cache
  const { error: upsertError } = await sb.from("overpass_cache").upsert(
    {
      query_hash: cacheKey,
      response: result.data,
      created_at: new Date().toISOString(),
    },
    { onConflict: "query_hash" }
  );
  if (upsertError) {
    console.error("Cache upsert failed:", JSON.stringify(upsertError));
  }

  return new Response(JSON.stringify(result.data), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": "MISS",
      "X-Cache-Key": cacheKey.substring(0, 12),
      "X-Cache-Write": upsertError ? "FAIL:" + upsertError.message : "OK",
    },
  });
}
