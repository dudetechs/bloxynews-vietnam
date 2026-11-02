const CATEGORIES = ["news", "updates", "games", "studio", "vietnam"];
const STATUSES = ["pending", "approved", "rejected", "archived"];
const X_API = "https://api.x.com/2";
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const MAX_PAGES = 3;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json(request, env, { error: "Internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncAll(env).then(
        (results) => console.log("Cron sync:", JSON.stringify(results)),
        (err) => console.error("Cron sync failed:", err)
      )
    );
  },
};

/* ---------- helpers ---------- */

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(request, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? safeEqual(m[1], env.ADMIN_TOKEN) : false;
}

/* ---------- routing ---------- */

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (request.method === "GET" && path === "/api/x/posts") {
    return publicPosts(request, env, url);
  }

  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) {
      return json(request, env, { error: "Unauthorized" }, 401);
    }
    return adminRoute(request, env, url, path);
  }

  return json(request, env, { error: "Not found" }, 404);
}

async function publicPosts(request, env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "6", 10) || 6, 1), 30);
  const { results } = await env.DB.prepare(
    `SELECT post_id, author_username, author_name, text, created_at, category, media_json
       FROM x_posts WHERE status = 'approved'
      ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all();

  const posts = results.map((r) => {
    let media = [];
    try { media = JSON.parse(r.media_json); } catch { /* keep empty */ }
    return {
      post_id: r.post_id,
      author_username: r.author_username,
      author_name: r.author_name,
      text: r.text,
      created_at: r.created_at,
      category: r.category,
      media,
      url: `https://x.com/${r.author_username}/status/${r.post_id}`,
      embed_url: `https://twitter.com/${r.author_username}/status/${r.post_id}`,
    };
  });
  return json(request, env, { posts }, 200, { "Cache-Control": "public, max-age=60" });
}

async function adminRoute(request, env, url, path) {
  const m = request.method;
  let match;

  if (m === "GET" && path === "/api/admin/overview") {
    const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM x_posts GROUP BY status").all();
    const sources = await env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(enabled),0) AS enabled FROM x_sources"
    ).first();
    const recent = await env.DB.prepare(
      `SELECT post_id, author_username, status, category, reviewed_at
         FROM x_posts WHERE reviewed_at IS NOT NULL
        ORDER BY reviewed_at DESC LIMIT 10`
    ).all();
    const byStatus = { pending: 0, approved: 0, rejected: 0, archived: 0 };
    for (const r of counts.results) byStatus[r.status] = r.n;
    return json(request, env, { posts: byStatus, sources, recent: recent.results });
  }

  if (path === "/api/admin/sources") {
    if (m === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, username, display_name, enabled, last_sync_at, last_error
           FROM x_sources ORDER BY username COLLATE NOCASE`
      ).all();
      return json(request, env, { sources: results });
    }
    if (m === "POST") {
      const body = await readJson(request);
      const username = body && typeof body.username === "string" ? body.username.replace(/^@/, "").trim() : "";
      if (!USERNAME_RE.test(username)) {
        return json(request, env, { error: "Invalid X username" }, 400);
      }
      try {
        await env.DB.prepare("INSERT INTO x_sources (username) VALUES (?)").bind(username).run();
      } catch (err) {
        if (String(err.message || err).includes("UNIQUE")) {
          return json(request, env, { error: "Account already added" }, 409);
        }
        throw err;
      }
      return json(request, env, { ok: true }, 201);
    }
  }

  if ((match = path.match(/^\/api\/admin\/sources\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === "PATCH") {
      const body = await readJson(request);
      if (!body || typeof body.enabled !== "boolean") {
        return json(request, env, { error: "enabled (boolean) is required" }, 400);
      }
      const r = await env.DB.prepare("UPDATE x_sources SET enabled = ? WHERE id = ?")
        .bind(body.enabled ? 1 : 0, id).run();
      return r.meta.changes
        ? json(request, env, { ok: true })
        : json(request, env, { error: "Source not found" }, 404);
    }
    if (m === "DELETE") {
      const r = await env.DB.prepare("DELETE FROM x_sources WHERE id = ?").bind(id).run();
      return r.meta.changes
        ? json(request, env, { ok: true })
        : json(request, env, { error: "Source not found" }, 404);
    }
  }

  if (m === "POST" && path === "/api/admin/sync") {
    const results = await syncAll(env);
    return json(request, env, { results });
  }

  if (m === "GET" && path === "/api/admin/posts") {
    const status = url.searchParams.get("status") || "pending";
    if (!STATUSES.includes(status)) return json(request, env, { error: "Invalid status" }, 400);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const { results } = await env.DB.prepare(
      `SELECT id, post_id, author_username, author_name, text, created_at, url, status, category, imported_at
         FROM x_posts WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(status, limit).all();
    return json(request, env, { posts: results });
  }

  if ((match = path.match(/^\/api\/admin\/posts\/(\d+)$/)) && m === "PATCH") {
    const id = Number(match[1]);
    const body = await readJson(request);
    if (!body) return json(request, env, { error: "Invalid JSON body" }, 400);

    const post = await env.DB.prepare("SELECT status, category FROM x_posts WHERE id = ?").bind(id).first();
    if (!post) return json(request, env, { error: "Post not found" }, 404);

    const status = "status" in body ? body.status : post.status;
    let category = "category" in body ? body.category : post.category;
    if (category === "") category = null;

    if (!STATUSES.includes(status)) return json(request, env, { error: "Invalid status" }, 400);
    if (category !== null && !CATEGORIES.includes(category)) {
      return json(request, env, { error: "Invalid category" }, 400);
    }
    if (status === "approved" && !category) {
      return json(request, env, { error: "A category must be assigned before approval" }, 400);
    }

    await env.DB.prepare("UPDATE x_posts SET status = ?, category = ?, reviewed_at = ? WHERE id = ?")
      .bind(status, category, status === "pending" ? null : new Date().toISOString(), id).run();
    return json(request, env, { ok: true });
  }

  return json(request, env, { error: "Not found" }, 404);
}

