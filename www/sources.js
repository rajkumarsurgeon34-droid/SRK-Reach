/* SRK Reach — sources.
 * Each source reads a link or searches one platform, straight from the phone.
 * Inside the Android app, fetch() goes through Capacitor's native HTTP (no CORS limits).
 * Ideas and free backends adapted from Agent Reach (github.com/Panniantong/Agent-Reach, MIT).
 *
 * Every function returns a list of items: { title, url, author, date, text, source, meta }
 */
(function () {
  "use strict";

  const UA_PHONE = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
  const UA_REDDIT = "android:com.shazverse.srkreach:v1.0 (SRK Reach app)";
  const MAX_TEXT = 60000;

  // ---------- helpers ----------
  function withTimeout(promise, ms, label) {
    let t;
    return Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " took too long — check your internet and try again.")), ms); }),
    ]).finally(() => clearTimeout(t));
  }

  async function http(url, opts = {}, ms = 30000) {
    const host = new URL(url).hostname.replace(/^www\./, "");
    let res;
    try {
      res = await withTimeout(fetch(url, opts), ms, host);
    } catch (e) {
      if (/too long/.test(e.message)) throw e;
      throw new Error("Couldn't reach " + host + " — check your internet.");
    }
    if (!res.ok) {
      const err = new Error(host + " answered " + res.status + (res.status === 429 ? " (too many requests — wait a minute)" : res.status === 403 ? " (blocked)" : res.status === 404 ? " (not found)" : ""));
      err.status = res.status;
      throw err;
    }
    return res;
  }
  const getText = async (url, opts, ms) => (await http(url, opts, ms)).text();
  const getJSON = async (url, opts, ms) => JSON.parse(await getText(url, opts, ms));

  const decoder = document.createElement("textarea");
  function decodeEntities(s) { decoder.innerHTML = s || ""; return decoder.value; }
  function stripHtml(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n"), "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  const clip = (s) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n\n… (cut short)" : s || "");
  const fmtNum = (n) => (n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const dateOf = (secs) => (secs ? new Date(secs * 1000).toISOString().slice(0, 10) : "");
  const item = (o) => ({ title: "", url: "", author: "", date: "", text: "", meta: "", ...o, text: clip(o.text) });

  function isUrl(s) { return /^https?:\/\/\S+$/i.test(s.trim()) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(s.trim()); }
  function normUrl(s) { s = s.trim(); return /^https?:\/\//i.test(s) ? s : "https://" + s; }

  // ---------- Web: Exa (free hosted search, no key) + Jina Reader ----------
  async function exa(tool, args) {
    const raw = await getText("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    }, 40000);
    const datas = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    let msg;
    try { msg = JSON.parse(datas.length ? datas[datas.length - 1] : raw); } catch { throw new Error("Web search gave an unreadable answer — try again."); }
    const limitHit = (t) => /\b429\b|rate.?limit|too many requests|quota/i.test(t);
    if (msg.error) {
      const t = String(msg.error.message || JSON.stringify(msg.error));
      throw new Error(limitHit(t) ? "Free web search limit reached — wait a few minutes and try again." : "Web search error: " + t);
    }
    const result = msg.result || {};
    const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (result.isError) throw new Error(limitHit(text) ? "Free web search limit reached — wait a few minutes and try again." : "Web search error: " + text.slice(0, 200));
    return text;
  }
  function parseExa(text) {
    const out = [];
    for (let block of ("\n" + text.trim()).split(/\n(?=Title: )/)) {
      block = block.trim();
      if (!block.startsWith("Title:")) continue;
      const lines = block.split("\n");
      const f = {};
      let i = 0;
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^(Title|URL|Published|Author):\s*(.*)$/);
        if (!m) break;
        f[m[1].toLowerCase()] = m[2].trim();
      }
      const body = lines.slice(i).map((l) => l.replace(/^\s*(Highlights|Text):\s*/, "")).join("\n").trim();
      const na = (v) => (!v || v === "N/A" ? "" : v);
      out.push(item({ title: na(f.title), url: na(f.url), author: na(f.author), date: na(f.published).slice(0, 10), text: body, source: "web" }));
    }
    return out;
  }
  async function webSearch(q, limit = 8) {
    const items = parseExa(await exa("web_search_exa", { query: q, objective: q, numResults: limit }));
    if (!items.length) throw new Error("No web results found.");
    return items.slice(0, limit);
  }
  function looksBlocked(body) {
    const s = body.slice(0, 4000).toLowerCase();
    return (s.includes("warning:") && s.includes("requiring captcha")) || s.includes("attention required! | cloudflare") || s.includes("just a moment...");
  }
  async function jinaRead(url) {
    const body = await getText("https://r.jina.ai/" + url, { headers: { "Accept": "text/plain", "User-Agent": UA_PHONE } }, 45000);
    if (looksBlocked(body)) throw new Error("That site showed a bot-check page.");
    const title = (body.match(/^Title:\s*(.*)$/m) || [])[1] || "";
    const pub = (body.match(/^Published Time:\s*(.*)$/m) || [])[1] || "";
    const content = body.includes("Markdown Content:") ? body.split("Markdown Content:").slice(1).join("Markdown Content:") : body;
    return item({ title: title.trim(), url, date: pub.slice(0, 10), text: content.trim(), source: "web" });
  }
  async function webRead(url) {
    try {
      return [await jinaRead(url)];
    } catch (e1) {
      try {
        const text = await exa("web_fetch_exa", { urls: [url], maxCharacters: 20000 });
        const items = parseExa(text);
        if (items.length) { items[0].url = items[0].url || url; return items.slice(0, 1); }
        if (text.trim()) return [item({ url, text: text.trim(), source: "web" })];
      } catch (e2) { /* fall through */ }
      throw new Error("Couldn't read this page (" + e1.message + ")");
    }
  }
  const siteSearch = (site, label) => async (q, limit) => (await webSearch(q + " site:" + site, limit)).map((x) => ({ ...x, source: label }));

  // ---------- YouTube ----------
  function ytId(url) {
    const m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  const YT_WEB = { clientName: "WEB", clientVersion: "2.20251120.01.00", hl: "en", gl: "IN" };
  function walk(node, key, out) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const n of node) walk(n, key, out); return out; }
    for (const k in node) { if (k === key) out.push(node[k]); else walk(node[k], key, out); }
    return out;
  }
  const runs = (t) => (t ? t.simpleText || (t.runs || []).map((r) => r.text).join("") : "");
  async function ytSearch(q, limit = 10) {
    const j = await getJSON("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA_PHONE },
      body: JSON.stringify({ context: { client: YT_WEB }, query: q }),
    });
    const vids = walk(j, "videoRenderer", []).filter((v) => v.videoId).slice(0, limit);
    if (!vids.length) throw new Error("No YouTube videos found.");
    return vids.map((v) => item({
      title: runs(v.title), url: "https://www.youtube.com/watch?v=" + v.videoId,
      author: runs(v.ownerText), date: runs(v.publishedTimeText),
      meta: [runs(v.lengthText), runs(v.viewCountText)].filter(Boolean).join(" · "),
      text: (v.detailedMetadataSnippets || []).map((s) => runs(s.snippetText)).join(" ") || runs(v.descriptionSnippet),
      source: "youtube",
    }));
  }
  function parseCaptions(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    let nodes = Array.from(doc.getElementsByTagName("text"));
    if (!nodes.length) nodes = Array.from(doc.getElementsByTagName("p"));
    const lines = [];
    for (const n of nodes) {
      const t = decodeEntities((n.textContent || "").replace(/\s+/g, " ").trim());
      if (t && t !== lines[lines.length - 1]) lines.push(t);
    }
    // join into readable paragraphs of ~8 caption lines
    const paras = [];
    for (let i = 0; i < lines.length; i += 8) paras.push(lines.slice(i, i + 8).join(" "));
    return paras.join("\n\n");
  }
  async function ytRead(url, lang = "en") {
    const id = ytId(url);
    if (!id) throw new Error("That doesn't look like a YouTube video link.");
    const html = await getText("https://www.youtube.com/watch?v=" + id, { headers: { "User-Agent": UA_PHONE, "Accept-Language": "en-US,en;q=0.9" } });
    const key = (html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
    let player = null;
    if (key) {
      try {
        player = await getJSON("https://www.youtube.com/youtubei/v1/player?key=" + key, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId: id }),
        });
      } catch (e) { player = null; }
    }
    if (!player) {
      const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script>)/s);
      if (m) try { player = JSON.parse(m[1]); } catch { /* ignore */ }
    }
    if (!player) throw new Error("YouTube didn't return this video's details.");
    const d = player.videoDetails || {};
    const header = item({
      title: d.title || "YouTube video", url: "https://www.youtube.com/watch?v=" + id, author: d.author || "",
      meta: [d.lengthSeconds ? Math.round(d.lengthSeconds / 60) + " min" : "", d.viewCount ? fmtNum(+d.viewCount) + " views" : ""].filter(Boolean).join(" · "),
      source: "youtube",
    });
    const tracks = (((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    const rank = (t) => (t.languageCode === lang ? 0 : t.languageCode.startsWith(lang) ? 1 : t.languageCode === "en" ? 2 : 3) * 2 + (t.kind === "asr" ? 1 : 0);
    tracks.sort((a, b) => rank(a) - rank(b));
    let transcript = "", note = "";
    for (const t of tracks.slice(0, 3)) {
      if (/[&?]exp=xpe/.test(t.baseUrl)) { note = "YouTube is locking captions for this video right now."; continue; }
      try {
        transcript = parseCaptions(await getText(t.baseUrl.replace("&fmt=srv3", ""), { headers: { "User-Agent": UA_PHONE } }));
        if (transcript) { header.meta += (header.meta ? " · " : "") + "captions: " + (runs(t.name) || t.languageCode); break; }
      } catch (e) { note = "Captions couldn't be downloaded."; }
    }
    if (!tracks.length) note = "This video has no captions.";
    header.text = transcript
      ? "TRANSCRIPT\n\n" + transcript + (d.shortDescription ? "\n\n— — —\nDESCRIPTION\n\n" + d.shortDescription : "")
      : (note ? "⚠️ " + note + " Showing the description instead.\n\n" : "") + (d.shortDescription || "(no description)");
    return [header];
  }

  // ---------- Reddit ----------
  const RH = { headers: { "User-Agent": UA_REDDIT, "Accept": "application/json" } };
  function redditPost(p) {
    return item({
      title: p.title || "", url: "https://www.reddit.com" + (p.permalink || ""),
      author: (p.subreddit_name_prefixed || "") + (p.author ? " · u/" + p.author : ""),
      date: dateOf(p.created_utc), meta: "▲ " + fmtNum(p.score) + " · 💬 " + fmtNum(p.num_comments),
      text: p.selftext || (p.url && !p.is_self ? "Link: " + p.url : ""), source: "reddit",
    });
  }
  async function redditSearch(q, limit = 10) {
    const sub = q.trim().match(/^r\/([A-Za-z0-9_]+)$/);
    try {
      const url = sub
        ? "https://www.reddit.com/r/" + sub[1] + "/hot.json?raw_json=1&limit=" + limit
        : "https://www.reddit.com/search.json?raw_json=1&sort=relevance&limit=" + limit + "&q=" + encodeURIComponent(q);
      const j = await getJSON(url, RH);
      const posts = ((j.data || {}).children || []).map((c) => c.data).filter((p) => !p.stickied || sub);
      if (!posts.length) throw new Error("No Reddit posts found.");
      return posts.slice(0, limit).map(redditPost);
    } catch (e) {
      if (e.status === 403 || e.status === 429) return (await webSearch(q + " site:reddit.com", limit)).map((x) => ({ ...x, source: "reddit", meta: "via web search (Reddit blocked direct access)" }));
      throw e;
    }
  }
  async function redditRead(url) {
    const u = new URL(normUrl(url));
    u.hostname = "www.reddit.com";
    const path = u.pathname.replace(/\/$/, "");
    if (/^\/r\/[^/]+$/.test(path)) return redditSearch("r/" + path.split("/")[2], 15);
    try {
      const j = await getJSON("https://www.reddit.com" + path + ".json?raw_json=1&limit=40", RH);
      const post = j[0].data.children[0].data;
      const out = redditPost(post);
      const lines = [];
      const addComments = (children, depth) => {
        for (const c of children || []) {
          if (c.kind !== "t1" || !c.data.body || lines.length > 120) continue;
          lines.push("  ".repeat(depth) + "• u/" + c.data.author + " (▲" + fmtNum(c.data.score) + "): " + c.data.body.replace(/\n+/g, " "));
          if (depth < 2 && c.data.replies && c.data.replies.data) addComments(c.data.replies.data.children, depth + 1);
        }
      };
      addComments(j[1].data.children, 0);
      out.text = (out.text ? out.text + "\n\n" : "") + (lines.length ? "— — —\nTOP COMMENTS\n\n" + lines.join("\n\n") : "");
      return [out];
    } catch (e) {
      if (e.status === 403 || e.status === 429) {
        const r = await jinaRead("https://old.reddit.com" + path + "/");
        r.source = "reddit";
        return [r];
      }
      throw e;
    }
  }

  // ---------- GitHub ----------
  function ghHeaders(extra) {
    const h = { "User-Agent": "SRK-Reach", "Accept": "application/vnd.github+json", ...(extra || {}) };
    const tok = (window.SRK_SETTINGS && window.SRK_SETTINGS().githubToken) || "";
    if (tok) h.Authorization = "Bearer " + tok;
    return { headers: h };
  }
  async function gh(path, extra) {
    try { return await getJSON("https://api.github.com" + path, ghHeaders(extra)); }
    catch (e) {
      if (e.status === 403 || e.status === 429) throw new Error("GitHub's free limit (60 an hour) was reached — wait, or add a GitHub token in Settings.");
      throw e;
    }
  }
  async function githubSearch(q, limit = 10) {
    const j = await gh("/search/repositories?per_page=" + limit + "&q=" + encodeURIComponent(q));
    if (!(j.items || []).length) throw new Error("No GitHub repos found.");
    return j.items.map((r) => item({
      title: r.full_name, url: r.html_url, author: r.owner && r.owner.login,
      date: (r.pushed_at || "").slice(0, 10), meta: "★ " + fmtNum(r.stargazers_count) + (r.language ? " · " + r.language : "") + (r.license && r.license.spdx_id && r.license.spdx_id !== "NOASSERTION" ? " · " + r.license.spdx_id : ""),
      text: r.description || "", source: "github",
    }));
  }
  async function githubRead(url) {
    const m = new URL(normUrl(url)).pathname.match(/^\/([^/]+)\/([^/]+)(?:\/(issues|pull)\/(\d+))?/);
    if (!m) throw new Error("Open a repo, issue or pull-request link from GitHub.");
    const [, owner, repoRaw, kind, num] = m;
    const repo = repoRaw.replace(/\.git$/, "");
    if (kind) {
      const is = await gh("/repos/" + owner + "/" + repo + "/issues/" + num);
      let comments = [];
      try { comments = await gh("/repos/" + owner + "/" + repo + "/issues/" + num + "/comments?per_page=50"); } catch { /* ignore */ }
      return [item({
        title: "#" + num + " " + is.title, url: is.html_url, author: is.user && is.user.login, date: (is.created_at || "").slice(0, 10),
        meta: (kind === "pull" ? "Pull request" : "Issue") + " · " + is.state + " · 💬 " + is.comments,
        text: (is.body || "") + (comments.length ? "\n\n— — —\nCOMMENTS\n\n" + comments.map((c) => "• " + c.user.login + ": " + c.body).join("\n\n") : ""),
        source: "github",
      })];
    }
    const r = await gh("/repos/" + owner + "/" + repo);
    let readme = "";
    try { readme = await getText("https://api.github.com/repos/" + owner + "/" + repo + "/readme", ghHeaders({ Accept: "application/vnd.github.raw" })); } catch { /* no readme */ }
    return [item({
      title: r.full_name, url: r.html_url, author: r.owner && r.owner.login, date: (r.pushed_at || "").slice(0, 10),
      meta: "★ " + fmtNum(r.stargazers_count) + " · forks " + fmtNum(r.forks_count) + (r.language ? " · " + r.language : "") + (r.license && r.license.spdx_id ? " · " + r.license.spdx_id : ""),
      text: (r.description ? r.description + "\n\n" : "") + (readme ? "— — —\nREADME\n\n" + readme : ""),
      source: "github",
    })];
  }

  // ---------- X / Twitter (read via the free FxTwitter API; search via web) ----------
  async function xRead(url) {
    const p = new URL(normUrl(url)).pathname;
    const st = p.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
    if (st) {
      const j = await getJSON("https://api.fxtwitter.com/" + st[1] + "/status/" + st[2], { headers: { "User-Agent": "SRK-Reach" } });
      const t = j.tweet;
      if (!t) throw new Error("Couldn't load that post (it may be private or deleted).");
      const media = ((t.media || {}).all || []).map((m) => (m.type === "photo" ? "🖼 " : "🎬 ") + m.url);
      const q = t.quote ? "\n\n— Quoting @" + t.quote.author.screen_name + ": " + t.quote.text : "";
      return [item({
        title: t.author.name + " (@" + t.author.screen_name + ")", url: t.url, author: "@" + t.author.screen_name,
        date: t.created_timestamp ? dateOf(t.created_timestamp) : "",
        meta: "♥ " + fmtNum(t.likes) + " · 🔁 " + fmtNum(t.retweets) + " · 💬 " + fmtNum(t.replies),
        text: t.text + q + (media.length ? "\n\n" + media.join("\n") : ""), source: "x",
      })];
    }
    const user = p.split("/")[1];
    if (!user) throw new Error("Open a post or profile link from X.");
    const j = await getJSON("https://api.fxtwitter.com/" + user, { headers: { "User-Agent": "SRK-Reach" } });
    const u = j.user;
    if (!u) throw new Error("Couldn't find that X account.");
    return [item({
      title: u.name + " (@" + u.screen_name + ")", url: u.url, author: "@" + u.screen_name,
      meta: fmtNum(u.followers) + " followers · " + fmtNum(u.tweets) + " posts",
      text: (u.description || "") + (u.location ? "\n\n📍 " + u.location : "") + (u.website && u.website.url ? "\n🔗 " + u.website.url : ""), source: "x",
    })];
  }

  // ---------- RSS / Atom ----------
  async function rssRead(url) {
    const xml = await getText(url, { headers: { "User-Agent": UA_PHONE } });
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("That link isn't an RSS/Atom feed.");
    const pick = (el, ...tags) => { for (const t of tags) { const n = el.getElementsByTagName(t)[0]; if (n) return n.textContent.trim(); } return ""; };
    const feedTitle = pick(doc.documentElement, "title");
    const entries = Array.from(doc.getElementsByTagName("item")).concat(Array.from(doc.getElementsByTagName("entry")));
    if (!entries.length) throw new Error("This feed has no posts.");
    return entries.slice(0, 30).map((e) => {
      const linkEl = e.getElementsByTagName("link")[0];
      const link = linkEl ? (linkEl.getAttribute("href") || linkEl.textContent.trim()) : "";
      const d = pick(e, "pubDate", "published", "updated", "dc:date");
      const dt = d ? new Date(d) : null;
      return item({
        title: decodeEntities(pick(e, "title")), url: link, author: feedTitle,
        date: dt && !isNaN(dt) ? dt.toISOString().slice(0, 10) : "",
        text: stripHtml(pick(e, "content:encoded", "description", "summary", "content")), source: "rss",
      });
    });
  }

  // ---------- Bilibili & V2EX (links only) ----------
  async function bilibiliRead(url) {
    const bv = (url.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
    if (!bv) return webRead(url);
    const j = await getJSON("https://api.bilibili.com/x/web-interface/view?bvid=" + bv, { headers: { "User-Agent": UA_PHONE, "Referer": "https://www.bilibili.com/" } });
    const d = j.data;
    if (!d) throw new Error("Bilibili: " + (j.message || "video not found"));
    return [item({
      title: d.title, url: "https://www.bilibili.com/video/" + bv, author: d.owner && d.owner.name, date: dateOf(d.pubdate),
      meta: "▶ " + fmtNum(d.stat.view) + " · 👍 " + fmtNum(d.stat.like) + " · " + Math.round(d.duration / 60) + " min",
      text: d.desc || "", source: "bilibili",
    })];
  }
  async function v2exRead(url) {
    const id = (url.match(/\/t\/(\d+)/) || [])[1];
    if (!id) return webRead(url);
    const [t] = await getJSON("https://www.v2ex.com/api/topics/show.json?id=" + id);
    let replies = [];
    try { replies = await getJSON("https://www.v2ex.com/api/replies/show.json?topic_id=" + id); } catch { /* ignore */ }
    return [item({
      title: t.title, url: t.url, author: t.member && t.member.username, date: dateOf(t.created), meta: "💬 " + t.replies,
      text: (t.content || "") + (replies.length ? "\n\n— — —\nREPLIES\n\n" + replies.slice(0, 60).map((r) => "• " + r.member.username + ": " + r.content).join("\n\n") : ""),
      source: "v2ex",
    })];
  }

  // ---------- routing ----------
  const SOURCES = {
    web: { label: "Web", icon: "🌐", search: webSearch, read: webRead, hint: "Search the web or paste any link" },
    youtube: { label: "YouTube", icon: "▶️", search: ytSearch, read: ytRead, hint: "Search videos or paste a video link for its transcript" },
    reddit: { label: "Reddit", icon: "👽", search: redditSearch, read: redditRead, hint: "Search Reddit, type r/name, or paste a post link" },
    github: { label: "GitHub", icon: "🐙", search: githubSearch, read: githubRead, hint: "Search repos or paste a repo / issue link" },
    x: { label: "X", icon: "𝕏", search: siteSearch("x.com", "x"), read: xRead, hint: "Paste a post or profile link (search uses the web)" },
    rss: { label: "RSS", icon: "📰", search: null, read: rssRead, hint: "Paste an RSS or Atom feed link" },
  };
  const EXTRA = { bilibili: { label: "Bilibili", icon: "📺" }, v2ex: { label: "V2EX", icon: "💬" } };

  function detect(url) {
    const h = new URL(url).hostname.replace(/^(www|m|old|mobile)\./, "");
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "youtube";
    if (/(^|\.)reddit\.com$|^redd\.it$/.test(h)) return "reddit";
    if (h === "github.com") return "github";
    if (/^(x|twitter|fxtwitter|vxtwitter)\.com$/.test(h)) return "x";
    if (/(^|\.)bilibili\.com$|^b23\.tv$/.test(h)) return "bilibili";
    if (h === "v2ex.com") return "v2ex";
    if (/(\/feed\/?$|\/rss\/?$|\.rss$|\.xml$|\/atom\/?$|feeds\.)/i.test(url)) return "rss";
    return "web";
  }

  async function run(input, source) {
    input = input.trim();
    if (!input) throw new Error("Type something to search, or paste a link.");
    if (isUrl(input)) {
      const url = normUrl(input);
      const kind = source === "rss" ? "rss" : detect(url);
      const reader = { bilibili: bilibiliRead, v2ex: v2exRead }[kind] || SOURCES[kind].read;
      return { mode: "read", source: kind, items: await reader(url) };
    }
    const src = SOURCES[source] || SOURCES.web;
    if (!src.search) throw new Error(src.label + " needs a link — paste a feed URL.");
    return { mode: "search", source, items: await src.search(input, 10) };
  }

  // Quick health check of every source — like `agent-reach doctor`.
  const CHECKS = [
    ["web", "Web search (Exa)", () => webSearch("Bailey and Love surgery textbook", 1)],
    ["web", "Web reader (Jina)", () => jinaRead("https://example.com")],
    ["youtube", "YouTube search", () => ytSearch("laparoscopic cholecystectomy", 1)],
    ["youtube", "YouTube transcripts", () => ytRead("https://www.youtube.com/watch?v=jNQXAC9IVRw").then((r) => { if (!/^TRANSCRIPT/.test(r[0].text)) throw new Error("details work, captions didn't"); return r; })],
    ["reddit", "Reddit", () => getJSON("https://www.reddit.com/r/medicine/hot.json?limit=1", RH)],
    ["github", "GitHub", () => gh("/repos/Panniantong/Agent-Reach")],
    ["x", "X posts (FxTwitter)", () => getJSON("https://api.fxtwitter.com/jack/status/20", { headers: { "User-Agent": "SRK-Reach" } })],
    ["rss", "RSS feeds", () => rssRead("https://hnrss.org/frontpage")],
  ];

  window.SRKReach = { SOURCES, EXTRA, run, isUrl, detect, CHECKS };
})();
