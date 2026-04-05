import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Expose-Headers": "X-Cache, X-Cache-Age",
};

// Simple hash for cache key
async function hashQuery(query: string): Promise<string> {
  const data = new TextEncoder().encode(query);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Round bbox values to ~0.005 degree grid (~500m) so nearby requests share cache
function normalizeBbox(query: string): string {
  return query.replace(
    /(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)/g,
    (_match, s, w, n, e) => {
      const round = (v: string) => (Math.round(parseFloat(v) * 200) / 200).toFixed(3);
      return `${round(s)},${round(w)},${round(n)},${round(e)}`;
    }
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return new Response(JSON.stringify({ error: "Missing query" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalized = normalizeBbox(query);
    const cacheKey = await hashQuery(normalized);

    // Init Supabase with service role key (server-side, bypasses RLS)
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

    // Cache miss — fetch from Overpass with 20s timeout, one retry on 429
    const overpassUrl = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(normalized);
    let res: Response | null = null;
    const delays = [0, 3000];
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      try {
        res = await fetch(overpassUrl, { signal: ac.signal });
      } catch (e: unknown) {
        clearTimeout(timer);
        if (e instanceof Error && e.name === "AbortError") {
          return new Response(JSON.stringify({ error: "Overpass timeout" }), {
            status: 504,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw e;
      }
      clearTimeout(timer);
      if (res.status !== 429) break;
    }

    if (!res || !res.ok) {
      return new Response(JSON.stringify({ error: "Overpass error", status: res?.status }), {
        status: res?.status === 429 ? 429 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();

    // Store in cache (upsert)
    const { error: upsertError } = await sb.from("overpass_cache").upsert(
      {
        query_hash: cacheKey,
        response: data,
        created_at: new Date().toISOString(),
      },
      { onConflict: "query_hash" }
    );
    if (upsertError) {
      console.error("Cache upsert failed:", JSON.stringify(upsertError));
    }

    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "MISS",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
