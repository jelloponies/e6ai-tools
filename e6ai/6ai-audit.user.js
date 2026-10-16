// ==UserScript==
// @name         e6AI User Audit
// @namespace    e6ai-admin-tools
// @version      1.17
// @icon         https://e6ai.net/packs/static/default-66793a8a1f9191d01666.svg
// @author       Jelloponies
// @description  Admin tool: on a user's profile page, audit their uploads, comments and votes (cast and received) and compare votes to their blacklist. Movable, resizable window.
// @match        https://e6ai.net/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const DELAY = 1000;      // ms between requests
  const MAX_RETRIES = 5;
  const VOTER_ROWS = 10;   // voters shown per table; names are looked up for exactly these
  let stopFlag = false;
  let comments = [];       // loaded comments, used by the sample view
  let state = {};          // results of the current audit
  let userInfo = new Map();  // voter id -> user JSON (names, account age)
  let blSort = { key: 'total', dir: -1 };   // sort order of the blacklist entries table

  // ---- pure helpers begin ----
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const normBody = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function domainOf(src) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(src) ? src : 'https://' + src);
      const h = u.hostname.replace(/^www\./, '').toLowerCase();
      return h.includes('.') ? h : null;
    } catch { return null; }
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // largest number of timestamps (ms) that fall inside any window of `win` ms
  function maxInWindow(times, win) {
    const t = [...times].sort((a, b) => a - b);
    let best = 0, j = 0;
    for (let i = 0; i < t.length; i++) {
      while (t[i] - t[j] > win) j++;
      best = Math.max(best, i - j + 1);
    }
    return best;
  }

  const wild = (t) => new RegExp('^' + t.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

  function cmp(a, op, b) {
    switch (op) {
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: return a === b;
    }
  }

  // Parses a blacklist (one entry per line). Supports tags, -tag, ~tag, * wildcards,
  // rating:x and score:<n. Entries using other metatags are marked unsupported and skipped.
  function parseBlacklist(text) {
    const entries = [];
    for (const line of String(text || '').split('\n')) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const e = { raw, req: [], neg: [], any: [], rating: [], notRating: [], score: [], unsupported: null };
      for (const term of raw.split(/\s+/)) {
        let t = term.toLowerCase(), mode = 'req';
        if (t.startsWith('-')) { mode = 'neg'; t = t.slice(1); }
        else if (t.startsWith('~')) { mode = 'any'; t = t.slice(1); }
        if (!t) continue;
        if (t.startsWith('rating:')) {
          const v = t.slice(7)[0];
          if (!v) { e.unsupported = term; continue; }
          (mode === 'neg' ? e.notRating : e.rating).push(v);
          continue;
        }
        if (t.startsWith('score:')) {
          const m = /^score:(<=|>=|<|>|=)?(-?\d+)$/.exec(t);
          if (!m || mode !== 'req') { e.unsupported = term; continue; }
          e.score.push({ op: m[1] || '=', n: parseInt(m[2], 10) });
          continue;
        }
        if (t.includes(':')) { e.unsupported = term; continue; }
        e[mode].push(t.includes('*') ? wild(t) : t);
      }
      entries.push(e);
    }
    return entries;
  }

  // True if any supported blacklist entry names this tag (plain term, ~term or wildcard).
  const tagInBlacklist = (entries, tag) => entries.some((e) => !e.unsupported &&
    [...e.req, ...e.any].some((x) => (typeof x === 'string' ? x === tag : x.test(tag))));

  const hasTag = (tags, x) => (typeof x === 'string' ? tags.has(x) : [...tags].some((t) => x.test(t)));

  // Returns the first blacklist entry that hides this post, or null.
  function blacklistMatch(entries, post) {
    const tags = new Set(Object.values(post.tags || {}).flat().map((t) => String(t).toLowerCase()));
    const rating = String(post.rating || '').toLowerCase();
    const score = post.score && typeof post.score === 'object' ? post.score.total : post.score;
    for (const e of entries) {
      if (e.unsupported) continue;
      if (!e.req.length && !e.any.length && !e.rating.length && !e.score.length) continue;
      if (!e.req.every((x) => hasTag(tags, x))) continue;
      if (e.neg.some((x) => hasTag(tags, x))) continue;
      if (e.any.length && !e.any.some((x) => hasTag(tags, x))) continue;
      if (e.rating.length && !e.rating.includes(rating)) continue;
      if (e.notRating.includes(rating)) continue;
      if (!e.score.every(({ op, n }) => cmp(score ?? 0, op, n))) continue;
      return e;
    }
    return null;
  }

  // ---- source checks ----
  // Tweak these to taste: how many posts must share one identical source before it is listed/flagged,
  // and how many posts with profile-looking sources trigger the flag.
  const SAME_SOURCE_MIN = 5, PROFILE_SOURCE_FLAG = 1, INVALID_SOURCE_FLAG = 1, CHAT_SOURCE_FLAG = 1;   // both 1 = always warn, however few posts are affected

  function parseSource(src) {
    if (/\s/.test(String(src).trim())) return null;   // a link never contains spaces (also catches two links in one field)
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(src) ? src : 'https://' + src);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      const tld = host.split('.').pop();
      if (!host.includes('.') || tld.length < 2 || !/[a-z]/.test(tld)) return null;   // not a real-looking web address
      const segs = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
      return { host, segs, q: u.searchParams, search: u.search };
    } catch { return null; }
  }

  // Same link written differently (http/https, www, trailing slash, #fragment, tracking query) groups together.
  function normSource(src) {
    const p = parseSource(src);
    if (!p) return String(src || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const keepQuery = /(^|\.)(youtube\.com|pixiv\.net)$/.test(p.host);
    return p.host + '/' + p.segs.join('/').toLowerCase() + (keepQuery ? p.search.toLowerCase() : '');
  }

  // Guesses from the link's shape what it points at: 'invalid' (not a web link at all), 'submission' (a specific post/artwork page),
  // 'profile' (a profile, channel, gallery or other landing page), 'invite' (a Discord or Telegram invite/chat link), 'home' (just the site's front page) or 'unknown'.
  function classifySource(src) {
    const p = parseSource(src);
    if (!p) return 'invalid';   // not a web link at all (plain words, a version number, two links in one line, ...)
    const { host, segs, q } = p, n = segs.length, s0 = (segs[0] || '').toLowerCase();
    const on = (...d) => d.some((x) => host === x || host.endsWith('.' + x));
    // Discord and Telegram: invites, server/channel links and t.me links all count as 'invite'
    if (on('discord.gg', 'dsc.gg', 'discord.me', 'discord.link', 't.me', 'telegram.me', 'telegram.dog')) return n ? 'invite' : 'home';
    if (['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host) && ['invite', 'channels', 'users', 'servers', 'events', 'discovery', 'template', 'oauth2'].includes(s0)) return 'invite';
    if (!n) return p.search ? 'unknown' : 'home';

    if (on('x.com', 'twitter.com')) {
      if (segs.includes('status') || segs.includes('statuses')) return 'submission';
      if (['i', 'hashtag', 'search', 'explore', 'home', 'intent', 'share', 'messages', 'settings'].includes(s0)) return 'unknown';
      return n <= 2 ? 'profile' : 'unknown';
    }
    if (on('furaffinity.net')) {
      if (['view', 'full'].includes(s0)) return 'submission';
      if (['user', 'gallery', 'scraps', 'favorites', 'journals', 'commissions'].includes(s0)) return 'profile';
      return 'unknown';
    }
    if (on('bsky.app')) return s0 === 'profile' ? (segs[2] === 'post' ? 'submission' : 'profile') : 'unknown';
    if (on('pixiv.net')) {
      if (segs.includes('artworks') || q.has('illust_id')) return 'submission';
      if (segs.includes('users') || segs.some((x) => /^member/.test(x))) return 'profile';
      return 'unknown';
    }
    if (on('deviantart.com')) {
      if (segs.includes('art')) return 'submission';
      if (['tag', 'search', 'topic', 'watch', 'journal'].includes(s0)) return 'unknown';
      return n <= 2 ? 'profile' : 'unknown';
    }
    if (on('civitai.com')) {
      if (s0 === 'images' || s0 === 'posts') return 'submission';
      return s0 === 'user' ? 'profile' : 'unknown';
    }
    if (on('redd.it')) return 'submission';
    if (on('reddit.com')) {
      if (segs.includes('comments')) return 'submission';
      return ['user', 'u', 'r'].includes(s0) && n <= 2 ? 'profile' : 'unknown';
    }
    if (on('youtu.be')) return 'submission';
    if (on('youtube.com')) {
      if (['watch', 'shorts', 'live'].includes(s0)) return 'submission';
      return s0.startsWith('@') || ['channel', 'c', 'user'].includes(s0) ? 'profile' : 'unknown';
    }
    if (on('instagram.com')) {
      if (['p', 'reel', 'reels', 'tv'].includes(s0)) return 'submission';
      return n <= 1 && !['explore', 'accounts'].includes(s0) ? 'profile' : 'unknown';
    }
    if (on('tumblr.com')) return segs.includes('post') ? 'submission' : 'unknown';
    if (on('patreon.com')) return s0 === 'posts' ? 'submission' : (n <= 2 ? 'profile' : 'unknown');
    if (on('frosting.ai')) {
      if (s0 === 'profile') return segs[2] === 'post' ? 'submission' : 'profile';
      return s0 === 'user' ? 'profile' : 'unknown';
    }
    if (on('e621.net', 'e926.net', 'e6ai.net')) return s0 === 'posts' ? 'submission' : (s0 === 'users' ? 'profile' : 'unknown');

    // any other site: the usual profile-style URL shapes
    if (['user', 'users', 'u', 'profile', 'profiles', 'member', 'members', 'artist', 'artists', 'creator', 'creators', 'channel', 'author'].includes(s0) && n <= 2) return 'profile';
    if (s0.startsWith('@') && n <= 1) return 'profile';
    return 'unknown';
  }

  // Groups an uploader's posts by identical source. Returns the rows worth looking at: sources shared by
  // SAME_SOURCE_MIN or more posts, plus any that look like a profile or home page, plus anything that is not a link.
  function analyzeSources(list) {
    const groups = new Map();
    for (const p of list) {
      const seen = new Set();
      for (const src of p.sources || []) {
        const key = normSource(src);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { url: src, kind: classifySource(src), ids: [] }));
        g.ids.push(p.id);
      }
    }
    const all = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
    const landing = (g) => g.kind === 'profile' || g.kind === 'home';
    const rows = all.filter((g) => g.ids.length >= SAME_SOURCE_MIN || landing(g) || g.kind === 'invalid' || g.kind === 'invite')
      .sort((a, b) => (b.kind === 'invalid') - (a.kind === 'invalid') || b.ids.length - a.ids.length);   // non-links first
    const landingPosts = new Set(), invalidPosts = new Set(), chatPosts = new Set();
    for (const g of all) {
      if (landing(g)) g.ids.forEach((id) => landingPosts.add(id));
      if (g.kind === 'invalid') g.ids.forEach((id) => invalidPosts.add(id));
      if (g.kind === 'invite') g.ids.forEach((id) => chatPosts.add(id));
    }
    return { rows, total: rows.length, landingPosts: landingPosts.size, invalidPosts: invalidPosts.size, chatPosts: chatPosts.size,
      invalidTop: all.find((g) => g.kind === 'invalid') || null,
      sameTop: all[0] && all[0].ids.length >= SAME_SOURCE_MIN ? all[0] : null };
  }

  function postStats(list, now) {
    const st = { total: list.length, active: 0, pending: 0, flagged: 0, deleted: 0, ratings: {}, noSource: 0,
      malformed: 0, domains: {}, scoreSum: 0, favSum: 0, last7: 0, last30: 0, tags: {}, maxPerHour: 0,
      topDomain: null, topDomainCount: 0 };
    const times = [];
    for (const p of list) {
      const f = p.flags || {};
      if (f.deleted) st.deleted++; else if (f.pending) st.pending++; else if (f.flagged) st.flagged++; else st.active++;
      st.ratings[p.rating] = (st.ratings[p.rating] || 0) + 1;
      const srcs = p.sources || [];
      if (!srcs.length) st.noSource++;
      const ds = new Set(srcs.map(domainOf).filter(Boolean));
      if (srcs.some((s) => !domainOf(s))) st.malformed++;
      for (const d of ds) st.domains[d] = (st.domains[d] || 0) + 1;
      st.scoreSum += (p.score && p.score.total) || 0;
      st.favSum += p.fav_count || 0;
      const t = Date.parse(p.created_at);
      if (!Number.isNaN(t)) {
        times.push(t);
        if (now - t <= 7 * 864e5) st.last7++;
        if (now - t <= 30 * 864e5) st.last30++;
      }
      const tg = p.tags || {};
      for (const x of [...(tg.general || []), ...(tg.species || [])]) st.tags[x] = (st.tags[x] || 0) + 1;
    }
    st.maxPerHour = maxInWindow(times, 3600000);
    st.sources = analyzeSources(list.filter((p) => !(p.flags && p.flags.deleted)));
    for (const [d, n] of Object.entries(st.domains)) if (n > st.topDomainCount) { st.topDomain = d; st.topDomainCount = n; }
    return st;
  }

  function commentStats(list) {
    const st = { total: list.length, hidden: 0, negative: 0, scoreSum: 0, withLinks: 0, repeated: [], byPost: [] };
    const bodies = {}, bodyItems = {}, posts = {};
    for (const c of list) {
      if (c.is_hidden) st.hidden++;
      const sc = c.score ?? 0;
      if (sc < 0) st.negative++;
      st.scoreSum += sc;
      if (/https?:\/\//i.test(c.body || '')) st.withLinks++;
      const b = normBody(c.body);
      if (b) { bodies[b] = (bodies[b] || 0) + 1; (bodyItems[b] = bodyItems[b] || []).push({ id: c.id, post_id: c.post_id }); }
      posts[c.post_id] = (posts[c.post_id] || 0) + 1;
    }
    st.repeated = Object.entries(bodies).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([body, n]) => ({ body, n, items: bodyItems[body] }));
    st.byPost = Object.entries(posts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ id, n }));
    return st;
  }

  function analyzeVotes(votes, postMap, entries) {
    const A = { up: 0, down: 0, other: 0, missing: 0, byUploader: {}, names: {}, delaysDown: [], delaysUp: [],
      blDown: [], blUp: 0, blHits: {}, downChecked: 0, tagUp: {}, tagDown: {}, timesAll: [], timesDown: [] };
    for (const v of votes) {
      const dir = v.score > 0 ? 'up' : v.score < 0 ? 'down' : null;
      if (!dir) { A.other++; continue; }
      A[dir]++;
      const t = Date.parse(v.created_at);
      A.timesAll.push(t);
      if (dir === 'down') A.timesDown.push(t);
      const p = postMap.get(v.post_id);
      if (!p) { A.missing++; continue; }
      if (dir === 'down') A.downChecked++;
      const u = (A.byUploader[p.uploader_id] = A.byUploader[p.uploader_id] || { up: 0, down: 0, upPosts: [], downPosts: [] });
      u[dir]++;
      u[dir + 'Posts'].push(p.id);
      if (p.uploader_name) A.names[p.uploader_id] = p.uploader_name;
      (dir === 'down' ? A.delaysDown : A.delaysUp).push((t - Date.parse(p.created_at)) / 3.6e6);
      const m = entries.length ? blacklistMatch(entries, p) : null;
      if (m) {
        const h = (A.blHits[m.raw] = A.blHits[m.raw] || { up: 0, down: 0 });
        h[dir]++;
        if (dir === 'down') A.blDown.push({ vote: v, post: p, entry: m }); else A.blUp++;
      }
      const seen = new Set(Object.values(p.tags || {}).flat().map((x) => String(x).toLowerCase()));
      const bag = dir === 'down' ? A.tagDown : A.tagUp;
      for (const tg of seen) bag[tg] = (bag[tg] || 0) + 1;
    }
    return A;
  }
  // Groups votes that other people cast on this user's posts/comments by voter.
  function analyzeReceived(votes, idKey) {
    const R = { up: 0, down: 0, byVoter: {} };
    for (const v of votes) {
      const dir = v.score > 0 ? 'up' : v.score < 0 ? 'down' : null;
      if (!dir) continue;
      R[dir]++;
      const e = (R.byVoter[v.user_id] = R.byVoter[v.user_id] || { up: 0, down: 0, upItems: [], downItems: [] });
      e[dir]++;
      e[dir + 'Items'].push(v[idKey]);
    }
    return R;
  }
  // ---- pure helpers end ----

  // Only active on a user's profile page (/users/<id>); the audited user is that profile.
  const profileMatch = location.pathname.match(/^\/users\/(\d+)\/?$/);
  if (!profileMatch) return;
  const profileId = profileMatch[1];

  GM_addStyle(`
    /* Colours taken from the site's "Bloodlust" theme */
    #ua-toggle, #ua-panel {
      --ua-background: #000000; --ua-foreground: #222222; --ua-section: #333333; --ua-section-light: #4d4d4d;
      --ua-text: #ffffff; --ua-muted: #cbb295; --ua-link: #ffee95; --ua-hover: #f68b00; --ua-accent: #e8c446;
      --ua-pos: #4ccf5f; --ua-zero: #ffc800; --ua-neg: #ff5a5a;
    }
    #ua-toggle { position: fixed; bottom: 56px; right: 16px; z-index: 99999; padding: 8px 12px;
      background: #7a3b2e; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
    #ua-toggle:hover { background: #9a4a3a; }
    #ua-panel { position: fixed; bottom: 96px; right: 16px; z-index: 99999; width: 640px; min-width: 360px; min-height: 160px; max-width: 95vw; max-height: 95vh;
      overflow: auto; resize: both; background: var(--ua-section); color: var(--ua-text); border: 1px solid var(--ua-section-light); border-radius: 8px;
      padding: 12px; font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,.7); display: none; color-scheme: dark; }
    #ua-panel label { margin-right: 10px; }
    #ua-panel input[type=text], #ua-panel input[type=number], #ua-panel input[type=date], #ua-panel select { padding: 3px;
      background: var(--ua-foreground); color: var(--ua-text); border: 1px solid var(--ua-section-light); border-radius: 3px; }
    #ua-panel button { margin: 6px 6px 0 0; padding: 5px 10px; cursor: pointer; background: var(--ua-foreground); color: var(--ua-link);
      border: 1px solid var(--ua-section-light); border-radius: 4px; }
    #ua-panel button:hover { background: var(--ua-background); color: var(--ua-hover); }
    #ua-panel .row { margin-top: 8px; }
    #ua-panel .hint { font-size: 11px; color: var(--ua-muted); }
    #ua-panel a { color: var(--ua-link); text-decoration: none; }
    #ua-panel a:hover { color: var(--ua-hover); text-decoration: underline; }
    #ua-panel code { color: var(--ua-text); }
    #ua-panel th[data-bl-sort] { cursor: pointer; user-select: none; }
    #ua-panel th[data-bl-sort]:hover { color: var(--ua-hover); }
    #ua-panel table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
    #ua-panel th, #ua-panel td { border-bottom: 1px solid var(--ua-foreground); padding: 2px 6px; text-align: left; font-size: 12px; vertical-align: top; }
    #ua-panel th { color: #e6e6e6; background: var(--ua-foreground); }
    #ua-panel details { margin-top: 8px; }
    #ua-panel summary { cursor: pointer; font-weight: bold; }
    #ua-panel summary:hover { color: var(--ua-hover); }
    #ua-panel details.ua-x { display: inline-block; margin: 0; }
    #ua-panel details.ua-x > summary { font-weight: normal; }
    #ua-panel .ua-links { max-width: 330px; max-height: 120px; overflow: auto; line-height: 1.5; }
    /* inside tables the list opens in its own full-width row (see the toggle handler), so no column resizes */
    #ua-panel tr details.ua-x > .ua-links { display: none; }
    #ua-panel tr.ua-xrow td { padding: 3px 6px 6px 18px; background: var(--ua-foreground); }
    #ua-panel tr.ua-xrow .ua-links { max-width: none; max-height: 140px; }
    #ua-head { position: sticky; top: 0; z-index: 2; margin: -12px -12px 6px; padding: 8px 12px; background: var(--ua-background);
      border-bottom: 1px solid var(--ua-section-light); cursor: move; user-select: none; touch-action: none; border-radius: 8px 8px 0 0; }
    #ua-head #ua-close { float: right; margin: 0; padding: 0 7px; cursor: pointer; }
    #ua-status { margin-top: 8px; font-weight: bold; font-size: 12px; color: var(--ua-accent); }
    #ua-log { margin-top: 4px; max-height: 90px; overflow: auto; background: var(--ua-background); color: var(--ua-muted);
      font-family: monospace; font-size: 11px; padding: 4px; white-space: pre-wrap; border: 1px solid var(--ua-foreground); }
    .ua-flags { background: var(--ua-foreground); border: 1px solid var(--ua-accent); border-radius: 6px; padding: 6px 10px; margin-top: 10px; }
    #ua-panel .ua-flags ul { list-style: disc outside; margin: 4px 0 0; padding: 0 0 0 20px; }
    #ua-panel .ua-flags li { display: list-item; list-style: disc outside; margin: 3px 0; }
    .ua-c { border-bottom: 1px solid var(--ua-foreground); padding: 5px 0; color: var(--ua-text); font-size: 13px; }
    .ua-c .meta { font-size: 11px; color: var(--ua-muted); }
    #ua-panel .ua-pos { color: var(--ua-pos); font-weight: bold; }
    #ua-panel .ua-zero { color: var(--ua-zero); font-weight: bold; }
    #ua-panel .ua-neg { color: var(--ua-neg); font-weight: bold; }
  `);

  const panel = document.createElement('div');
  panel.id = 'ua-panel';
  panel.innerHTML = `
    <div id="ua-head"><button id="ua-close" title="Close">✕</button><b>User Audit</b> <span id="ua-name">— user #${profileId}</span> <span class="hint">(drag to move)</span></div>
    <div class="row">
      <label>From <input type="date" id="ua-from"></label>
      <label>To <input type="date" id="ua-to"></label>
      <button id="ua-7">7d</button><button id="ua-30">30d</button><button id="ua-90">90d</button><button id="ua-all">All</button>
      <div class="hint">Timespan applies to comments and votes. Uploads are always the whole account. Max votes applies to each vote list separately.</div>
    </div>
    <div class="row">
      <label><input type="checkbox" id="ua-do-posts" checked> Uploads</label>
      <label><input type="checkbox" id="ua-do-comments" checked> Comments</label>
      <label><input type="checkbox" id="ua-do-votes" checked> Votes cast</label>
      <label><input type="checkbox" id="ua-do-received" checked> Votes received</label>
    </div>
    <div class="row">
      <label>Max comments <input type="number" id="ua-max-comments" value="1000" min="10" style="width:70px"></label>
      <label>Max votes <input type="number" id="ua-max-votes" value="2000" min="10" style="width:70px"></label>
    </div>
    <div>
      <button id="ua-run">Run audit</button>
      <button id="ua-stop">Stop</button>
    </div>
    <div id="ua-status"></div>
    <div id="ua-log"></div>
    <div id="ua-report"></div>
    <details>
      <summary>Comment sample</summary>
      <div class="row">
        <label>Sort
          <select id="ua-c-sort">
            <option value="new">Newest</option>
            <option value="old">Oldest</option>
            <option value="low">Lowest score</option>
            <option value="high">Highest score</option>
            <option value="long">Longest</option>
          </select>
        </label>
        <label>Score ≤ <input type="number" id="ua-c-max" style="width:60px" placeholder="any"></label>
        <label>Contains <input type="text" id="ua-c-text" style="width:130px"></label>
        <label>Show <input type="number" id="ua-c-n" value="20" min="1" style="width:55px"></label>
      </div>
      <div id="ua-comments"><span class="hint">Run an audit with Comments ticked to load them.</span></div>
    </details>
  `;
  const toggle = document.createElement('button');
  toggle.id = 'ua-toggle';
  toggle.textContent = 'User Audit';
  let placed = false;
  const closePanel = () => { panel.style.display = 'none'; };
  toggle.onclick = () => {
    if (panel.style.display === 'block') return closePanel();
    panel.style.display = 'block';
    placePanel();
    if (!state.user) setStatus('Ready. Set the options you want, then press "Run audit".');
  };
  document.body.append(panel, toggle);

  // ---------- movable / resizable window ----------
  function anchorTopLeft() {   // switch from bottom/right anchoring to top/left so dragging and resizing behave
    const r = panel.getBoundingClientRect();
    panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }
  function placePanel() {
    if (placed) return;
    placed = true;
    let g = null;
    try { g = JSON.parse(GM_getValue('geom', 'null')); } catch { /* ignore */ }
    if (g && g.width && g.height) {
      const w = Math.min(g.width, window.innerWidth - 20), h = Math.min(g.height, window.innerHeight - 20);
      panel.style.width = w + 'px'; panel.style.height = h + 'px';
      panel.style.left = Math.max(0, Math.min(g.left, window.innerWidth - w)) + 'px';
      panel.style.top = Math.max(0, Math.min(g.top, window.innerHeight - h)) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    } else anchorTopLeft();
  }
  function saveGeom() {
    if (panel.style.display !== 'block' || !placed) return;
    const r = panel.getBoundingClientRect();
    GM_setValue('geom', JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height }));
  }
  const head = document.getElementById('ua-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    if (head.setPointerCapture) head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panel.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - 80)) + 'px';
    panel.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  });
  const endDrag = () => { if (drag) { drag = null; saveGeom(); } };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  document.getElementById('ua-close').onclick = () => closePanel();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(saveGeom).observe(panel);

  const $ = (id) => document.getElementById(id);
  const log = (m) => { const l = $('ua-log'); l.textContent += m + '\n'; l.scrollTop = l.scrollHeight; };
  const setStatus = (m) => { $('ua-status').textContent = m; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const day = (t) => (Number.isNaN(t) ? '?' : new Date(t).toLocaleDateString('sv-SE'));
  const postLink = (id) => `<a href="/posts/${id}" target="_blank">#${id}</a>`;
  // Number colouring: positive green, zero yellow, negative red.
  const cls = (n) => (n > 0 ? 'ua-pos' : n < 0 ? 'ua-neg' : 'ua-zero');
  const num = (n, text) => `<span class="${cls(n)}">${esc(text === undefined ? n : text)}</span>`;
  const fnum = (n, d = 1) => { const r = Number(n.toFixed(d)); return num(r, r.toFixed(d)); };
  const sgnText = (n) => (n > 0 ? '+' + n : String(n));
  const upN = (n) => num(n, sgnText(n));      // an upvote count: +12
  const downN = (n) => num(-n, sgnText(-n));  // a downvote count: -12
  // A number you can click to list what it counts (links built by `link`).
  function drill(summaryHtml, items, link, cap = 100) {
    if (!items || !items.length) return summaryHtml;
    return `<details class="ua-x"><summary>${summaryHtml}</summary><div class="ua-links">${items.slice(0, cap).map(link).join(' ')}${items.length > cap ? ` … +${items.length - cap} more` : ''}</div></details>`;
  }
  const commentLink = (c) => `<a href="${c.post_id ? `/posts/${c.post_id}#comment-${c.id}` : `/comments/${c.id}`}" target="_blank">#${c.id}</a>`;
  const searchLink = (tags, text) => `<a href="/posts?tags=${encodeURIComponent(tags)}" target="_blank">${esc(text)}</a>`;
  const userLink = (id, name) => `<a href="/users/${id}" target="_blank">${esc(name || 'user #' + id)}</a>`;

  // ---------- remembered settings ----------
  const FIELDS = ['ua-from', 'ua-to', 'ua-max-comments', 'ua-max-votes'];
  const BOXES = ['ua-do-posts', 'ua-do-comments', 'ua-do-votes', 'ua-do-received'];
  function saveSettings() {
    const s = {};
    FIELDS.forEach((id) => (s[id] = $(id).value));
    BOXES.forEach((id) => (s[id] = $(id).checked));
    GM_setValue('settings', JSON.stringify(s));
  }
  (function loadSettings() {
    let s = {};
    try { s = JSON.parse(GM_getValue('settings', '{}')); } catch { /* ignore */ }
    FIELDS.forEach((id) => { if (typeof s[id] === 'string') $(id).value = s[id]; });
    BOXES.forEach((id) => { if (typeof s[id] === 'boolean') $(id).checked = s[id]; });
  })();
  // Expanding a count inside a table opens its list in a new full-width row under it, so the columns stay put.
  panel.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches || !d.matches('details.ua-x')) return;
    const tr = d.closest('tr');
    if (!tr) return;
    if (d.open) {
      const box = d.querySelector('.ua-links');
      if (!box || d._xrow) return;
      const row = document.createElement('tr'), td = document.createElement('td');
      row.className = 'ua-xrow';
      td.colSpan = tr.children.length;
      td.innerHTML = box.outerHTML;
      row.appendChild(td);
      let after = tr;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains('ua-xrow')) after = after.nextElementSibling;
      after.after(row);
      d._xrow = row;
    } else if (d._xrow) { d._xrow.remove(); d._xrow = null; }
  }, true);
  panel.addEventListener('input', saveSettings);
  panel.addEventListener('change', saveSettings);

  function setRange(days) {
    $('ua-to').value = '';
    $('ua-from').value = days ? day(Date.now() - days * 864e5) : '';
    saveSettings();
  }
  $('ua-7').onclick = () => setRange(7);
  $('ua-30').onclick = () => setRange(30);
  $('ua-90').onclick = () => setRange(90);
  $('ua-all').onclick = () => setRange(0);

  // ---------- network with retry ----------
  function checkOk(r) {
    if (r.ok) return r;
    const e = new Error(`${r.status} ${r.statusText}`);
    e.status = r.status;
    const ra = parseInt(r.headers.get('Retry-After'), 10);
    if (ra) e.retryAfter = ra * 1000;
    throw e;
  }

  async function withRetry(fn, label) {
    let wait = 5000;
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        const retryable = e.status === undefined || e.status === 429 || e.status >= 500;
        if (!retryable || attempt >= MAX_RETRIES || stopFlag) throw e;
        const ms = e.retryAfter || wait;
        log(`  ... ${label}: ${e.message}, retrying in ${Math.round(ms / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(ms);
        wait = Math.min(wait * 2, 60000);
      }
    }
  }

  const getJSON = (url) => withRetry(async () => {
    const r = checkOk(await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
    return r.json();
  }, url.split('?')[0]);

  // Staff-only page: https://e6ai.net/staff/users/<id>/edit_blacklist. The blacklist is in the form's textarea.
  async function fetchStaffBlacklist(id) {
    const r = checkOk(await fetch(`/staff/users/${id}/edit_blacklist`, { credentials: 'same-origin', headers: { Accept: 'text/html' } }));
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const ta = doc.querySelector('textarea[name="user[blacklisted_tags]"], textarea#user_blacklisted_tags')
      || doc.querySelector('form textarea');
    if (!ta) throw new Error('no blacklist textarea found on the page');
    return ta.value || '';
  }

  const asList = (d) => (Array.isArray(d) ? d : d.posts || d.comments || d.post_votes || d.comment_votes || d.votes || []);

  // Walks a newest-first listing page by page, honouring the from/to window (ms timestamps or null).
  async function* paged(url, from, to) {
    let page = '1';
    while (!stopFlag) {
      const list = asList(await getJSON(`${url}${url.includes('?') ? '&' : '?'}page=${page}`));
      if (!list.length) return;
      for (const item of list) {
        const t = Date.parse(item.created_at);
        if (from && t < from) return;
        if (to && t > to) continue;
        yield item;
      }
      page = 'b' + list[list.length - 1].id;
      await sleep(DELAY);
    }
  }

  async function fetchByIds(ids, urlFor, keyOf, label) {
    const map = new Map();
    const BATCH = 100;
    let individual = false;
    for (let i = 0; i < ids.length && !stopFlag; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      if (!individual) {
        const got = asList(await getJSON(urlFor(chunk)));
        got.forEach((x) => map.set(keyOf(x), x));
        if (i === 0 && !got.length) {
          log(`Batch lookup of ${label} returned nothing; falling back to one request each (capped at 300).`);
          individual = true;
        } else { setStatus(`Loading ${label}: ${Math.min(i + BATCH, ids.length)}/${ids.length}`); await sleep(DELAY); continue; }
      }
      for (const id of chunk.slice(0, Math.max(0, 300 - map.size))) {
        if (stopFlag) break;
        try { const x = await getJSON(urlFor([id])); asList(x).forEach((y) => map.set(keyOf(y), y)); } catch { /* skip */ }
        setStatus(`Loading ${label}: ${map.size}`);
        await sleep(DELAY);
      }
      break;
    }
    return map;
  }

  // ---------- report rendering ----------
  const table = (head, rows) => rows.length
    ? `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
    : '<div class="hint">Nothing to show.</div>';
  const section = (title, body) => `<details><summary>${esc(title)}</summary>${body}</details>`;

  function buildFlags() {
    const f = [];
    const P = state.posts && state.posts.stats, C = state.comments && state.comments.stats, V = state.votes && state.votes.A;
    if (P && P.total >= 20) {
      if (P.topDomain && P.topDomainCount / P.total >= 0.5) f.push(`${pct(P.topDomainCount, P.total)}% of their uploads list the same source domain (${P.topDomain}).`);
      if (P.deleted / P.total >= 0.25) f.push(`${pct(P.deleted, P.total)}% of their uploads are deleted.`);
    }
    if (P && P.sources) {
      const SS = P.sources, kindText = { profile: ' (looks like a profile or landing page)', home: ' (just a site front page)', invite: ' (an invite link)' };
      if (SS.invalidPosts >= INVALID_SOURCE_FLAG) f.push(`${SS.invalidPosts} of their posts ${SS.invalidPosts === 1 ? 'has' : 'have'} a source that isn't a valid web link (most common: "${SS.invalidTop.url}", ${SS.invalidTop.ids.length} post${SS.invalidTop.ids.length === 1 ? '' : 's'}). See "Sources worth checking" under Uploads.`);
      if (SS.sameTop) f.push(`${SS.sameTop.ids.length} of their posts list the identical source ${SS.sameTop.url}${kindText[SS.sameTop.kind] || ''}. See "Sources worth checking" under Uploads.`);
      if (SS.landingPosts >= PROFILE_SOURCE_FLAG) f.push(`${SS.landingPosts} of their posts ${SS.landingPosts === 1 ? 'has' : 'have'} a source that looks like a profile or landing page.`);
      if (SS.chatPosts >= CHAT_SOURCE_FLAG) f.push(`${SS.chatPosts} of their posts ${SS.chatPosts === 1 ? 'has' : 'have'} a source that is an invite link. See "Sources worth checking" under Uploads.`);
    }
    if (P && P.maxPerHour >= 50) f.push(`Uploaded up to ${P.maxPerHour} posts within a single hour.`);
    if (C) {
      if (C.total >= 10 && C.negative / C.total >= 0.4) f.push(`${pct(C.negative, C.total)}% of their comments have a negative score.`);
      if (C.repeated[0]) f.push(`The same comment was posted ${C.repeated[0].n} times.`);
    }
    if (V) {
      const tot = V.up + V.down;
      if (tot >= 50 && V.down / tot >= 0.7) f.push(`${pct(V.down, tot)}% of their post votes are downvotes (${V.down} of ${tot}).`);
      const top = Object.entries(V.byUploader).sort((a, b) => b[1].down - a[1].down)[0];
      if (top && top[1].down >= 10 && top[1].down / V.down >= 0.25) f.push(`${pct(top[1].down, V.down)}% of their downvotes (${top[1].down}) went to one uploader (${V.names[top[0]] || 'user #' + top[0]}).`);
      const topUp = Object.entries(V.byUploader).sort((a, b) => b[1].up - a[1].up)[0];
      if (topUp && topUp[1].up >= 10 && topUp[1].up / V.up >= 0.25) f.push(`${pct(topUp[1].up, V.up)}% of their upvotes (${topUp[1].up}) went to one uploader (${V.names[topUp[0]] || 'user #' + topUp[0]}).`);
      if (V.blDown.length >= 5 && V.blDown.length / V.down >= 0.2) f.push(`${V.blDown.length} of their ${V.down} downvotes (${pct(V.blDown.length, V.down)}%) were on posts their blacklist hides.`);
      const burst = maxInWindow(V.timesAll, 3600000);
      if (burst >= 100) f.push(`Cast up to ${burst} votes within a single hour.`);
      const quick = V.delaysDown.filter((h) => h <= 1).length;
      if (V.delaysDown.length >= 20 && quick / V.delaysDown.length >= 0.5) f.push(`${pct(quick, V.delaysDown.length)}% of their downvotes came within an hour of the post being uploaded.`);
    }
    const CV = state.cvotes && !state.cvotes.error ? state.cvotes : null;
    if (CV) {
      const ctot = CV.up + CV.down;
      if (ctot >= 30 && CV.down / ctot >= 0.7) f.push(`${pct(CV.down, ctot)}% of their comment votes are downvotes (${CV.down} of ${ctot}).`);
      const topC = Object.values(CV.byAuthor).sort((a, b) => b.down - a.down)[0];
      if (topC && topC.down >= 10 && topC.down / CV.down >= 0.25) f.push(`${pct(topC.down, CV.down)}% of their comment downvotes (${topC.down}) went to one commenter (${topC.name || 'user #' + topC.id}).`);
    }

    const B = state.blacklist;
    if (V && B && !B.error) {
      const tot = V.up + V.down, checked = V.downChecked || 0, unexplained = checked - V.blDown.length;
      if (checked >= 20 && tot && V.down / tot >= 0.5 && unexplained / checked >= 0.8) {
        f.push(`${unexplained} of their ${checked} downvotes (${pct(unexplained, checked)}%) were on posts their blacklist does not hide${B.entries.length ? '' : ' (their blacklist is empty)'}.`);
      }
      const often = Object.keys(V.tagDown).map((t) => ({ t, d: V.tagDown[t], u: V.tagUp[t] || 0 }))
        .filter((x) => x.d >= 10 && x.d / (x.d + x.u) >= 0.9 && !tagInBlacklist(B.entries, x.t))
        .sort((a, b) => b.d - a.d).slice(0, 3);
      if (often.length) f.push(`Tags they downvote almost every time without blacklisting: ${often.map((x) => `${x.t} (${x.d} of ${x.d + x.u})`).join(', ')}.`);
    }

    const created = state.user && Date.parse(state.user.created_at);
    if (created) {
      const age = (Date.now() - created) / 864e5;
      if (age <= 30) {
        const parts = [];
        if (P && P.total >= 50) parts.push(`${P.total} uploads`);
        if (V && V.up + V.down >= 300) parts.push(`${V.up + V.down} post votes`);
        if (C && C.total >= 100) parts.push(`${C.total} comments`);
        if (parts.length) f.push(`The account is only ${Math.max(1, Math.round(age))} day(s) old but already has ${parts.join(', ')}.`);
      }
    }
    const isNew = (id) => { const u = userInfo.get(String(id)), t = u && Date.parse(u.created_at); return !!t && Date.now() - t <= 30 * 864e5; };
    const nameOf = (id) => (userInfo.get(String(id)) || {}).name || 'user #' + id;
    for (const [what, R] of [['posts', state.recvPosts && state.recvPosts.A], ['comments', state.recvComments && state.recvComments.A]]) {
      if (!R) continue;
      const vs = Object.entries(R.byVoter);
      if (R.up >= 20) {
        const top3 = vs.map(([, v]) => v.up).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
        if (top3 / R.up >= 0.5) f.push(`3 voters account for ${pct(top3, R.up)}% of the upvotes on their ${what} (${top3} of ${R.up}).`);
      }
      const td = [...vs].sort((a, b) => b[1].down - a[1].down)[0];
      if (td && td[1].down >= 10 && td[1].down / R.down >= 0.25) f.push(`${pct(td[1].down, R.down)}% of the downvotes on their ${what} (${td[1].down}) came from one voter (${nameOf(td[0])}).`);
      const fresh = vs.filter(([id, v]) => v.up >= 5 && isNew(id));
      if (fresh.length) f.push(`${fresh.length} frequent upvoter(s) on their ${what} have accounts under 30 days old: ${fresh.slice(0, 5).map(([id, v]) => `${nameOf(id)} (${v.up})`).join(', ')}.`);
    }
    return f;
  }

  function secOverview() {
    const u = state.user;
    const keys = ['id', 'level_string', 'created_at', 'post_upload_count', 'post_update_count', 'note_update_count', 'is_banned'];
    const rows = keys.filter((k) => u[k] !== undefined).map((k) => [esc(k), esc(k === 'created_at' ? day(Date.parse(u[k])) : u[k])]);
    return section('Overview', `<div>${userLink(u.id, u.name)}</div>` + table(['Field', 'Value'], rows), true);
  }

  function sourcesTable(SS) {
    const kindLabel = { invalid: 'not a valid link', profile: 'profile or landing page', home: 'site front page', invite: 'invite link', submission: 'submission page', unknown: 'unknown' };
    const rows = SS.rows.slice(0, 30).map((g) => {
      const link = /^https?:\/\//i.test(g.url)
        ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">${esc(g.url.length > 70 ? g.url.slice(0, 67) + '…' : g.url)}</a>`
        : esc(g.url.length > 70 ? g.url.slice(0, 67) + '…' : g.url);
      const view = `<a href="/posts?tags=${encodeURIComponent('id:' + g.ids.slice(0, 100).join(','))}" target="_blank">view${g.ids.length > 100 ? ' first 100' : ''}</a>`;
      return [link, kindLabel[g.kind], g.ids.length, view];
    });
    return '<b>Sources worth checking</b>' +
      `<div class="hint">Anything that isn't a valid web link (listed first), sources shared by ${SAME_SOURCE_MIN}+ posts, any invite links (Discord or Telegram), and any that look like a profile or landing page instead of the original submission (judged from the link's shape; the script can't open the links, so check a few yourself). Deleted posts are left out.${SS.total > 30 ? ` Showing 30 of ${SS.total}.` : ''}</div>` +
      (rows.length ? table(['Source', 'Looks like', 'Posts', 'Find posts'], rows) : '<div class="hint">Nothing stands out.</div>');
  }

  function secPosts() {
    const S = state.posts.stats, who = String(state.user.name).replace(/ /g, '_');
    if (!S.total) return section('Uploads', '<div class="hint">No uploads found.</div>');
    const dom = Object.entries(S.domains).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, n]) => [searchLink(`user:${who} source:*${d}*`, d), n, pct(n, S.total) + '%']);
    const tags = Object.entries(S.tags).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => [searchLink(`user:${who} ${t}`, t), n]);
    const body = table(['Measure', 'Value'], [
      ['Total uploads', S.total],
      ['Active / pending / flagged / deleted', `${S.active} / ${S.pending} / ${S.flagged} / ${S.deleted}`],
      ['Ratings (s/q/e)', `${S.ratings.s || 0} / ${S.ratings.q || 0} / ${S.ratings.e || 0}`],
      ['Uploads in last 7 / 30 days', `${S.last7} / ${S.last30}`],
      ['Most uploads within one hour', S.maxPerHour],
      ['No source', `${S.noSource} (${pct(S.noSource, S.total)}%)`],
      ['With a malformed source', S.malformed],
      ['Average score / favorites', `${fnum(S.scoreSum / S.total)} / ${(S.favSum / S.total).toFixed(1)}`],
    ]) + '<b>Top source domains</b>' + table(['Domain', 'Posts', 'Share'], dom) + sourcesTable(S.sources) +
      '<b>Top tags</b>' + table(['Tag', 'Posts'], tags);
    return section('Uploads', body);
  }

  function secComments() {
    const S = state.comments.stats;
    if (!S.total) return section('Comments', '<div class="hint">No comments in this timespan.</div>');
    const body = table(['Measure', 'Value'], [
      ['Comments loaded', S.total],
      ['Negative score', `${S.negative} (${pct(S.negative, S.total)}%)`],
      ['Average score', fnum(S.scoreSum / S.total)],
      ['Hidden', S.hidden],
      ['Containing links', S.withLinks],
    ]) + (S.repeated.length ? '<b>Repeated comments</b>' + table(['Text', 'Times'], S.repeated.map((r) => [esc(r.body.slice(0, 120)), drill(esc(r.n), r.items, commentLink, 200)])) : '') +
      (S.byPost.length ? '<b>Posts they comment on most</b>' + table(['Post', 'Comments'], S.byPost.map((r) => [postLink(r.id), r.n])) : '');
    return section('Comments', body);
  }

  function uploaderRows(A, key, n = 10) {
    return Object.entries(A.byUploader).filter(([, v]) => v[key] > 0)
      .sort((a, b) => b[1][key] - a[1][key] || (b[1].up + b[1].down) - (a[1].up + a[1].down)).slice(0, n)
      .map(([id, v]) => [userLink(id, A.names[id]), drill(upN(v.up), v.upPosts, postLink), drill(downN(v.down), v.downPosts, postLink),
        num(v.up - v.down, sgnText(v.up - v.down)), pct(v[key], A[key]) + '%']);
  }

  function secVotes() {
    if (state.votes.error) return section('Votes on posts', `<div>${esc(state.votes.error)}</div>`, true);
    const A = state.votes.A, tot = A.up + A.down;
    if (!tot) return section('Votes on posts', '<div class="hint">No votes in this timespan.</div>');
    const med = (arr) => (arr.length ? median(arr).toFixed(1) + ' h' : 'n/a');
    const quick = A.delaysDown.filter((h) => h <= 1).length;
    const downRows = uploaderRows(A, 'down'), upRows = uploaderRows(A, 'up');
    const empty = '<div class="hint">None in this timespan.</div>';
    const body = table(['Measure', 'Value'], [
      ['Votes analysed', `${tot} (${upN(A.up)} / ${downN(A.down)})`],
      ['Downvote share', pct(A.down, tot) + '%'],
      ['Votes on posts that could not be loaded', A.missing],
      ['Most votes within one hour', maxInWindow(A.timesAll, 3600000)],
      ['Median time from upload to vote (down / up)', `${med(A.delaysDown)} / ${med(A.delaysUp)}`],
      ['Downvotes within 1 hour of upload', `${quick} (${pct(quick, A.delaysDown.length)}%)`],
    ]) + '<div class="hint">Click an Up or Down number to list the posts.</div>' +
      '<b>Uploaders they downvote most</b>' + (downRows.length ? table(['Uploader', 'Up', 'Down', 'Net', 'Share of downvotes'], downRows) : empty) +
      '<b>Uploaders they upvote most</b>' + (upRows.length ? table(['Uploader', 'Up', 'Down', 'Net', 'Share of upvotes'], upRows) : empty);
    return section('Votes on posts', body, true);
  }

  function secBlacklist() {
    const b = state.blacklist, V = state.votes && state.votes.A;
    if (!V) return '';
    if (!b.entries.length) {
      return section('Blacklist check', `<div class="hint">${b.error ? 'Could not read the blacklist: ' + esc(b.error) : 'This user has no blacklist, or it is empty.'}</div>`, true);
    }
    const uns = b.entries.filter((e) => e.unsupported);
    const hits = V.blHits || {};
    const { key, dir } = blSort;
    const val = { entry: (x) => x.e.raw.toLowerCase(), down: (x) => x.d, up: (x) => x.u, total: (x) => x.d + x.u }[key];
    const list = b.entries.map((e, i) => ({ e, i, d: (hits[e.raw] || {}).down || 0, u: (hits[e.raw] || {}).up || 0 }))
      .sort((x, y) => (val(x) < val(y) ? -1 : val(x) > val(y) ? 1 : 0) * dir || x.i - y.i);
    const th = (k, label) => `<th data-bl-sort="${k}" title="Click to sort">${label}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const entryTable = `<table><tr>${th('entry', 'Entry')}${th('down', 'Down')}${th('up', 'Up')}${th('total', 'Total')}</tr>${list.map((x) =>
      `<tr><td><code>${esc(x.e.raw)}</code>${x.e.unsupported ? ' <span class="hint">(skipped: unsupported syntax)</span>' : ''}</td><td>${downN(x.d)}</td><td>${upN(x.u)}</td><td>${x.d + x.u}</td></tr>`).join('')}</table>`;
    const rows = V.blDown.slice(0, 50).map((m) => [postLink(m.post.id), esc(day(Date.parse(m.vote.created_at))),
      userLink(m.post.uploader_id, m.post.uploader_name), `<code>${esc(m.entry.raw)}</code>`]);
    const src = b.source === 'staff' ? 'staff edit_blacklist page' : 'user profile';
    const body = `<div class="hint">Source: ${src}. This is their <i>current</i> blacklist, which may differ from what they had at the time of each vote.</div>` +
      table(['Measure', 'Value'], [
        ['Blacklist entries', b.entries.length - uns.length + (uns.length ? ` (+${uns.length} skipped: unsupported syntax)` : '')],
        ['Downvotes on blacklisted posts', `${V.blDown.length} of ${V.down} (${pct(V.blDown.length, V.down)}%)`],
        ['Upvotes on blacklisted posts', V.blUp],
      ]) +
      `<details><summary>Blacklist entries (${b.entries.length})</summary><div class="hint">Down/Up = how many of their votes landed on posts matched by that entry (first matching entry only). Click a column header to sort.</div>${entryTable}</details>` +
      (rows.length ? '<b>Downvoted posts their blacklist hides' + (V.blDown.length > 50 ? ' (first 50)' : '') + '</b>' + table(['Post', 'Voted', 'Uploader', 'Matched entry'], rows) : '');
    return section('Blacklist check', body, true);
  }

  function topVoters(R, key) {
    return Object.entries(R.byVoter).filter(([, v]) => v[key] > 0)
      .sort((a, b) => b[1][key] - a[1][key] || (b[1].up + b[1].down) - (a[1].up + a[1].down)).slice(0, VOTER_ROWS);
  }

  function receivedRows(R, key) {
    return topVoters(R, key)
      .map(([id, v]) => {
        const u = userInfo.get(String(id)), t = u && Date.parse(u.created_at);
        const joined = t ? (Date.now() - t <= 30 * 864e5 ? `<span class="ua-neg">${esc(day(t))} (new)</span>` : esc(day(t))) : (lookupFailed.has(String(id)) ? 'lookup failed' : '?');
        const link = R.kind === 'comments' ? (x) => commentLink({ id: x }) : postLink;
        return [userLink(id, u && u.name), joined, drill(upN(v.up), v.upItems, link), drill(downN(v.down), v.downItems, link),
          num(v.up - v.down, sgnText(v.up - v.down)), pct(v[key], R[key]) + '%'];
      });
  }

  function secReceived(title, kind, slot) {
    if (!slot) return '';
    if (slot.error) return section(title, `<div>${esc(slot.error)}</div>`);
    const R = Object.assign({ kind }, slot.A), tot = R.up + R.down;
    if (!tot) return section(title, '<div class="hint">No votes in this timespan.</div>');
    const vs = Object.values(R.byVoter);
    const share = (key) => (R[key] ? pct(vs.map((v) => v[key]).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0), R[key]) + '%' : 'n/a');
    const empty = '<div class="hint">None in this timespan.</div>', head = ['Voter', 'Joined', 'Up', 'Down', 'Net'];
    const dr = receivedRows(R, 'down'), ur = receivedRows(R, 'up');
    return section(title, table(['Measure', 'Value'], [
      ['Votes received', `${tot} (${upN(R.up)} / ${downN(R.down)})`],
      ['Different voters', vs.length],
      ['Top 3 voters\' share of upvotes / downvotes', `${share('up')} / ${share('down')}`],
    ]) + `<div class="hint">Click an Up or Down number to list the ${kind}. Names and join dates are looked up for the top voters only.</div>` +
      `<div class="hint">${esc(slot.note || '')}</div>` +
      '<b>Who upvotes them most</b>' + (ur.length ? table([...head, 'Share of upvotes'], ur) : empty) +
      '<b>Who downvotes them most</b>' + (dr.length ? table([...head, 'Share of downvotes'], dr) : empty));
  }

  function secTags() {
    const V = state.votes && state.votes.A;
    if (!V || !V.down) return '';
    const base = V.down / (V.up + V.down);
    const rows = Object.keys(V.tagDown).map((t) => ({ t, d: V.tagDown[t], u: V.tagUp[t] || 0 }))
      .filter((x) => x.d >= 3 && x.d + x.u >= 5 && x.d / (x.d + x.u) > base)
      .sort((a, b) => b.d / (b.d + b.u) - a.d / (a.d + a.u) || b.d - a.d).slice(0, 15)
      .map((x) => [searchLink(x.t, x.t), downN(x.d), upN(x.u), pct(x.d, x.d + x.u) + '%']);
    return section('Tags they downvote', `<div class="hint">Tags that appear on their downvoted posts more often than their overall downvote share (${Math.round(base * 100)}%). Needs at least 5 votes and 3 downvotes per tag.</div>` +
      table(['Tag', 'Down', 'Up', 'Downvote share'], rows));
  }

  function secCommentVotes() {
    const C = state.cvotes;
    if (!C) return '';
    if (C.error) return section('Votes on comments', `<div>${esc(C.error)}</div>`);
    if (!C.up && !C.down) return section('Votes on comments', '<div class="hint">No comment votes in this timespan.</div>');
    const rowsFor = (key) => Object.values(C.byAuthor).filter((v) => v[key] > 0)
      .sort((a, b) => b[key] - a[key] || (b.up + b.down) - (a.up + a.down)).slice(0, 10)
      .map((v) => [v.id !== undefined ? userLink(v.id, v.name) : esc(v.name), drill(upN(v.up), v.upItems, commentLink),
        drill(downN(v.down), v.downItems, commentLink), num(v.up - v.down, sgnText(v.up - v.down))]);
    const dr = rowsFor('down'), ur = rowsFor('up'), empty = '<div class="hint">None in this timespan.</div>';
    return section('Votes on comments', table(['Measure', 'Value'], [
      ['Votes analysed', `${C.up + C.down} (${upN(C.up)} / ${downN(C.down)})`],
      ['Downvote share', pct(C.down, C.up + C.down) + '%'],
      ['Comments that could not be loaded', C.missing],
    ]) + '<div class="hint">Click an Up or Down number to list the comments.</div>' +
      '<b>Commenters they downvote most</b>' + (dr.length ? table(['Commenter', 'Up', 'Down', 'Net'], dr) : empty) +
      '<b>Commenters they upvote most</b>' + (ur.length ? table(['Commenter', 'Up', 'Down', 'Net'], ur) : empty));
  }

  function render() {
    const root = $('ua-report');
    if (!state.user) { root.innerHTML = ''; return; }
    const opens = [...root.querySelectorAll('details')].map((d) => d.open);   // keep what the user expanded
    const flags = buildFlags();
    root.innerHTML =
      (flags.length ? `<div class="ua-flags"><b>Worth a look</b> <span class="hint">(prompts for review, not verdicts)</span><ul>${flags.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '') +
      secOverview() + (state.posts ? secPosts() : '') + (state.comments ? secComments() : '') +
      (state.votes ? secVotes() + secBlacklist() + secTags() : '') + secCommentVotes() +
      secReceived('Votes on their posts', 'posts', state.recvPosts) + secReceived('Votes on their comments', 'comments', state.recvComments);
    const ds = root.querySelectorAll('details');
    if (ds.length === opens.length) ds.forEach((d, i) => { d.open = opens[i]; });
  }

  // ---------- comment sample ----------
  function renderComments() {
    const box = $('ua-comments');
    if (!comments.length) { box.innerHTML = '<span class="hint">No comments loaded.</span>'; return; }
    const txt = $('ua-c-text').value.trim().toLowerCase();
    const maxRaw = $('ua-c-max').value;
    let list = comments.filter((c) => (!txt || String(c.body || '').toLowerCase().includes(txt)) &&
      (maxRaw === '' || (c.score ?? 0) <= Number(maxRaw)));
    const sort = $('ua-c-sort').value;
    const t = (c) => Date.parse(c.created_at);
    list.sort({
      new: (a, b) => t(b) - t(a),
      old: (a, b) => t(a) - t(b),
      low: (a, b) => (a.score ?? 0) - (b.score ?? 0) || t(b) - t(a),
      high: (a, b) => (b.score ?? 0) - (a.score ?? 0) || t(b) - t(a),
      long: (a, b) => String(b.body || '').length - String(a.body || '').length,
    }[sort]);
    const n = Math.max(1, parseInt($('ua-c-n').value, 10) || 20);
    box.innerHTML = `<div class="hint">Showing ${Math.min(n, list.length)} of ${list.length} matching (${comments.length} loaded)</div>` +
      list.slice(0, n).map((c) => {
        const body = String(c.body || '');
        return `<div class="ua-c"><div class="meta"><a href="/posts/${c.post_id}#comment-${c.id}" target="_blank">post #${c.post_id}</a> · ${esc(day(t(c)))} · score ${num(c.score ?? 0)}${c.is_hidden ? ' · hidden' : ''}</div><div>${esc(body.slice(0, 400))}${body.length > 400 ? '…' : ''}</div></div>`;
      }).join('');
  }
  ['ua-c-sort', 'ua-c-max', 'ua-c-text', 'ua-c-n'].forEach((id) => $(id).addEventListener('input', renderComments));

  // ---------- audit ----------
  async function runAudit() {
    stopFlag = false;
    $('ua-log').textContent = '';
    comments = [];
    state = {};
    userInfo = new Map();
    lookupFailed.clear();
    renderComments();
    const from = $('ua-from').value ? new Date($('ua-from').value + 'T00:00:00').getTime() : null;
    const to = $('ua-to').value ? new Date($('ua-to').value + 'T23:59:59.999').getTime() : null;
    const maxC = Math.max(10, parseInt($('ua-max-comments').value, 10) || 1000);
    const maxV = Math.max(10, parseInt($('ua-max-votes').value, 10) || 2000);

    try {
      setStatus('Looking up user…');
      const user = await getJSON(`/users/${profileId}.json`);
      if (!user || !user.id) return log('Could not load this user.');
      $('ua-name').textContent = '— ' + user.name;
      state.user = user;

      let blText = typeof user.blacklisted_tags === 'string' ? user.blacklisted_tags : '', blSource = 'profile', blError = null;
      if (!blText.trim() && $('ua-do-votes').checked) {
        try {
          setStatus('Loading blacklist from staff page…');
          blText = await fetchStaffBlacklist(user.id);
          blSource = 'staff';
        } catch (e) { blError = e.message; log('Staff blacklist page failed: ' + e.message); }
      }
      state.blacklist = { source: blSource, error: blError, entries: parseBlacklist(blText) };
      render();

      if ($('ua-do-posts').checked && !stopFlag) {
        try {
          const list = [];
          for await (const p of paged(`/posts.json?tags=${encodeURIComponent(`user:${user.name} status:any`)}&limit=320`, null, null)) {
            list.push(p);
            if (list.length % 100 === 0) setStatus(`Loading uploads: ${list.length}`);
            if (list.length >= 10000) { log('Stopped at 10000 uploads.'); break; }
          }
          state.posts = { stats: postStats(list, Date.now()) };
          state.uploadIds = list.map((p) => p.id);
          render();
        } catch (e) { log('Uploads failed: ' + e.message); }
      }

      if ($('ua-do-comments').checked && !stopFlag) {
        try {
          for await (const c of paged(`/comments.json?group_by=comment&search[creator_id]=${user.id}&limit=100`, from, to)) {
            comments.push(c);
            if (comments.length % 100 === 0) setStatus(`Loading comments: ${comments.length}`);
            if (comments.length >= maxC) break;
          }
          state.comments = { stats: commentStats(comments) };
          renderComments();
          render();
        } catch (e) { log('Comments failed: ' + e.message); }
      }

      if ($('ua-do-votes').checked && !stopFlag) await auditVotes(user, from, to, maxV);
      if ($('ua-do-received').checked && !stopFlag) await auditReceived(user, from, to, maxV);
    } catch (e) {
      log('Error: ' + e.message);
    } finally {
      setStatus(stopFlag ? 'Stopped.' : 'Done.');
      render();
    }
  }

  async function auditVotes(user, from, to, maxV) {
    const votes = [];
    try {
      setStatus('Loading post votes…');
      for await (const v of paged(`/post_votes.json?search[user_id]=${user.id}&limit=320`, from, to)) {
        if (v.user_id !== undefined && Number(v.user_id) !== Number(user.id)) throw new Error('The votes list did not filter by user, so it was not used.');
        votes.push(v);
        if (votes.length >= maxV) break;
      }
    } catch (e) {
      state.votes = { error: e.status === 403 || e.status === 401 || e.status === 404
        ? `Your role can't view post votes (${e.message}).` : 'Post votes failed: ' + e.message };
      render();
      return;
    }
    const ids = [...new Set(votes.map((v) => v.post_id))];
    const postMap = await fetchByIds(ids,
      (chunk) => `/posts.json?tags=${encodeURIComponent(`id:${chunk.join(',')} status:any`)}&limit=100`,
      (p) => p.id, 'voted posts');
    state.votes = { A: analyzeVotes(votes, postMap, state.blacklist.entries) };
    render();

    if (stopFlag) return;
    const cv = [];
    try {
      setStatus('Loading comment votes…');
      for await (const v of paged(`/comment_votes.json?search[user_id]=${user.id}&limit=320`, from, to)) {
        if (v.user_id !== undefined && Number(v.user_id) !== Number(user.id)) throw new Error('filter not honoured');
        cv.push(v);
        if (cv.length >= maxV) break;
      }
      const cids = [...new Set(cv.map((v) => v.comment_id))];
      const cmap = await fetchByIds(cids,
        (chunk) => `/comments.json?group_by=comment&search[id]=${chunk.join(',')}&limit=100`,
        (c) => c.id, 'voted comments');
      const C = { up: 0, down: 0, missing: 0, byAuthor: {} };
      for (const v of cv) {
        const dir = v.score > 0 ? 'up' : v.score < 0 ? 'down' : null;
        if (!dir) continue;
        C[dir]++;
        const c = cmap.get(v.comment_id);
        if (!c) { C.missing++; continue; }
        const key = c.creator_id ?? c.creator_name ?? '?';
        const a = (C.byAuthor[key] = C.byAuthor[key] || { id: c.creator_id, name: c.creator_name, up: 0, down: 0, upItems: [], downItems: [] });
        a[dir]++;
        a[dir + 'Items'].push({ id: c.id, post_id: c.post_id });
      }
      state.cvotes = C;
    } catch (e) {
      state.cvotes = { error: e.status === 403 || e.status === 401 || e.status === 404
        ? `Your role can't view comment votes (${e.message}).` : 'Comment votes failed: ' + e.message };
    }
    render();
  }

  // Votes other people cast on this user's posts and comments.
  // The vote lists only accept a creator filter together with a voter or item filter, so instead of
  // "votes on posts by X" we ask for votes on batches of X's own post/comment ids (newest first).
  async function auditReceived(user, from, to, maxV) {
    const SCAN_CAP = 3000, BATCH = 100;
    const fail = (e, what) => ({ error: [401, 403, 404].includes(e.status)
      ? `Your role can't view votes on their ${what} (${e.message}).` : `Votes on their ${what} failed: ${e.message}` });

    async function* uploadIds() {
      if (state.uploadIds) { for (const id of state.uploadIds) yield id; return; }
      for await (const p of paged(`/posts.json?tags=${encodeURIComponent(`user:${user.name} status:any`)}&limit=320`, null, null)) yield p.id;
    }
    async function* commentIds() {
      if (comments.length && !from && !to) { for (const c of comments) yield c.id; return; }
      for await (const c of paged(`/comments.json?group_by=comment&search[creator_id]=${user.id}&limit=100`, null, null)) yield c.id;
    }

    async function scan(what, endpoint, param, idKey, source) {
      const votes = [];
      let scanned = 0, batch = [], full = false;
      const flush = async () => {
        if (!batch.length) return;
        const set = new Set(batch.map(String));
        const ids = batch.join(',');
        batch = [];
        setStatus(`Loading votes on their ${what}: ${scanned} checked, ${votes.length} votes`);
        for await (const v of paged(`/${endpoint}.json?search[${param}]=${ids}&limit=320`, from, to)) {
          if (!set.has(String(v[idKey]))) throw new Error('the server returned votes for other items, so the list was not used');
          votes.push(v);
          if (votes.length >= maxV) { full = true; break; }
        }
      };
      for await (const id of source()) {
        if (stopFlag) break;
        batch.push(id); scanned++;
        if (batch.length >= BATCH) await flush();
        if (full || scanned >= SCAN_CAP) break;
      }
      if (!full && !stopFlag) await flush();
      const limited = full ? ' (stopped at the Max votes limit, so older ones may be missing)' : scanned >= SCAN_CAP ? ' (scan limit reached, older ones are not included)' : '';
      return { A: analyzeReceived(votes, idKey), note: `Covers votes on their ${scanned} most recent ${what}${limited}.` };
    }

    try {
      state.recvPosts = await scan('posts', 'post_votes', 'post_id', 'post_id', uploadIds);
    } catch (e) { state.recvPosts = fail(e, 'posts'); }
    render();
    if (stopFlag) return;

    try {
      state.recvComments = await scan('comments', 'comment_votes', 'comment_id', 'comment_id', commentIds);
    } catch (e) { state.recvComments = fail(e, 'comments'); }
    render();
    if (stopFlag) return;

    // names and account ages for exactly the voters shown in the tables
    const P = state.recvPosts && state.recvPosts.A, C = state.recvComments && state.recvComments.A;
    const ids = [...new Set([P && 'up', P && 'down'].filter(Boolean).flatMap((k) => topVoters(P, k).map((x) => x[0]))
      .concat([C && 'up', C && 'down'].filter(Boolean).flatMap((k) => topVoters(C, k).map((x) => x[0]))))]
      .filter((id) => !userInfo.has(String(id)));
    await lookupUsers(ids);
    render();
  }

  const lookupFailed = new Set();   // voter ids whose profile could not be loaded

  // Tries one batched request first, then falls back to one request per user for anything still missing.
  async function lookupUsers(ids) {
    const missing = new Set(ids.map(String));
    if (!missing.size) return;
    setStatus(`Looking up ${missing.size} voters…`);
    try {
      for (let i = 0; i < ids.length && !stopFlag; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const list = asList(await getJSON(`/users.json?search[id]=${chunk.join(',')}&limit=100`));
        for (const u of list) if (missing.has(String(u.id))) { userInfo.set(String(u.id), u); missing.delete(String(u.id)); }
        await sleep(DELAY);
      }
    } catch { /* fall back to one request per user below */ }
    let n = 0;
    for (const id of missing) {
      if (stopFlag) break;
      setStatus(`Looking up voters: ${++n}/${missing.size}`);
      try { userInfo.set(id, await getJSON(`/users/${id}.json`)); lookupFailed.delete(id); }
      catch (e) { lookupFailed.add(id); log(`Could not look up user #${id}: ${e.message}`); }
      await sleep(DELAY);
    }
    render();
  }

  $('ua-report').addEventListener('click', (e) => {
    const h = e.target.closest && e.target.closest('th[data-bl-sort]');
    if (!h) return;
    const key = h.dataset.blSort;
    blSort = { key, dir: blSort.key === key ? -blSort.dir : (key === 'entry' ? 1 : -1) };
    render();
  });

  $('ua-run').onclick = runAudit;
  $('ua-stop').onclick = () => { stopFlag = true; log('Stopping...'); };
})();
