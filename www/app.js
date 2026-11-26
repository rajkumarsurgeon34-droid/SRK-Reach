/* SRK Reach — give yourself (and your AI) eyes on the internet.
 * Search or read Web, YouTube, Reddit, GitHub, X and RSS from one box, then summarise or ask with AI.
 * ShazVerse Technologies. Reading ideas adapted from Agent Reach (Panniantong, MIT).
 */
(function () {
  "use strict";
  const R = window.SRKReach;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
  const DEEPSEEK_BASE = "https://api.deepseek.com";
  const GEMINI_DEFAULT = "gemini-3.8-flash";
  const GEMINI_BACKUP = "gemini-3.5-flash-lite";
  const DEEPSEEK_DEFAULT = "deepseek-flash";
  const STORE = "srkreach.v1";

  // ---------- state ----------
  const defaults = { provider: "gemini", geminiKey: "", geminiModel: "", deepseekKey: "", deepseekModel: "", githubToken: "", capLang: "en", aiLang: "English", font: "18" };
  let state = { settings: { ...defaults }, history: [], source: "web" };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (s) state = { ...state, ...s, settings: { ...defaults, ...(s.settings || {}) } };
  } catch { /* fresh start */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* ignore */ } };
  window.SRK_SETTINGS = () => state.settings;
  const applyFont = () => document.documentElement.style.setProperty("--fs", (state.settings.font || "18") + "px");
  applyFont();

  // ---------- navigation (Android back button walks back through views) ----------
  const stack = ["v-home"];
  function show(id, push = true) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
    if (push && stack[stack.length - 1] !== id) { stack.push(id); history.pushState({ v: id }, ""); }
  }
  function back() { history.back(); }
  window.addEventListener("popstate", () => {
    if (stack.length > 1) stack.pop();
    show(stack[stack.length - 1], false);
  });
  document.querySelectorAll(".back").forEach((b) => b.addEventListener("click", back));

  // ---------- small UI helpers ----------
  let busy = 0;
  function loading(on, text) {
    busy += on ? 1 : -1;
    if (busy < 0) busy = 0;
    $("loading").classList.toggle("hidden", busy === 0);
    if (text) $("loading-text").textContent = text;
  }
  let toastT;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    toast("Copied");
  }
  const openUrl = (u) => { if (u) window.open(u, "_blank"); };
  const srcInfo = (k) => R.SOURCES[k] || R.EXTRA[k] || R.SOURCES.web;

  // Tiny markdown → HTML for AI answers (bold, italics, headings, bullets, numbered lists, code, links, [n] cites).
  function md(text) {
    const lines = esc(text || "").split("\n");
    let html = "", list = null;
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\[(\d{1,2})\]/g, '<a href="#" data-cite="$1">[$1]</a>');
    const close = () => { if (list) { html += "</" + list + ">"; list = null; } };
    for (const raw of lines) {
      const l = raw.trimEnd();
      let m;
      if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); html += "<h3>" + inline(m[1]) + "</h3>"; }
      else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); list = "ul"; html += "<ul>"; } html += "<li>" + inline(m[1]) + "</li>"; }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); list = "ol"; html += "<ol>"; } html += "<li>" + inline(m[1]) + "</li>"; }
      else if (!l.trim()) { close(); }
      else { close(); html += "<p>" + inline(l) + "</p>"; }
    }
    close();
    return html;
  }

  // ---------- AI ----------
  const hasKey = () => (state.settings.provider === "deepseek" ? !!state.settings.deepseekKey : !!state.settings.geminiKey);
  async function aiCall(system, prompt) {
    const s = state.settings;
    if (!hasKey()) throw new Error("Add your " + (s.provider === "deepseek" ? "DeepSeek" : "Gemini") + " API key in ⚙️ Settings first.");
    const sys = system + " Reply in " + (s.aiLang || "English") + ".";
    if (s.provider === "deepseek") {
      const res = await fetch(DEEPSEEK_BASE + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + s.deepseekKey },
        body: JSON.stringify({ model: s.deepseekModel || DEEPSEEK_DEFAULT, messages: [{ role: "system", content: sys }, { role: "user", content: prompt }], max_tokens: 16000 }),
      });
      if (!res.ok) throw new Error(await apiErr(res, "DeepSeek"));
      const j = await res.json();
      return ((j.choices || [])[0] || {}).message?.content || "";
    }
    const models = [s.geminiModel || GEMINI_DEFAULT];
    if (!models.includes(GEMINI_BACKUP)) models.push(GEMINI_BACKUP);
    let lastErr;
    for (const model of models) {
      const res = await fetch(GEMINI_BASE + "/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      });
      if (res.ok) {
        const j = await res.json();
        const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        const out = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (out) return out;
        lastErr = new Error("Gemini gave an empty answer — try again.");
        continue;
      }
      lastErr = new Error(await apiErr(res, "Gemini"));
      if (![404, 429, 500, 503].includes(res.status)) break; // only fall back for missing/busy models
    }
    throw lastErr;
  }
  async function apiErr(res, name) {
    let msg = "";
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || ""; } catch { /* ignore */ }
    if (res.status === 400 && /key/i.test(msg) || res.status === 401 || res.status === 403) return name + ": the API key isn't valid — check it in Settings.";
    if (res.status === 429) return name + ": free limit reached — wait a minute and try again.";
    if (res.status === 402) return name + ": no balance left on your account.";
    if (res.status === 404) return name + ": that model isn't available — clear the model box in Settings to use the default.";
    return name + " error " + res.status + (msg ? ": " + String(msg).slice(0, 180) : "");
  }

  // ---------- home ----------
  const ORDER = ["web", "youtube", "reddit", "github", "x", "rss"];
  function renderChips() {
    $("chips").innerHTML = ORDER.map((k) => '<button class="chip' + (state.source === k ? " on" : "") + '" data-k="' + k + '">' + R.SOURCES[k].icon + " " + R.SOURCES[k].label + "</button>").join("");
    $("hint").textContent = R.SOURCES[state.source].hint;
    $("q").placeholder = R.SOURCES[state.source].hint;
  }
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.source = b.dataset.k; save(); renderChips();
  });
  function renderHistory() {
    const h = state.history;
    $("hist-title").classList.toggle("hidden", !h.length);
    $("history").innerHTML = h.map((x, i) => '<li data-i="' + i + '"><span class="ico">' + (R.isUrl(x.q) ? "🔗" : srcInfo(x.src).icon) + '</span><div class="grow"><div class="one">' + esc(x.q) + '</div><div class="sub">' + (x.ask ? "✨ Ask · " : "") + esc(srcInfo(x.src).label) + "</div></div></li>").join("");
    $("key-notice").classList.toggle("hidden", hasKey());
  }
  $("history").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const x = state.history[+li.dataset.i];
    $("q").value = x.q;
    if (R.SOURCES[x.src]) { state.source = x.src; renderChips(); }
    x.ask ? ask() : go();
  });
  function remember(q, src, isAsk) {
    state.history = [{ q, src, ask: !!isAsk }, ...state.history.filter((x) => !(x.q === q && x.src === src && !!x.ask === !!isAsk))].slice(0, 30);
    save(); renderHistory();
  }
  $("btn-paste").addEventListener("click", async () => {
    try { const t = await navigator.clipboard.readText(); if (t) { $("q").value = t.trim(); } else toast("Clipboard is empty"); }
    catch { toast("Long-press the box and choose Paste"); }
  });
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
  $("btn-go").addEventListener("click", () => go());
  $("btn-ask").addEventListener("click", () => ask());

  // ---------- search / read ----------
  let current = null; // item open in the reader
  async function go(input) {
    const q = (input || $("q").value).trim();
    if (!q) { toast("Type something or paste a link"); return; }
    $("q").blur();
    loading(true, R.isUrl(q) ? "Reading…" : "Searching " + R.SOURCES[state.source].label + "…");
    try {
      const out = await R.run(q, state.source);
      if (!input) remember(q, R.isUrl(q) ? out.source : state.source);
      if (out.mode === "read" && out.items.length === 1) openDetail(out.items[0]);
      else showResults(q, out);
    } catch (e) {
      toast(e.message);
    } finally { loading(false); }
  }
  function showResults(q, out) {
    const info = srcInfo(out.source);
    $("res-title").textContent = info.icon + " " + (R.isUrl(q) ? info.label : q);
    $("res-body").innerHTML = out.items.map((it, i) =>
      '<div class="card" data-i="' + i + '"><div class="t">' + esc(it.title || it.url || "(untitled)") + "</div>" +
      '<div class="m">' + esc([it.author, it.date, it.meta].filter(Boolean).join(" · ")) + "</div>" +
      (it.text ? '<div class="s">' + esc(it.text.slice(0, 400)) + "</div>" : "") +
      (it.url ? '<div class="u">' + esc(it.url) + "</div>" : "") + "</div>").join("");
    $("res-body").onclick = async (e) => {
      const c = e.target.closest(".card");
      if (!c) return;
      const it = out.items[+c.dataset.i];
      // Search results are short snippets — open the full thing.
      if (it.url && (out.mode === "search" || it.source === "rss")) {
        loading(true, "Reading…");
        try {
          const r = await R.run(it.url, it.source === "rss" ? "web" : it.source);
          openDetail(r.items.length === 1 ? r.items[0] : it);
        } catch (err) {
          toast(err.message + " — showing the snippet.");
          openDetail(it);
        } finally { loading(false); }
      } else openDetail(it);
    };
    $("res-body").scrollTop = 0;
    show("v-results");
  }
  function openDetail(it) {
    current = it;
    const info = srcInfo(it.source);
    $("det-src").textContent = info.icon + " " + info.label;
    $("det-body").innerHTML = '<div class="reader"><div id="det-ai"></div><h1>' + esc(it.title || "(untitled)") + "</h1>" +
      '<div class="m">' + esc([it.author, it.date, it.meta].filter(Boolean).join(" · ")) + "</div>" +
      '<div class="body">' + esc(it.text || "(nothing to show)") + "</div></div>";
    $("det-q").value = "";
    $("det-body").scrollTop = 0;
    show("v-detail");
  }
  $("det-copy").addEventListener("click", () => current && copy((current.title ? current.title + "\n" : "") + (current.url ? current.url + "\n\n" : "") + current.text));
  $("det-open").addEventListener("click", () => current && openUrl(current.url));

  async function aboutCurrent(question) {
    if (!current) return;
    const box = $("det-ai");
    loading(true, question ? "Thinking…" : "Summarising…");
    try {
      const content = (current.text || "").slice(0, 60000);
      const system = question
        ? "You answer questions using only the content provided. If the answer isn't in it, say so briefly. Be clear and concise."
        : "You summarise content for a busy doctor and founder. Give a 2-line overview, then the key points as bullets, then any useful takeaways. If it's a lecture or video transcript, list the main teaching points.";
      const prompt = "Title: " + (current.title || "") + "\nSource: " + (current.url || "") + "\n\nCONTENT:\n" + content + "\n\n" + (question ? "QUESTION: " + question : "Summarise this.");
      const out = await aiCall(system, prompt);
      box.innerHTML += '<div class="ai-box"><div class="lbl">' + (question ? "✨ " + esc(question) : "✨ Summary") + '</div><div class="md">' + md(out) + "</div></div>";
      $("det-body").scrollTop = 0;
    } catch (e) { toast(e.message); }
    finally { loading(false); }
  }
  $("det-sum").addEventListener("click", () => aboutCurrent(""));
  $("det-ask").addEventListener("click", () => { const q = $("det-q").value.trim(); if (q) { $("det-q").value = ""; aboutCurrent(q); } else $("det-q").focus(); });
  $("det-q").addEventListener("keydown", (e) => { if (e.key === "Enter") $("det-ask").click(); });

  // ---------- Ask AI: search → read top results → answer with sources ----------
  let lastAnswer = "";
  async function ask() {
    const q = $("q").value.trim();
    if (!q) { toast("Type a question first"); return; }
    if (!hasKey()) { toast("Add your AI key in Settings first"); openSettings(); return; }
    if (R.isUrl(q)) { go(); return; }
    $("q").blur();
    const src = R.SOURCES[state.source].search ? state.source : "web";
    loading(true, "Searching " + R.SOURCES[src].label + "…");
    try {
      let items = (await R.SOURCES[src].search(q, 8)).slice(0, 6);
      // Search snippets can be thin — read the top results in full where we can.
      $("loading-text").textContent = "Reading top results…";
      const top = await Promise.all(items.slice(0, 3).map(async (it) => {
        if (!it.url || (it.text && it.text.length > 1500)) return it;
        try { const r = await R.run(it.url, it.source); return r.items.length === 1 ? { ...it, text: r.items[0].text } : it; } catch { return it; }
      }));
      items = top.concat(items.slice(3));
      $("loading-text").textContent = "Writing the answer…";
      const ctx = items.map((it, i) => "[" + (i + 1) + "] " + (it.title || "") + "\nURL: " + (it.url || "") + "\n" + [it.author, it.date, it.meta].filter(Boolean).join(" · ") + "\n" + (it.text || "").slice(0, 7000)).join("\n\n---\n\n");
      const answer = await aiCall(
        "You are SRK Reach, a research assistant. Answer the question using the numbered sources. Cite them inline like [1] or [2]. If the sources don't cover something, say so. Start with the direct answer, then details as short bullets.",
        "QUESTION: " + q + "\n\nSOURCES (from " + R.SOURCES[src].label + "):\n\n" + ctx
      );
      remember(q, src, true);
      lastAnswer = answer + "\n\nSources:\n" + items.map((it, i) => "[" + (i + 1) + "] " + (it.title || "") + " — " + it.url).join("\n");
      $("ans-body").innerHTML = '<div class="reader"><h1>' + esc(q) + '</h1><div class="md">' + md(answer) + '</div><div class="sources"><div class="m">Sources</div>' +
        items.map((it, i) => '<a href="#" data-src="' + i + '">[' + (i + 1) + "] " + esc(it.title || it.url) + "</a>").join("") + "</div></div>";
      $("ans-body").onclick = (e) => {
        const a = e.target.closest("a[data-src], a[data-cite]");
        if (!a) return;
        e.preventDefault();
        const it = items[a.dataset.src != null ? +a.dataset.src : +a.dataset.cite - 1];
        if (it) openDetail(it);
      };
      $("ans-body").scrollTop = 0;
      show("v-answer");
    } catch (e) { toast(e.message); }
    finally { loading(false); }
  }
  $("ans-copy").addEventListener("click", () => lastAnswer && copy(lastAnswer));

  // ---------- source check ----------
  async function runChecks() {
    $("st-list").innerHTML = R.CHECKS.map(([k, label], i) => '<li><span class="ico">' + R.SOURCES[k].icon + '</span><div class="grow"><div>' + esc(label) + '</div><div class="sub" id="st-' + i + '">checking…</div></div><span id="st-i-' + i + '">⏳</span></li>').join("");
    await Promise.all(R.CHECKS.map(async ([, , fn], i) => {
      try { await fn(); $("st-i-" + i).textContent = "✅"; $("st-" + i).textContent = "working"; }
      catch (e) { $("st-i-" + i).textContent = "❌"; $("st-" + i).textContent = e.message; }
    }));
  }
  $("btn-status").addEventListener("click", () => { show("v-status"); runChecks(); });
  $("st-run").addEventListener("click", runChecks);

  // ---------- settings ----------
  const FIELDS = { "s-prov": "provider", "s-gkey": "geminiKey", "s-gmodel": "geminiModel", "s-dkey": "deepseekKey", "s-dmodel": "deepseekModel", "s-ghtok": "githubToken", "s-cap": "capLang", "s-lang": "aiLang", "s-font": "font" };
  function openSettings() {
    for (const [id, k] of Object.entries(FIELDS)) $(id).value = state.settings[k] || "";
    $("s-test-out").textContent = "";
    show("v-settings");
  }
  function readSettings() { for (const [id, k] of Object.entries(FIELDS)) state.settings[k] = $(id).value.trim(); save(); applyFont(); renderHistory(); }
  $("btn-settings").addEventListener("click", openSettings);
  $("s-save").addEventListener("click", () => { readSettings(); toast("Saved"); back(); });
  $("s-font").addEventListener("change", () => { state.settings.font = $("s-font").value; applyFont(); });
  $("s-test").addEventListener("click", async () => {
    readSettings();
    $("s-test-out").textContent = "Testing…";
    try { const r = await aiCall("Reply with exactly: SRK Reach is ready.", "Test"); $("s-test-out").textContent = "✅ " + r.trim().slice(0, 80); }
    catch (e) { $("s-test-out").textContent = "❌ " + e.message; }
  });
  $("s-clear").addEventListener("click", () => { state.history = []; save(); renderHistory(); toast("Cleared"); });

  // YouTube caption language reaches sources.js through the read call.
  const ytRead = R.SOURCES.youtube.read;
  R.SOURCES.youtube.read = (url) => ytRead(url, state.settings.capLang || "en");

  renderChips();
  renderHistory();
  history.replaceState({ v: "v-home" }, "");
})();