/* ---------- X API import ---------- */

async function xGet(env, pathAndQuery) {
  const res = await fetch(X_API + pathAndQuery, {
    headers: {
      Authorization: `Bearer ${env.X_BEARER_TOKEN}`,
      "User-Agent": "BloxyNewsVN-Importer/1.0",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reset = res.headers.get("x-rate-limit-reset");
    const when = res.status === 429 && reset ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : "";
    throw new Error(`X API ${res.status}: ${body.title || body.detail || "request failed"}${when}`);
  }
  return body;
}

async function syncAll(env) {
  const { results: sources } = await env.DB.prepare("SELECT * FROM x_sources WHERE enabled = 1").all();
  const out = [];
  for (const src of sources) {
    try {
      const imported = await syncSource(env, src);
      out.push({ username: src.username, imported, error: null });
    } catch (err) {
      const message = String(err && err.message ? err.message : err).slice(0, 500);
      console.error(`Sync failed for @${src.username}:`, message);
      await env.DB.prepare("UPDATE x_sources SET last_error = ? WHERE id = ?").bind(message, src.id).run();
      out.push({ username: src.username, imported: 0, error: message });
    }
  }
  return out;
}

async function syncSource(env, src) {
  if (!env.X_BEARER_TOKEN) throw new Error("X_BEARER_TOKEN is not configured");

  let userId = src.user_id;
  let displayName = src.display_name;
  if (!userId) {
    const u = await xGet(env, `/users/by/username/${encodeURIComponent(src.username)}?user.fields=name,username`);
    if (!u.data) throw new Error(`X account not found: @${src.username}`);
    userId = u.data.id;
    displayName = u.data.name;
    await env.DB.prepare("UPDATE x_sources SET user_id = ?, display_name = ? WHERE id = ?")
      .bind(userId, displayName, src.id).run();
  }

  const sinceId = src.last_since_id;
  let newest = sinceId ? BigInt(sinceId) : 0n;
  let token = null;
  let page = 0;
  let imported = 0;

  do {
    const params = new URLSearchParams({
      max_results: sinceId ? "100" : "10",
      exclude: "retweets,replies",
      "tweet.fields": "created_at,attachments,note_tweet",
      expansions: "attachments.media_keys",
      "media.fields": "type,url,preview_image_url,width,height,alt_text",
    });
    if (sinceId) params.set("since_id", sinceId);
    if (token) params.set("pagination_token", token);

    const res = await xGet(env, `/users/${userId}/tweets?${params}`);
    const posts = res.data || [];
    const media = new Map((res.includes && res.includes.media || []).map((x) => [x.media_key, x]));

    const stmts = posts.map((t) => {
      const mediaArr = ((t.attachments && t.attachments.media_keys) || [])
        .map((k) => media.get(k))
        .filter(Boolean)
        .map((x) => ({
          type: x.type,
          url: x.url || null,
          preview_image_url: x.preview_image_url || null,
          alt_text: x.alt_text || null,
        }));
      return env.DB.prepare(
        `INSERT OR IGNORE INTO x_posts
           (post_id, source_id, author_username, author_name, text, created_at, url, media_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.id,
        src.id,
        src.username,
        displayName || src.username,
        (t.note_tweet && t.note_tweet.text) || t.text,
        t.created_at || null,
        `https://x.com/${src.username}/status/${t.id}`,
        JSON.stringify(mediaArr)
      );
    });

    if (stmts.length) {
      const batch = await env.DB.batch(stmts);
      imported += batch.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
    }
    for (const t of posts) {
      const id = BigInt(t.id);
      if (id > newest) newest = id;
    }

    token = sinceId && res.meta && res.meta.next_token ? res.meta.next_token : null;
    page++;
  } while (token && page < MAX_PAGES);

  await env.DB.prepare(
    "UPDATE x_sources SET last_since_id = ?, last_sync_at = ?, last_error = NULL WHERE id = ?"
  ).bind(newest > 0n ? String(newest) : null, new Date().toISOString(), src.id).run();

  return imported;
}