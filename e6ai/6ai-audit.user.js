// ==UserScript==
// @name         e6AI User Audit
// @namespace    e6ai-admin-tools
// @version      1.34
// @icon         https://e6ai.net/packs/static/default-66793a8a1f9191d01666.svg
// @author       Jelloponies
// @description  Admin tool: on a user's profile page, audit their uploads, comments and votes (cast and received) and compare votes to their blacklist. Movable, resizable window.
// @match        https://e6ai.net/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const DELAY_FAST = 600;  // ms between requests at the start of each run
  const DELAY_SLOW = 1000; // ms between requests after the server has sent a 429
  let DELAY = DELAY_FAST;  // current delay; dropped to DELAY_SLOW on a 429 until the next run starts
  const MAX_RETRIES = 5;
  const PARALLEL = true;           // two request lanes at once (uploads/comments/received votes, and post/comment votes); false = one after the other
  const RECEIVED_SCAN_CAP = 1000;  // most of their own posts, and of their own comments, checked for votes they received (was 3000)
  const VOTER_ROWS = 10;   // voters shown per table; names are looked up for exactly these
  let stopFlag = false;
  let auditRunning = false;
  let comments = [];       // loaded comments, used by the sample view
  let state = {};          // results of the current audit
  let userInfo = new Map();  // voter id -> user JSON (names, account age)
  let blSort = { key: 'total', dir: -1 };   // sort order of the blacklist entries table
  let copyReg = [];                          // lists behind the "copy IDs" links of the current render
  const picked = new Set();                  // report sections ticked for "Export selected" (the ticks survive re-renders)
  let srcSort = { key: null, dir: 1 };      // sort order of the "Sources worth checking" table (null = default order)
  const SOURCE_ROWS_MAX = 100;               // most rows shown in that table
  const views = {};                          // per section: which list is shown, 'down' (default) or 'up'
  const secOpen = {};   // which report sections are open: none at first, and what you open is only kept until the next audit or page load

  // ---- pure helpers begin ----
  // A locked vote: flagged as locked by the server, or a vote with no direction (score 0, shown as "Locked" on the site's vote list).
  const isLockedVote = (v) => !!(v && (v.is_locked === true || v.locked === true || /lock/i.test(String(v.vote_type || v.type || v.vote || '')) || Number(v.score) === 0));
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
  const ONE_PERSON_DOWN_SHARE = 0.2;   // flag when one person accounts for at least this share of the downvotes (min. 10 downvotes): received from one voter, cast on one uploader or one commenter
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
  // 'profile' (a profile, channel, gallery or other landing page), 'invite' (a Discord invite or Telegram link), 'home' (just the site's front page) or 'unknown'.
  function classifySource(src) {
    const p = parseSource(src);
    if (!p) return 'invalid';   // not a web link at all (plain words, a version number, two links in one line, ...)
    const { host, segs, q } = p, n = segs.length, s0 = (segs[0] || '').toLowerCase();
    const on = (...d) => d.some((x) => host === x || host.endsWith('.' + x));
    // Discord invites and Telegram links count as 'invite' (discord.com/channels/... message links do not)
    if (on('discord.gg', 'dsc.gg', 'discord.me', 'discord.link', 't.me', 'telegram.me', 'telegram.dog')) return n ? 'invite' : 'home';
    if (['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host) && s0 === 'invite') return 'invite';
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
    const A = { up: 0, down: 0, other: 0, locked: 0, lockedPosts: [], missing: 0, byUploader: {}, names: {}, delaysDown: [], delaysUp: [],
      blDown: [], blUp: 0, blHits: {}, downChecked: 0, tagUp: {}, tagDown: {}, timesAll: [], timesDown: [] };
    for (const v of votes) {
      const dir = v.score > 0 ? 'up' : v.score < 0 ? 'down' : null;
      const locked = isLockedVote(v);
      if (!dir && !locked) { A.other++; continue; }
      if (locked) A.locked++;
      if (!dir) {   // a locked vote has no direction: counted on its own, per uploader
        const lp = postMap.get(v.post_id);
        if (!lp) { A.missing++; continue; }
        const lu = (A.byUploader[lp.uploader_id] = A.byUploader[lp.uploader_id] || { up: 0, down: 0, upPosts: [], downPosts: [] });
        lu.locked = (lu.locked || 0) + 1;
        (lu.lockedPosts = lu.lockedPosts || []).push(lp.id);
        A.lockedPosts.push(lp.id);
        if (lp.uploader_name) A.names[lp.uploader_id] = lp.uploader_name;
        continue;
      }
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
      if (locked) { u.locked = (u.locked || 0) + 1; (u.lockedPosts = u.lockedPosts || []).push(p.id); A.lockedPosts.push(p.id); }
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

  // On a user's profile page (/users/<id>) the audited user is that profile. On any other page the window only lists and opens saved audits.
  const profileMatch = location.pathname.match(/^\/users\/(\d+)\/?$/);
  const onProfile = !!profileMatch;
  const pageId = onProfile ? profileMatch[1] : null;     // the profile this page belongs to (null on other pages)
  let pageName = null;                                   // name of this page's profile, once known
  let profileId = pageId;                                // the user whose audit is shown / targeted; differs from pageId while a saved audit of someone else is open

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
    #ua-panel.ua-off .ua-ctl { display: none !important; }
    #ua-panel.ua-off #ua-log:empty, #ua-panel.ua-off #ua-bar, #ua-panel.ua-off #ua-status:empty { display: none !important; }
    #ua-panel #ua-saved { padding-top: 14px; }
    #ua-panel #ua-log:empty { display: none; }
    #ua-panel .ua-badge { margin-left: 8px; padding: 1px 7px; border-radius: 3px; background: var(--ua-neg); color: #000; font-size: 10px; font-weight: bold; letter-spacing: .04em; vertical-align: middle; }
    #ua-panel #ua-tabs { position: sticky; top: calc(var(--ua-head-h, 38px) - 13px); z-index: 1; display: flex; flex-wrap: wrap; gap: 4px; margin: -6px -12px 10px; padding: 8px 12px 0;
      background: var(--ua-section); border-bottom: 1px solid var(--ua-section-light); }
    #ua-panel button.ua-tab { display: flex; flex-direction: column; align-items: flex-start; margin: 0 0 -1px; padding: 6px 14px 5px; text-align: left; line-height: 1.25;
      border-radius: 6px 6px 0 0; border-bottom-color: var(--ua-section-light); background: var(--ua-foreground); color: var(--ua-muted); }
    #ua-panel button.ua-tab .t1 { font-size: 13px; font-weight: bold; color: var(--ua-link); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ua-panel button.ua-tab .t2 { font-size: 10px; color: var(--ua-muted); }
    #ua-panel button.ua-tab.ua-tab-on { background: var(--ua-section); border-color: var(--ua-section-light); border-top: 2px solid var(--ua-accent); border-bottom-color: var(--ua-section); cursor: default; }
    #ua-panel button.ua-tab.ua-tab-on .t1 { color: var(--ua-text); }
    #ua-panel button.ua-tab.ua-tab-other.ua-tab-on { background: #5a1a1a; border-top-color: var(--ua-neg); border-bottom-color: #5a1a1a; }
    #ua-panel button.ua-tab.ua-tab-other .t2 { color: #ffb0b0; }
    #ua-panel .ua-saved-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 6px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--ua-section-light); }
    #ua-panel .ua-saved-head b { color: var(--ua-accent); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
    #ua-panel .ua-cardrow { display: flex; gap: 6px; align-items: stretch; margin-bottom: 6px; }
    #ua-panel .ua-cardrow a.ua-card { flex: 1; margin-bottom: 0; min-width: 0; }
    #ua-panel .ua-cardrow button.ua-del { margin: 0; padding: 0 14px; min-width: 46px; font-size: 15px; color: var(--ua-neg); }
    #ua-panel .ua-cardrow button.ua-del.ua-armed { background: #5a1a1a; border-color: var(--ua-neg); color: #fff; font-size: 12px; font-weight: bold; }
    #ua-panel a.ua-card { display: flex; align-items: center; gap: 12px; padding: 10px 14px; margin-bottom: 6px; background: var(--ua-foreground);
      border: 1px solid var(--ua-section-light); border-radius: 6px; text-decoration: none !important; }
    #ua-panel a.ua-card:hover { background: var(--ua-background); border-color: var(--ua-hover); }
    #ua-panel a.ua-card .nm { font-size: 14px; font-weight: bold; }
    #ua-panel a.ua-card .id { font-size: 11px; color: var(--ua-muted); }
    #ua-panel a.ua-card .when { margin-left: auto; text-align: right; font-size: 11px; line-height: 1.35; color: var(--ua-muted); }
    #ua-panel a.ua-card .when b { display: block; color: var(--ua-text); font-weight: normal; }
    #ua-panel a.ua-card .go { color: var(--ua-accent); font-size: 18px; line-height: 1; }
    #ua-panel.ua-other { border-color: var(--ua-neg); box-shadow: 0 0 0 2px var(--ua-neg), 0 4px 20px rgba(0,0,0,.7); }
    #ua-panel .ua-warn { flex-basis: 100%; padding: 7px 10px; border-radius: 4px; background: #5a1a1a; border: 1px solid var(--ua-neg); color: #fff; font-size: 12px; line-height: 1.4; }
    #ua-panel .ua-warn b { color: var(--ua-link); }
    #ua-panel .ua-savedbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 8px; padding: 8px 10px; background: var(--ua-foreground); border: 1px solid var(--ua-section-light); border-radius: 6px; }
    #ua-panel .ua-savedbar button { margin: 0; }
    #ua-panel .ua-savedbar .ua-back { font-weight: bold; }
    #ua-panel .ua-savedbar .ua-clear { color: var(--ua-neg); }
    #ua-panel .ua-savedbar .hint { flex-basis: 100%; }
    #ua-panel .ua-info { flex-basis: 100%; padding: 7px 10px; border-radius: 4px; background: #3a3320; border: 1px solid var(--ua-accent); color: var(--ua-text); font-size: 12px; line-height: 1.4; }
    #ua-panel .ua-info b { color: var(--ua-accent); }
    #ua-panel .ua-cov { flex-basis: 100%; font-size: 12px; line-height: 1.5; padding: 2px 4px 0; color: var(--ua-text); }
    #ua-panel .ua-cov div { margin: 1px 0; }
    #ua-panel .ua-cov .k { opacity: .7; }
    #ua-panel .ua-cov .cap { color: var(--ua-neg); font-weight: bold; }
    #ua-panel #ua-stamp, #ua-panel .ua-savedbar, #ua-panel .ua-info { max-width: none !important; width: auto !important; box-sizing: border-box; }   /* the site styles .hint boxes with a width limit; these boxes must follow the window */
    #ua-panel .hint { font-size: 11px; color: var(--ua-muted); }
    #ua-panel a { color: var(--ua-link); text-decoration: none; }
    #ua-panel a:hover { color: var(--ua-hover); text-decoration: underline; }
    #ua-panel code { color: var(--ua-text); }
    #ua-panel th[data-bl-sort], #ua-panel th[data-src-sort] { cursor: pointer; user-select: none; }
    #ua-panel th[data-bl-sort]:hover, #ua-panel th[data-src-sort]:hover { color: var(--ua-hover); }
    #ua-panel table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
    #ua-panel th, #ua-panel td { border-bottom: 1px solid var(--ua-foreground); padding: 2px 6px; text-align: left; font-size: 12px; vertical-align: top; }
    #ua-panel th { color: #e6e6e6; background: var(--ua-foreground); }
    #ua-panel details { margin-top: 8px; }
    #ua-panel summary { cursor: pointer; font-weight: bold; }
    #ua-panel summary:hover { color: var(--ua-hover); }
    /* "Sources worth checking": a boxed, accent-coloured bar so it stands out between the plain tables */
    #ua-panel details.ua-src { margin: 12px 0; border: 1px solid var(--ua-accent); border-radius: 5px; background: var(--ua-foreground); }
    #ua-panel details.ua-src > summary { padding: 5px 8px; color: var(--ua-accent); }
    #ua-panel details.ua-src > summary:hover { color: var(--ua-hover); }
    #ua-panel details.ua-src > :not(summary) { margin-left: 8px; margin-right: 8px; }
    #ua-panel details.ua-src[open] > summary { border-bottom: 1px solid var(--ua-section-light); margin-bottom: 4px; }
    #ua-panel details.ua-src > table { width: calc(100% - 16px); margin-bottom: 8px; }
    #ua-panel .ua-flags a { color: var(--ua-text); border-bottom: 1px dotted var(--ua-muted); }
    #ua-panel .ua-flags a:hover { color: var(--ua-hover); text-decoration: none; }
    #ua-panel .ua-allbar { text-align: right; }
    #ua-panel details { scroll-margin-top: 44px; }
    #ua-panel .ua-grp { margin: 18px 0 2px; padding-bottom: 3px; font-size: 11px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase;
      color: var(--ua-accent); border-bottom: 1px solid var(--ua-section-light); }
    #ua-panel button.ua-on { color: var(--ua-accent); border-color: var(--ua-accent); }
    #ua-panel details.ua-x { display: inline-block; margin: 0; }
    #ua-panel details.ua-x > summary { font-weight: normal; }
    #ua-panel .ua-links { max-width: 330px; max-height: 120px; overflow: auto; line-height: 1.5; }
    /* inside tables the list opens in its own full-width row (see the toggle handler), so no column resizes */
    #ua-panel tr details.ua-x > .ua-links { display: none; }
    #ua-panel tr.ua-xrow td { padding: 3px 6px 6px 18px; background: var(--ua-foreground); }
    #ua-panel tr.ua-xrow .ua-links { max-width: none; max-height: 140px; }
    #ua-head { position: sticky; top: -12px; z-index: 2; margin: -12px -12px 6px; padding: 8px 12px; background: var(--ua-background);
      border-bottom: 1px solid var(--ua-section-light); cursor: move; user-select: none; touch-action: none; border-radius: 8px 8px 0 0; }
    #ua-head #ua-close { float: right; margin: 0; padding: 0 7px; cursor: pointer; }
    #ua-status { margin-top: 8px; font-weight: bold; font-size: 12px; color: var(--ua-accent); }
    #ua-bar { position: relative; display: none; margin-top: 6px; height: 14px; background: var(--ua-background); border: 1px solid var(--ua-foreground); border-radius: 7px; overflow: hidden; }
    #ua-bar-fill { height: 100%; width: 0; background: var(--ua-accent); transition: width .25s ease; }
    #ua-bar-text { position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 14px; font-weight: bold; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; }
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
    #ua-panel .ua-tools { margin-top: 10px; }
    #ua-panel .ua-tools button { margin-top: 0; }
    #ua-panel a.ua-cp { font-size: 11px; color: var(--ua-muted); margin-left: 4px; white-space: nowrap; border-bottom: 0; }
    #ua-panel input[data-pick] { margin: 0 5px 0 0; vertical-align: middle; cursor: pointer; }
    #ua-panel ul.ua-ul { list-style: disc outside; margin: 2px 0 6px; padding: 0 0 0 20px; }
    #ua-panel ul.ua-ul li { display: list-item; list-style: disc outside; margin: 2px 0; }
  `);

  const panel = document.createElement('div');
  panel.id = 'ua-panel';
  panel.innerHTML = `
    <div id="ua-head"><button id="ua-close" title="Close">✕</button><b>User Audit</b> <span id="ua-name">${onProfile ? '— user #' + profileId : '— saved audits'}</span><span id="ua-badge" class="ua-badge" style="display:none">SAVED COPY</span> <span class="hint">(drag to move)</span></div>
    <div id="ua-tabs"></div>
    <div class="row ua-ctl">
      <label>From <input type="date" id="ua-from"></label>
      <label>To <input type="date" id="ua-to"></label>
      <button id="ua-7">7d</button><button id="ua-30">30d</button><button id="ua-90">90d</button><button id="ua-all">All</button>
      <div class="hint">Timespan applies to comments and votes. Uploads are always the whole account. Max votes applies to each vote list separately.</div>
    </div>
    <div class="row ua-ctl">
      <label><input type="checkbox" id="ua-do-posts" checked> Uploads</label>
      <label><input type="checkbox" id="ua-do-comments" checked> Comments</label>
      <label><input type="checkbox" id="ua-do-votes" checked> Votes cast</label>
      <label><input type="checkbox" id="ua-do-received" checked> Votes received</label>
    </div>
    <div class="row ua-ctl">
      <label>Max comments <input type="number" id="ua-max-comments" value="1000" min="10" style="width:70px"></label>
      <label>Max votes <input type="number" id="ua-max-votes" value="2000" min="10" style="width:70px"></label>
    </div>
    <div class="ua-ctl">
      <button id="ua-run">Run audit</button>
      <button id="ua-quick" title="Uploads and comments only: no votes and no replacement scan. Not saved, so your last full audit is kept.">Quick audit</button>
      <button id="ua-stop">Stop</button>
    </div>
    <div id="ua-status"></div>
    <div id="ua-bar"><div id="ua-bar-fill"></div><span id="ua-bar-text"></span></div>
    <div id="ua-saved" style="display:none"></div>
    <div id="ua-stamp" class="hint" style="display:none"></div>
    <div id="ua-log"></div>
    <div id="ua-report"></div>
    <details id="ua-sample" data-sec="Comment sample" style="display:none">
      <summary><input type="checkbox" data-pick="Comment sample" title="Include in Export selected"> Comment sample</summary>
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
  panel.classList.toggle('ua-off', !onProfile);
  const toggle = document.createElement('button');
  toggle.id = 'ua-toggle';
  toggle.textContent = 'User Audit';
  let placed = false;
  const closePanel = () => { panel.style.display = 'none'; };
  toggle.onclick = () => {
    if (panel.style.display === 'block') return closePanel();
    panel.style.display = 'block';
    placePanel();
    if (!onProfile) { if (!state.user) showSavedList(); }
    else if (!state.user) { setStatus('Ready. Set the options you want, then press "Run audit".'); fillOwnName(); }
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

  // ---------- progress bar ----------
  // An estimate. Each lane's tasks are weighted and the bar follows the slower lane, because the run ends when both are done.
  // Where a total is known (their upload / comment counts, the lists of voted items, the date range) the fill is exact;
  // otherwise a soft curve is used that creeps up but never reaches the end before the work does.
  const PROGRESS_TASKS = {
    posts: ['A', 3], comments: ['A', 3], recvPosts: ['A', 3], recvComments: ['A', 2], voters: ['A', 1],
    replaced: ['A', 1], votes: ['B', 4], votedPosts: ['B', 2], cvotes: ['B', 2], votedComments: ['B', 1],
  };
  let progress = { tasks: {}, shown: 0, active: false, pct: -1, label: '' };
  const soft = (n, k) => n / (n + k);
  function progressOverall() {
    if (!progress.active) return 0.01;
    const sum = { A: [0, 0], B: [0, 0] };
    for (const t of Object.values(progress.tasks)) { sum[t.lane][0] += t.w * t.f; sum[t.lane][1] += t.w; }
    const frac = (v) => (v[1] ? v[0] / v[1] : 1);
    return 0.03 + 0.97 * Math.min(frac(sum.A), frac(sum.B));
  }
  function progressRender(label = '') {
    progress.shown = Math.max(progress.shown, progressOverall());
    const pct = Math.min(100, Math.floor(progress.shown * 100));
    if (pct === progress.pct && label === progress.label) return;
    progress.pct = pct; progress.label = label;
    $('ua-bar').style.display = 'block';
    $('ua-bar-fill').style.width = pct + '%';
    $('ua-bar-text').textContent = pct + '%' + label;
  }
  function progressReset() { progress = { tasks: {}, shown: 0, active: false, pct: -1, label: '' }; progressRender(); }
  function progressStart(names) {
    for (const n of names) progress.tasks[n] = { lane: PROGRESS_TASKS[n][0], w: PROGRESS_TASKS[n][1], f: 0 };
    progress.active = true;
    progressRender();
  }
  function progressSet(name, f) {
    const t = progress.tasks[name];
    if (!t) return;
    f = Math.max(0, Math.min(1, f));
    if (f > t.f) { t.f = f; progressRender(); }
  }
  function progressLaneDone(lane) {
    if (stopFlag) return;
    for (const t of Object.values(progress.tasks)) if (t.lane === lane) t.f = 1;
    progressRender();
  }
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
    const cp = ` <a href="#" class="ua-cp" data-copy="${copyReg.push({ kind: link === postLink ? 'post' : 'comment', items }) - 1}" title="Copies as DText (post #123). Shift-click for a plain comma-separated list of IDs.">[copy ${items.length} IDs]</a>`;
    return `<details class="ua-x"><summary>${summaryHtml}</summary><div class="ua-links">${items.slice(0, cap).map(link).join(' ')}${items.length > cap ? ` … +${items.length - cap} more` : ''}${cp}</div></details>`;
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
  panel.addEventListener('toggle', (e) => {   // remember which sections are open
    const d = e.target;
    if (!d.matches || !d.matches('details[data-sec]')) return;
    secOpen[d.dataset.sec] = d.open;
  }, true);
  $('ua-sample').open = !!secOpen['Comment sample'];
  function holdHeight() { const root = $('ua-report'); root.style.minHeight = root.offsetHeight + 'px'; }   // keeps the report from shrinking under the scroll position
  // Collapsing or expanding a section while scrolled down could shrink the panel and make the view jump, so the report keeps its height until the next re-render.
  panel.addEventListener('click', (e) => {
    const sm = e.target.closest && e.target.closest('summary');
    const d = sm && sm.parentElement;
    if (!d || !d.matches('details[data-sec]')) return;
    holdHeight();   // hold the current height both when collapsing and when expanding, so nothing shrinks and the view stays put
  }, true);
  // The blank space left by the height hold shrinks as you scroll up: whatever lies below the visible area is trimmed, but never real content.
  let shrinkQueued = false;
  panel.addEventListener('scroll', () => {
    if (shrinkQueued) return;
    shrinkQueued = true;
    requestAnimationFrame(() => {
      shrinkQueued = false;
      const root = $('ua-report');
      if (!parseFloat(root.style.minHeight)) return;
      const st = panel.scrollTop;
      const below = panel.scrollHeight - st - panel.clientHeight;
      if (below < 2) return;
      const cur = root.offsetHeight;
      root.style.minHeight = '0px';
      const natural = root.offsetHeight;
      const want = Math.max(natural, cur - below);
      root.style.minHeight = want > natural + 1 ? want + 'px' : '';
      panel.scrollTop = st;
    });
  }, { passive: true });
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
  // Spaces request START times DELAY apart per lane, so time spent waiting on the server counts toward the delay.
  // Two lanes run at once, so the combined rate is up to twice 1/DELAY. After a 429 all lanes share one slot
  // (combined rate = DELAY_SLOW) and every lane waits out the pause.
  let slots = {};
  let pauseUntil = 0;
  let runStats = { start: Date.now(), requests: 0, retries: 0, rateLimited: 0, slowedAfter: null };   // numbers for the end-of-run summary
  async function throttle(lane = 'A') {
    const key = DELAY === DELAY_SLOW ? 'all' : lane;
    const now = Date.now(), at = Math.max(now, slots[key] || 0, pauseUntil);
    slots[key] = at + DELAY;
    runStats.requests++;
    if (at > now) await sleep(at - now);
  }

  function logRunSummary() {
    const sec = (Date.now() - runStats.start) / 1000;
    const took = sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${sec.toFixed(1)}s`;
    const rl = runStats.rateLimited
      ? `rate limited ${runStats.rateLimited}x (429)` + (runStats.slowedAfter !== null ? `, slowed to ${DELAY_SLOW}ms after ${Math.round(runStats.slowedAfter / 1000)}s` : '')
      : 'no rate limiting';
    const retries = runStats.retries ? ` | ${runStats.retries} ${runStats.retries === 1 ? 'retry' : 'retries'}` : '';
    log(`${stopFlag ? 'Stopped after' : 'Finished in'} ${took} | ${runStats.requests} requests (${(runStats.requests / Math.max(sec, 0.1)).toFixed(1)}/s) | ${rl}${retries}`);
  }

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
        if (e.status === 429) runStats.rateLimited++;
        const retryable = e.status === undefined || e.status === 429 || e.status >= 500;
        if (!retryable || attempt >= MAX_RETRIES || stopFlag) throw e;
        if (e.status === 429 && DELAY !== DELAY_SLOW) { DELAY = DELAY_SLOW; if (runStats.slowedAfter === null) runStats.slowedAfter = Date.now() - runStats.start; log(`  ... rate limited (429), slowing to ${DELAY_SLOW}ms for the rest of this run`); }
        const ms = e.retryAfter || wait;
        if (e.status === 429) pauseUntil = Math.max(pauseUntil, Date.now() + ms);
        runStats.retries++;
        log(`  ... ${label}: ${e.message}, retrying in ${Math.round(ms / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(ms);
        wait = Math.min(wait * 2, 60000);
      }
    }
  }

  const getJSON = (url, lane) => withRetry(async () => {
    await throttle(lane);
    const r = checkOk(await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
    return r.json();
  }, url.split('?')[0]);

  // Staff-only page: https://e6ai.net/staff/users/<id>/edit_blacklist. The blacklist is in the form's textarea.
  async function fetchStaffBlacklist(id) {
    await throttle();
    const r = checkOk(await fetch(`/staff/users/${id}/edit_blacklist`, { credentials: 'same-origin', headers: { Accept: 'text/html' } }));
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const ta = doc.querySelector('textarea[name="user[blacklisted_tags]"], textarea#user_blacklisted_tags')
      || doc.querySelector('form textarea');
    if (!ta) throw new Error('no blacklist textarea found on the page');
    return ta.value || '';
  }

  const asList = (d) => (Array.isArray(d) ? d : d.posts || d.comments || d.post_votes || d.comment_votes || d.votes || []);

  // Walks a newest-first listing page by page, honouring the from/to window (ms timestamps or null).
  async function* paged(url, from, to, capUnknown, lane) {
    let page = '1';
    const lim = Number((/[?&]limit=(\d+)/.exec(url) || [])[1]) || 0;
    while (!stopFlag) {
      const list = asList(await getJSON(`${url}${url.includes('?') ? '&' : '?'}page=${page}`, lane));
      if (!list.length) return;
      for (const item of list) {
        const t = Date.parse(item.created_at);
        if (from && t < from) return;
        if (to && t > to) continue;
        yield item;
      }
      // short page = last page, no need to request an empty one
      // (capUnknown: the server may cap the page size below the requested limit, so only a page under 100 counts as short)
      if (lim && list.length < (capUnknown ? Math.min(lim, 100) : lim)) return;
      page = 'b' + list[list.length - 1].id;
    }
  }

  async function fetchByIds(ids, urlFor, keyOf, label, lane, task) {
    const map = new Map();
    const BATCH = 100;
    let individual = false;
    for (let i = 0; i < ids.length && !stopFlag; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      if (!individual) {
        const got = asList(await getJSON(urlFor(chunk), lane));
        got.forEach((x) => map.set(keyOf(x), x));
        if (i === 0 && !got.length) {
          log(`Batch lookup of ${label} returned nothing; falling back to one request each (capped at 300).`);
          individual = true;
        } else { setStatus(`Loading ${label}: ${Math.min(i + BATCH, ids.length)}/${ids.length}`); progressSet(task, Math.min(i + BATCH, ids.length) / ids.length * 0.98); continue; }
      }
      for (const id of chunk.slice(0, Math.max(0, 300 - map.size))) {
        if (stopFlag) break;
        try { const x = await getJSON(urlFor([id]), lane); asList(x).forEach((y) => map.set(keyOf(y), y)); } catch { /* skip */ }
        setStatus(`Loading ${label}: ${map.size}`);
        progressSet(task, map.size / Math.max(1, Math.min(300, ids.length)) * 0.98);
      }
      break;
    }
    progressSet(task, 1);
    return map;
  }

  // ---------- report rendering ----------
  const table = (head, rows) => rows.length
    ? `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
    : '<div class="hint">Nothing to show.</div>';
  const section = (title, body) => `<details data-sec="${esc(title)}"${secOpen[title] ? ' open' : ''}><summary><input type="checkbox" data-pick="${esc(title)}" title="Include in Export selected"${picked.has(title) ? ' checked' : ''}> ${esc(title)}</summary>${body}</details>`;
  const viewOf = (key) => (views[key] === 'up' ? 'up' : 'down');
  const viewToggle = (key, downLabel, upLabel) => { const v = viewOf(key); return `<div><button data-view-key="${esc(key)}" data-view="down" class="${v === 'down' ? 'ua-on' : ''}">${esc(downLabel)}</button><button data-view-key="${esc(key)}" data-view="up" class="${v === 'up' ? 'ua-on' : ''}">${esc(upLabel)}</button></div>`; };
  const group = (title, html) => (html ? `<div class="ua-grp">${esc(title)}</div>${html}` : '');

  function buildFlags() {
    const f = [];
    const add = (sec, view, sub, t) => f.push({ t, sec, view, sub });
    const P = state.posts && state.posts.stats, C = state.comments && state.comments.stats, V = state.votes && state.votes.A;
    if (P && P.total >= 20) {
      if (P.topDomain && P.topDomainCount / P.total >= 0.5) add('Uploads', null, null, `${pct(P.topDomainCount, P.total)}% of their uploads list the same source domain (${P.topDomain}).`);
      if (P.deleted / P.total >= 0.25) add('Uploads', null, null, `${pct(P.deleted, P.total)}% of their uploads are deleted.`);
    }
    if (P && P.sources) {
      const SS = P.sources, see = ' Details under Uploads → Sources worth checking.', kindText = { profile: ' (looks like a profile or landing page)', home: ' (just a site front page)', invite: ' (an invite link)' };
      if (SS.invalidPosts >= INVALID_SOURCE_FLAG) add('Uploads', null, 'src', `${SS.invalidPosts} of their posts ${SS.invalidPosts === 1 ? 'has' : 'have'} a source that isn't a valid web link (most common: "${SS.invalidTop.url}", ${SS.invalidTop.ids.length} post${SS.invalidTop.ids.length === 1 ? '' : 's'}).${see}`);
      if (SS.sameTop) add('Uploads', null, 'src', `${SS.sameTop.ids.length} of their posts list the identical source ${SS.sameTop.url}${kindText[SS.sameTop.kind] || ''}.${see}`);
      if (SS.landingPosts >= PROFILE_SOURCE_FLAG) add('Uploads', null, 'src', `${SS.landingPosts} of their posts ${SS.landingPosts === 1 ? 'has' : 'have'} a source that looks like a profile or landing page.${see}`);
      if (SS.chatPosts >= CHAT_SOURCE_FLAG) add('Uploads', null, 'src', `${SS.chatPosts} of their posts ${SS.chatPosts === 1 ? 'has' : 'have'} a source that is an invite link.${see}`);
    }
    if (P && P.maxPerHour >= 50) add('Uploads', null, null, `Uploaded up to ${P.maxPerHour} posts within a single hour.`);
    if (C) {
      if (C.total >= 10 && C.negative / C.total >= 0.4) add('Comments', null, null, `${pct(C.negative, C.total)}% of their comments have a negative score.`);
      if (C.repeated[0]) add('Comments', null, null, `The same comment was posted ${C.repeated[0].n} times.`);
    }
    if (V) {
      const tot = V.up + V.down;
      if (tot >= 50 && V.down / tot >= 0.7) add('Votes on posts', 'down', null, `${pct(V.down, tot)}% of their post votes are downvotes (${V.down} of ${tot}).`);
      const top = Object.entries(V.byUploader).sort((a, b) => b[1].down - a[1].down)[0];
      if (top && top[1].down >= 10 && top[1].down / V.down >= ONE_PERSON_DOWN_SHARE) add('Votes on posts', 'down', null, `${pct(top[1].down, V.down)}% of their downvotes (${top[1].down}) went to one uploader (${V.names[top[0]] || 'user #' + top[0]}).`);
      const topUp = Object.entries(V.byUploader).sort((a, b) => b[1].up - a[1].up)[0];
      if (topUp && topUp[1].up >= 10 && topUp[1].up / V.up >= 0.25) add('Votes on posts', 'up', null, `${pct(topUp[1].up, V.up)}% of their upvotes (${topUp[1].up}) went to one uploader (${V.names[topUp[0]] || 'user #' + topUp[0]}).`);
      if (V.blDown.length >= 5 && V.blDown.length / V.down >= 0.2) add('Blacklist check', null, null, `${V.blDown.length} of their ${V.down} downvotes (${pct(V.blDown.length, V.down)}%) were on posts their blacklist hides.`);
      const burst = maxInWindow(V.timesAll, 3600000);
      if (burst >= 100) add('Votes on posts', null, null, `Cast up to ${burst} votes within a single hour.`);
      const quick = V.delaysDown.filter((h) => h <= 1).length;
      if (V.delaysDown.length >= 20 && quick / V.delaysDown.length >= 0.5) add('Votes on posts', 'down', null, `${pct(quick, V.delaysDown.length)}% of their downvotes came within an hour of the post being uploaded.`);
    }
    const CV = state.cvotes && !state.cvotes.error ? state.cvotes : null;
    if (CV) {
      const ctot = CV.up + CV.down;
      if (ctot >= 30 && CV.down / ctot >= 0.7) add('Votes on comments', 'down', null, `${pct(CV.down, ctot)}% of their comment votes are downvotes (${CV.down} of ${ctot}).`);
      const topC = Object.values(CV.byAuthor).sort((a, b) => b.down - a.down)[0];
      if (topC && topC.down >= 10 && topC.down / CV.down >= ONE_PERSON_DOWN_SHARE) add('Votes on comments', 'down', null, `${pct(topC.down, CV.down)}% of their comment downvotes (${topC.down}) went to one commenter (${topC.name || 'user #' + topC.id}).`);
    }

    const B = state.blacklist;
    if (V && B && !B.error) {
      const tot = V.up + V.down, checked = V.downChecked || 0, unexplained = checked - V.blDown.length;
      if (checked >= 20 && tot && V.down / tot >= 0.5 && unexplained / checked >= 0.8) {
        add('Blacklist check', null, null, `${unexplained} of their ${checked} downvotes (${pct(unexplained, checked)}%) were on posts their blacklist does not hide${B.entries.length ? '' : ' (their blacklist is empty)'}.`);
      }
      const often = Object.keys(V.tagDown).map((t) => ({ t, d: V.tagDown[t], u: V.tagUp[t] || 0 }))
        .filter((x) => x.d >= 10 && x.d / (x.d + x.u) >= 0.9 && !tagInBlacklist(B.entries, x.t))
        .sort((a, b) => b.d - a.d).slice(0, 3);
      if (often.length) add('Tags they vote on', 'down', null, `Tags they downvote almost every time without blacklisting: ${often.map((x) => `${x.t} (${x.d} of ${x.d + x.u})`).join(', ')}.`);
    }

    const created = state.user && Date.parse(state.user.created_at);
    if (created) {
      const age = (Date.now() - created) / 864e5;
      if (age <= 30) {
        const parts = [];
        if (P && P.total >= 50) parts.push(`${P.total} uploads`);
        if (V && V.up + V.down >= 300) parts.push(`${V.up + V.down} post votes`);
        if (C && C.total >= 100) parts.push(`${C.total} comments`);
        if (parts.length) add('Overview', null, null, `The account is only ${Math.max(1, Math.round(age))} day(s) old but already has ${parts.join(', ')}.`);
      }
    }
    const isNew = (id) => { const u = userInfo.get(String(id)), t = u && Date.parse(u.created_at); return !!t && Date.now() - t <= 30 * 864e5; };
    const nameOf = (id) => (userInfo.get(String(id)) || {}).name || 'user #' + id;
    for (const [what, R] of [['posts', state.recvPosts && state.recvPosts.A], ['comments', state.recvComments && state.recvComments.A]]) {
      if (!R) continue;
      const vs = Object.entries(R.byVoter);
      if (R.up >= 20) {
        const top3 = vs.map(([, v]) => v.up).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
        if (top3 / R.up >= 0.5) add('Votes on their ' + what, 'up', null, `3 voters account for ${pct(top3, R.up)}% of the upvotes on their ${what} (${top3} of ${R.up}).`);
      }
      const td = [...vs].sort((a, b) => b[1].down - a[1].down)[0];
      if (td && td[1].down >= 10 && td[1].down / R.down >= ONE_PERSON_DOWN_SHARE) add('Votes on their ' + what, 'down', null, `${pct(td[1].down, R.down)}% of the downvotes on their ${what} (${td[1].down}) came from one voter (${nameOf(td[0])}).`);
      const fresh = vs.filter(([id, v]) => v.up >= 5 && isNew(id));
      if (fresh.length) add('Votes on their ' + what, 'up', null, `${fresh.length} frequent upvoter(s) on their ${what} have accounts under 30 days old: ${fresh.slice(0, 5).map(([id, v]) => `${nameOf(id)} (${v.up})`).join(', ')}.`);
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
    const { key, dir } = srcSort;
    const list = SS.rows.slice();
    if (key) {
      const val = { source: (g) => g.url.toLowerCase(), kind: (g) => kindLabel[g.kind], posts: (g) => g.ids.length }[key];
      list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir || b.ids.length - a.ids.length);
    }
    const rows = list.slice(0, SOURCE_ROWS_MAX).map((g) => {
      const link = /^https?:\/\//i.test(g.url)
        ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">${esc(g.url.length > 70 ? g.url.slice(0, 67) + '…' : g.url)}</a>`
        : esc(g.url.length > 70 ? g.url.slice(0, 67) + '…' : g.url);
      const view = `<a href="/posts?tags=${encodeURIComponent('id:' + g.ids.slice(0, 100).join(','))}" target="_blank">view${g.ids.length > 100 ? ' first 100' : ''}</a>`;
      return [link, kindLabel[g.kind], g.ids.length, view];
    });
    const th = (k, label) => `<th data-src-sort="${k}" title="Click to sort">${label}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const tbl = `<table><tr>${th('source', 'Source')}${th('kind', 'Looks like')}${th('posts', 'Posts')}<th>Find posts</th></tr>` +
      rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') + '</table>';
    return `<details class="ua-src"><summary>Sources worth checking (${SS.total})</summary>` +
      `<div class="hint">Anything that isn't a valid web link (listed first), sources shared by ${SAME_SOURCE_MIN}+ posts, any invite links (Discord or Telegram), and any that look like a profile or landing page instead of the original submission (judged from the link's shape; the script can't open the links, so check a few yourself). Deleted posts are left out. Click a column header to sort.${SS.total > SOURCE_ROWS_MAX ? ` Showing ${SOURCE_ROWS_MAX} of ${SS.total}.` : ''}</div>` +
      (rows.length ? tbl : '<div class="hint">Nothing stands out.</div>') + '</details>';
  }

  // Share of the user's original uploads that were replaced. Replaced posts that someone else submitted are credited to that person now,
  // so they are no longer in the user's upload list and are added back to get the number of posts they originally uploaded.
  function replShare(posts) {
    if (!state.uploadIds || !state.posts || !state.posts.stats.total) return '';
    const have = new Set(state.uploadIds.map(String));
    const original = state.posts.stats.total + posts.filter((id) => !have.has(String(id))).length;
    const p = posts.length / original * 100;
    return ` (${p < 10 ? p.toFixed(1) : Math.round(p)}% of ${original} posts)`;
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
      ...(state.replaced ? [['Uploads replaced', state.replaced.error ? esc(state.replaced.error)
        : drill(`${state.replaced.posts.length}${replShare(state.replaced.posts)}`, state.replaced.posts, postLink)]] : []),
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
    const A = state.votes.A, tot = A.up + A.down, lockedN = A.locked || 0;
    if (!tot && !lockedN) return section('Votes on posts', '<div class="hint">No votes in this timespan.</div>');
    const med = (arr) => (arr.length ? median(arr).toFixed(1) + ' h' : 'n/a');
    const quick = A.delaysDown.filter((h) => h <= 1).length;
    const downRows = uploaderRows(A, 'down'), upRows = uploaderRows(A, 'up');
    const empty = '<div class="hint">None in this timespan.</div>';
    const body = table(['Measure', 'Value'], [
      ['Votes analysed', `${tot} (${upN(A.up)} / ${downN(A.down)})`],
      ['Downvote share', pct(A.down, tot) + '%'],
      ['Locked votes', lockedN ? drill(esc(lockedN), A.lockedPosts || [], postLink) : 0],
      ['Most votes within one hour', maxInWindow(A.timesAll, 3600000)],
      ['Median time from upload to vote (down / up)', `${med(A.delaysDown)} / ${med(A.delaysUp)}`],
      ['Downvotes within 1 hour of upload', `${quick} (${pct(quick, A.delaysDown.length)}%)`],
    ]) + '<div class="hint">Click an Up or Down number to list the posts.</div>' +
      viewToggle('Votes on posts', 'Uploaders they downvote most', 'Uploaders they upvote most') +
      (viewOf('Votes on posts') === 'down'
        ? (downRows.length ? table(['Uploader', 'Up', 'Down', 'Net', 'Share of downvotes'], downRows) : empty)
        : (upRows.length ? table(['Uploader', 'Up', 'Down', 'Net', 'Share of upvotes'], upRows) : empty)) +
      (lockedN ? '<b>Uploaders with locked votes</b>' + table(['Uploader', 'Locked', 'Share of locked'],
        Object.entries(A.byUploader).filter(([, v]) => v.locked > 0).sort((a, b) => b[1].locked - a[1].locked).slice(0, 10)
          .map(([id, v]) => [userLink(id, A.names[id]), drill(esc(v.locked), v.lockedPosts, postLink), pct(v.locked, lockedN) + '%'])) : '');
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
      viewToggle(title, 'Who downvotes them most', 'Who upvotes them most') +
      (viewOf(title) === 'down'
        ? (dr.length ? table([...head, 'Share of downvotes'], dr) : empty)
        : (ur.length ? table([...head, 'Share of upvotes'], ur) : empty)));
  }

  function tagRows(V, kind) {
    const base = V[kind] / (V.up + V.down);
    const rows = Object.keys(kind === 'down' ? V.tagDown : V.tagUp).map((t) => ({ t, d: V.tagDown[t] || 0, u: V.tagUp[t] || 0 }))
      .filter((x) => x[kind === 'down' ? 'd' : 'u'] >= 3 && x.d + x.u >= 5 && x[kind === 'down' ? 'd' : 'u'] / (x.d + x.u) > base)
      .sort((a, b) => b[kind === 'down' ? 'd' : 'u'] / (b.d + b.u) - a[kind === 'down' ? 'd' : 'u'] / (a.d + a.u) || b[kind === 'down' ? 'd' : 'u'] - a[kind === 'down' ? 'd' : 'u']).slice(0, 15);
    return { base, rows };
  }

  function secTags() {
    const V = state.votes && state.votes.A;
    if (!V || !(V.up + V.down)) return '';
    const kind = viewOf('Tags they vote on'), word = kind === 'up' ? 'upvote' : 'downvote';
    const toggle = viewToggle('Tags they vote on', 'Downvoted tags', 'Upvoted tags');
    if (!V[kind]) return section('Tags they vote on', toggle + `<div class="hint">No ${word}s in this timespan.</div>`);
    const { base, rows } = tagRows(V, kind);
    const body = rows.map((x) => kind === 'down'
      ? [searchLink(x.t, x.t), downN(x.d), upN(x.u), pct(x.d, x.d + x.u) + '%']
      : [searchLink(x.t, x.t), upN(x.u), downN(x.d), pct(x.u, x.d + x.u) + '%']);
    return section('Tags they vote on', toggle + `<div class="hint">Tags that appear on their ${word}d posts more often than their overall ${word} share (${Math.round(base * 100)}%). Needs at least 5 votes and 3 ${word}s per tag.</div>` +
      table(kind === 'down' ? ['Tag', 'Down', 'Up', 'Downvote share'] : ['Tag', 'Up', 'Down', 'Upvote share'], body));
  }

  function secCommentVotes() {
    const C = state.cvotes;
    if (!C) return '';
    if (C.error) return section('Votes on comments', `<div>${esc(C.error)}</div>`);
    if (!C.up && !C.down && !C.locked) return section('Votes on comments', '<div class="hint">No comment votes in this timespan.</div>');
    const rowsFor = (key) => Object.values(C.byAuthor).filter((v) => v[key] > 0)
      .sort((a, b) => b[key] - a[key] || (b.up + b.down) - (a.up + a.down)).slice(0, 10)
      .map((v) => [v.id !== undefined ? userLink(v.id, v.name) : esc(v.name), drill(upN(v.up), v.upItems, commentLink),
        drill(downN(v.down), v.downItems, commentLink), num(v.up - v.down, sgnText(v.up - v.down))]);
    const dr = rowsFor('down'), ur = rowsFor('up'), empty = '<div class="hint">None in this timespan.</div>';
    return section('Votes on comments', table(['Measure', 'Value'], [
      ['Votes analysed', `${C.up + C.down} (${upN(C.up)} / ${downN(C.down)})`],
      ['Downvote share', pct(C.down, C.up + C.down) + '%'],
      ['Locked votes', C.locked || 0],
    ]) + '<div class="hint">Click an Up or Down number to list the comments.</div>' +
      viewToggle('Votes on comments', 'Commenters they downvote most', 'Commenters they upvote most') +
      (viewOf('Votes on comments') === 'down'
        ? (dr.length ? table(['Commenter', 'Up', 'Down', 'Net'], dr) : empty)
        : (ur.length ? table(['Commenter', 'Up', 'Down', 'Net'], ur) : empty)));
  }

  function render() {
    copyReg = [];
    const root = $('ua-report');
    const sample = $('ua-sample');
    root.style.minHeight = '';
    panel.appendChild(sample);   // park the comment sample outside the report while it is rebuilt
    if (!state.user) { root.innerHTML = ''; return; }
    const opens = [...root.querySelectorAll('details')].map((d) => d.open);   // keep what the user expanded
    const flags = buildFlags();
    root.innerHTML =
      toolsBar() + (flags.length ? `<div class="ua-flags"><label><input type="checkbox" data-pick="Worth a look" title="Include in Export selected"${picked.has('Worth a look') ? ' checked' : ''}> <b>Worth a look</b></label> <span class="hint">(prompts for review, not verdicts; click one to jump to it)</span><ul>${flags.map((x) => `<li><a href="#" data-goto="${esc(x.sec)}"${x.view ? ` data-view="${x.view}"` : ''}${x.sub ? ` data-sub="${x.sub}"` : ''}>${esc(x.t)}</a></li>`).join('')}</ul></div>` : '') +
      '<div class="ua-allbar"><button data-all="open">Expand all</button><button data-all="close">Collapse all</button></div>' +
      group('Account', secOverview() + (state.posts ? secPosts() : '') + (state.comments ? secComments() : '') + '<div id="ua-sample-slot"></div>') +
      group('Votes they cast', (state.votes ? secVotes() + secBlacklist() + secTags() : '') + secCommentVotes()) +
      group('Votes they received', secReceived('Votes on their posts', 'posts', state.recvPosts) + secReceived('Votes on their comments', 'comments', state.recvComments));
    const ds = root.querySelectorAll('details');
    if (ds.length === opens.length) ds.forEach((d, i) => { d.open = opens[i]; });
    const slot = $('ua-sample-slot');
    if (slot) slot.replaceWith(sample);   // the sample sits right under Comments
    updatePickCount();
  }

  // ---------- comment sample ----------
  function renderComments() {
    const box = $('ua-comments');
    $('ua-sample').style.display = comments.length ? '' : 'none';   // only show the sample once comments are loaded
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
  ['ua-c-sort', 'ua-c-max', 'ua-c-text', 'ua-c-n'].forEach((id) => $(id).addEventListener('input', () => { holdHeight(); renderComments(); }));   // a shorter list must not make the view jump

  // ---------- audit ----------
  async function runAudit(quick = false) {
    const want = (id) => (quick ? id === 'ua-do-posts' || id === 'ua-do-comments' : $(id).checked);   // quick audit: uploads and comments only
    Object.keys(secOpen).forEach((k) => delete secOpen[k]);   // every new audit starts with all sections collapsed
    panel.appendChild($('ua-sample'));   // the comment sample sits inside the report, so move it out before the report is cleared
    $('ua-report').innerHTML = '';
    stopFlag = false;
    auditRunning = true;
    DELAY = DELAY_FAST;
    slots = {};
    pauseUntil = 0;
    runStats = { start: Date.now(), requests: 0, retries: 0, rateLimited: 0, slowedAfter: null };
    progressReset();
    $('ua-log').textContent = '';
    $('ua-stamp').style.display = 'none';
    comments = [];
    state = {};
    state.opts = { ts: Date.now(), quick };
    userInfo = new Map();
    lookupFailed.clear();
    renderComments();
    const from = $('ua-from').value ? new Date($('ua-from').value + 'T00:00:00').getTime() : null;
    const to = $('ua-to').value ? new Date($('ua-to').value + 'T23:59:59.999').getTime() : null;
    const maxC = Math.max(10, parseInt($('ua-max-comments').value, 10) || 1000);
    const maxV = Math.max(10, parseInt($('ua-max-votes').value, 10) || 2000);
    Object.assign(state.opts, { from, to, maxC, maxV });

    try {
      setStatus('Looking up user…');
      const user = await getJSON(`/users/${profileId}.json`);
      if (!user || !user.id) return log('Could not load this user.');
      $('ua-name').textContent = '— ' + user.name;
      pageName = user.name;
      state.user = user;

      let blText = typeof user.blacklisted_tags === 'string' ? user.blacklisted_tags : '', blSource = 'profile', blError = null;
      if (!blText.trim() && want('ua-do-votes')) {
        try {
          setStatus('Loading blacklist from staff page…');
          blText = await fetchStaffBlacklist(user.id);
          blSource = 'staff';
        } catch (e) { blError = e.message; log('Staff blacklist page failed: ' + e.message); }
      }
      state.blacklist = { source: blSource, error: blError, entries: parseBlacklist(blText) };
      render();

      const names = [];
      if (want('ua-do-posts')) { names.push('posts'); if (!quick) names.push('replaced'); }
      if (want('ua-do-comments')) names.push('comments');
      if (want('ua-do-received')) names.push('recvPosts', 'recvComments', 'voters');
      if (want('ua-do-votes')) names.push('votes', 'votedPosts', 'cvotes', 'votedComments');
      progressStart(names);

      // Lane A: uploads -> comments -> votes they received (which reuses the lists just loaded).
      // Lane B: votes they cast on posts -> on comments. The lanes are independent, so they can overlap.
      const laneA = async () => {
      if (want('ua-do-posts') && !stopFlag) {
        try {
          const list = [];
          const knownUploads = Number(user.post_upload_count) || 0;
          for await (const p of paged(`/posts.json?tags=${encodeURIComponent(`user:${user.name} status:any`)}&limit=320`, null, null, false, 'A')) {
            list.push(p);
            progressSet('posts', (knownUploads ? list.length / knownUploads : soft(list.length, 1500)) * 0.98);
            if (list.length % 100 === 0) setStatus(`Loading uploads: ${list.length}`);
            if (list.length >= 10000) { log('Stopped at 10000 uploads.'); break; }
          }
          progressSet('posts', 1);
          state.posts = { stats: postStats(list, Date.now()) };
          state.uploadIds = list.map((p) => p.id);
          render();
        } catch (e) { log('Uploads failed: ' + e.message); }
      }

      if (want('ua-do-posts') && !quick && state.uploadIds && !stopFlag) await auditReplaced(user, 'A');

      if (want('ua-do-comments') && !stopFlag) {
        try {
          const knownC = (from || to) ? 0 : Math.min(maxC, Number(user.comment_count) || 0);
          for await (const c of paged(`/comments.json?group_by=comment&search[creator_id]=${user.id}&limit=320`, from, to, true, 'A')) {
            comments.push(c);
            progressSet('comments', (knownC ? comments.length / knownC : soft(comments.length, 400)) * 0.98);
            if (comments.length % 100 === 0) setStatus(`Loading comments: ${comments.length}`);
            if (comments.length >= maxC) break;
          }
          progressSet('comments', 1);
          state.comments = { stats: commentStats(comments) };
          renderComments();
          render();
        } catch (e) { log('Comments failed: ' + e.message); }
      }

        if (want('ua-do-received') && !stopFlag) await auditReceived(user, from, to, maxV, 'A');
      };
      const laneB = async () => {
        if (want('ua-do-votes') && !stopFlag) await auditVotes(user, from, to, maxV, 'B');
      };
      const safe = (f, lane) => f().catch((e) => log('Error: ' + e.message)).finally(() => progressLaneDone(lane));
      if (PARALLEL) await Promise.all([safe(laneA, 'A'), safe(laneB, 'B')]);
      else { await safe(laneA, 'A'); await safe(laneB, 'B'); }
    } catch (e) {
      log('Error: ' + e.message);
    } finally {
      auditRunning = false;
      setStatus(stopFlag ? 'Stopped.' : 'Done.');
      render();
      logRunSummary();
      if (!state.user) $('ua-bar').style.display = 'none';
      else if (stopFlag) progressRender(' (stopped)');
      else { progress.shown = 1; progressRender(); }
      if (!stopFlag && state.user) {
        if (quick) {
          const box = $('ua-stamp');
          box.textContent = `Quick audit ${fmtDT(Date.now())} (uploads and comments only; not saved, your last full audit is kept).`;
          box.style.display = '';
        } else {
          const ts = saveCache({ from, to, maxC, maxV });
          showStamp(ts, false);
        }
      }
    }
  }

  // Uploads of this user that were replaced. When a replacement is approved the post is credited to whoever submitted it, so the user's current
  // uploads can't be used for this. Instead each replaced post has an "original" record whose creator is the original uploader; a post counts
  // for this user when that record is theirs and the post has at least one approved replacement. The whole list is read newest-first.
  async function auditReplaced(user, lane) {
    const REPLACED_SCAN_CAP = 12000;   // most replacement records (site-wide) looked through
    const origCreator = new Map();     // post id -> creator of its "original" record
    const approved = new Map();        // post id -> number of approved replacements
    let scanned = 0, topId = 0, capped = false;
    try {
      for await (const r of paged('/post_replacements.json?limit=320', null, null, true, lane)) {
        scanned++;
        if (!topId) topId = Number(r.id) || 0;
        if (r.status === 'original' || (r.status === undefined && Number(r.sequence_number) === 0)) origCreator.set(String(r.post_id), Number(r.creator_id));
        else if (r.status === 'approved') approved.set(String(r.post_id), (approved.get(String(r.post_id)) || 0) + 1);
        if (scanned % 100 === 0) {
          setStatus(`Checking replacements: ${scanned} looked through`);
          progressSet('replaced', topId ? (topId - Number(r.id)) / topId * 0.98 : soft(scanned, 3000) * 0.98);
        }
        if (scanned >= REPLACED_SCAN_CAP) { capped = true; log(`Stopped looking through replacements after ${REPLACED_SCAN_CAP}.`); break; }
      }
      const posts = [...origCreator].filter(([id, creator]) => creator === Number(user.id) && approved.has(id)).map(([id]) => Number(id));
      state.replaced = { posts, total: posts.reduce((n, id) => n + approved.get(String(id)), 0), scanned, capped };
    } catch (e) {
      state.replaced = { error: [401, 403, 404].includes(e.status) ? `Your role can't view replacements (${e.message}).` : e.message };
      log('Replacements failed: ' + e.message);
    }
    progressSet('replaced', 1);
    render();
  }

  async function auditVotes(user, from, to, maxV, lane) {
    const votes = [];
    let newest = null;
    try {
      setStatus('Loading post votes…');
      for await (const v of paged(`/post_votes.json?search[user_id]=${user.id}&limit=320`, from, to, false, lane)) {
        if (v.user_id !== undefined && Number(v.user_id) !== Number(user.id)) throw new Error('The votes list did not filter by user, so it was not used.');
        votes.push(v);
        if (newest === null) newest = Date.parse(v.created_at);
        const byTime = from ? (newest - Date.parse(v.created_at)) / Math.max(1, newest - from) : soft(votes.length, 800);
        progressSet('votes', Math.max(byTime || 0, votes.length / maxV) * 0.98);
        if (votes.length >= maxV) break;
      }
    } catch (e) {
      state.votes = { error: e.status === 403 || e.status === 401 || e.status === 404
        ? `Your role can't view post votes (${e.message}).` : 'Post votes failed: ' + e.message };
      render();
      return;
    }
    progressSet('votes', 1);
    const ids = [...new Set(votes.map((v) => v.post_id))];
    const postMap = await fetchByIds(ids,
      (chunk) => `/posts.json?tags=${encodeURIComponent(`id:${chunk.join(',')} status:any`)}&limit=100`,
      (p) => p.id, 'voted posts', lane, 'votedPosts');
    state.votes = { A: analyzeVotes(votes, postMap, state.blacklist.entries) };
    state.votes.A.loaded = votes.length;   // shown in the saved-audit coverage line
    if (state.votes.A.missing) log(`${state.votes.A.missing} votes on posts could not be matched to their post, so they are left out of the uploader, timing and blacklist figures.`);
    render();

    if (stopFlag) return;
    const cv = [];
    let newestC = null;
    try {
      setStatus('Loading comment votes…');
      for await (const v of paged(`/comment_votes.json?search[user_id]=${user.id}&limit=320`, from, to, false, lane)) {
        if (v.user_id !== undefined && Number(v.user_id) !== Number(user.id)) throw new Error('filter not honoured');
        cv.push(v);
        if (newestC === null) newestC = Date.parse(v.created_at);
        const byTimeC = from ? (newestC - Date.parse(v.created_at)) / Math.max(1, newestC - from) : soft(cv.length, 800);
        progressSet('cvotes', Math.max(byTimeC || 0, cv.length / maxV) * 0.98);
        if (cv.length >= maxV) break;
      }
      progressSet('cvotes', 1);
      const cids = [...new Set(cv.map((v) => v.comment_id))];
      const cmap = await fetchByIds(cids,
        (chunk) => `/comments.json?group_by=comment&search[id]=${chunk.join(',')}&limit=100`,
        (c) => c.id, 'voted comments', lane, 'votedComments');
      const C = { up: 0, down: 0, locked: 0, missing: 0, loaded: cv.length, byAuthor: {} };
      for (const v of cv) {
        const dir = v.score > 0 ? 'up' : v.score < 0 ? 'down' : null;
        if (isLockedVote(v)) C.locked++;
        if (!dir) continue;
        C[dir]++;
        const c = cmap.get(v.comment_id);
        if (!c) { C.missing++; continue; }
        const key = c.creator_id ?? c.creator_name ?? '?';
        const a = (C.byAuthor[key] = C.byAuthor[key] || { id: c.creator_id, name: c.creator_name, up: 0, down: 0, upItems: [], downItems: [] });
        a[dir]++;
        a[dir + 'Items'].push({ id: c.id, post_id: c.post_id });
      }
      if (C.missing) log(`${C.missing} votes on comments could not be matched to their comment, so they are left out of the commenter table.`);
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
  async function auditReceived(user, from, to, maxV, lane) {
    const SCAN_CAP = RECEIVED_SCAN_CAP, BATCH = 100;
    const fail = (e, what) => ({ error: [401, 403, 404].includes(e.status)
      ? `Your role can't view votes on their ${what} (${e.message}).` : `Votes on their ${what} failed: ${e.message}` });

    async function* uploadIds() {
      if (state.uploadIds) { for (const id of state.uploadIds) yield id; return; }
      for await (const p of paged(`/posts.json?tags=${encodeURIComponent(`user:${user.name} status:any`)}&limit=320`, null, null, false, lane)) yield p.id;
    }
    async function* commentIds() {
      if (comments.length && !from && !to) { for (const c of comments) yield c.id; return; }
      for await (const c of paged(`/comments.json?group_by=comment&search[creator_id]=${user.id}&limit=320`, null, null, true, lane)) yield c.id;
    }

    async function scan(what, endpoint, param, idKey, source, task) {
      const votes = [];
      const known = what === 'posts' ? (state.uploadIds ? state.uploadIds.length : Number(user.post_upload_count) || 0)
        : ((comments.length && !from && !to) ? comments.length : Number(user.comment_count) || 0);
      const total = Math.max(1, known ? Math.min(known, SCAN_CAP) : SCAN_CAP);
      let scanned = 0, batch = [], full = false;
      const flush = async () => {
        if (!batch.length) return;
        const set = new Set(batch.map(String));
        const ids = batch.join(',');
        batch = [];
        setStatus(`Loading votes on their ${what}: ${scanned} checked, ${votes.length} votes`);
        for await (const v of paged(`/${endpoint}.json?search[${param}]=${ids}&limit=320`, from, to, false, lane)) {
          if (!set.has(String(v[idKey]))) throw new Error('the server returned votes for other items, so the list was not used');
          votes.push(v);
          if (votes.length >= maxV) { full = true; break; }
        }
      };
      for await (const id of source()) {
        if (stopFlag) break;
        batch.push(id); scanned++;
        progressSet(task, scanned / total * 0.98);
        if (batch.length >= BATCH) await flush();
        if (full || scanned >= SCAN_CAP) break;
      }
      if (!full && !stopFlag) await flush();
      progressSet(task, 1);
      const limited = full ? ' (stopped at the Max votes limit, so older ones may be missing)' : scanned >= SCAN_CAP ? ' (scan limit reached, older ones are not included)' : '';
      return { A: analyzeReceived(votes, idKey), loaded: votes.length, capHit: full, scanned, note: `Covers votes on their ${scanned} most recent ${what}${limited}.` };
    }

    try {
      state.recvPosts = await scan('posts', 'post_votes', 'post_id', 'post_id', uploadIds, 'recvPosts');
    } catch (e) { state.recvPosts = fail(e, 'posts'); }
    render();
    if (stopFlag) return;

    try {
      state.recvComments = await scan('comments', 'comment_votes', 'comment_id', 'comment_id', commentIds, 'recvComments');
    } catch (e) { state.recvComments = fail(e, 'comments'); }
    render();
    if (stopFlag) return;

    // names and account ages for exactly the voters shown in the tables
    const P = state.recvPosts && state.recvPosts.A, C = state.recvComments && state.recvComments.A;
    const ids = [...new Set([P && 'up', P && 'down'].filter(Boolean).flatMap((k) => topVoters(P, k).map((x) => x[0]))
      .concat([C && 'up', C && 'down'].filter(Boolean).flatMap((k) => topVoters(C, k).map((x) => x[0]))))]
      .filter((id) => !userInfo.has(String(id)));
    await lookupUsers(ids, lane);
    render();
  }


  // ---------- export and copy ----------
  const DT_MAX = 50;   // most IDs written out one by one in a DText list
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function fmtDT(ts) { const d = new Date(ts), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; }
  function dtIds(kind, items) {
    const ids = items.map(idOf);
    let out = ids.slice(0, DT_MAX).map((i) => `${kind} #${i}`).join(', ');
    if (ids.length > DT_MAX) out += ` (+${ids.length - DT_MAX} more)`;
    if (kind === 'post' && ids.length > 1) out += ` — "view${ids.length > 100 ? ' first 100' : ' all'}":/posts?tags=id:${ids.slice(0, 100).join(',')}`;
    return out;
  }
  const cleanFlag = (t) => t.replace(/ Details under Uploads → Sources worth checking\./, '');
  function summaryLines() {
    const u = state.user, L = [];
    const P = state.posts && state.posts.stats, C = state.comments && state.comments.stats, V = state.votes && state.votes.A;
    const CV = state.cvotes && !state.cvotes.error ? state.cvotes : null;
    L.push(`Joined ${day(Date.parse(u.created_at))}${u.level_string ? ', ' + u.level_string : ''}`);
    if (P) {
      let x = `${P.total} uploads (${P.deleted} deleted, ${pct(P.deleted, P.total)}%; ${P.noSource} without a source)`;
      if (state.replaced && state.replaced.posts) x += `; ${state.replaced.posts.length} replaced`;
      L.push(x);
      const SS = P.sources, bits = [];
      if (SS) {
        if (SS.invalidPosts) bits.push(`${SS.invalidPosts} with a source that isn't a valid link`);
        if (SS.landingPosts) bits.push(`${SS.landingPosts} with a profile or landing page as source`);
        if (SS.chatPosts) bits.push(`${SS.chatPosts} with an invite link as source`);
      }
      if (bits.length) L.push('Sources: ' + bits.join(', '));
    }
    if (C && C.total) L.push(`${C.total} comments loaded: ${pct(C.negative, C.total)}% with a negative score, ${C.hidden} hidden`);
    if (V && V.up + V.down) {
      let x = `Post votes: ${V.up + V.down} analysed, ${pct(V.down, V.up + V.down)}% downvotes`;
      if (state.blacklist && !state.blacklist.error && state.blacklist.entries.length && V.down) x += `; ${V.blDown.length} of ${V.down} downvotes were on posts their blacklist hides`;
      L.push(x);
    }
    if (CV && CV.up + CV.down) L.push(`Comment votes: ${CV.up + CV.down} analysed, ${pct(CV.down, CV.up + CV.down)}% downvotes`);
    return L;
  }
  function buildSummary() {
    const u = state.user, o = state.opts || {}, L = [];
    const span = o.quick ? 'quick audit (uploads and comments only)' : `comments and votes from ${o.from ? day(o.from) : 'the start'} to ${o.to ? day(o.to) : 'now'}`;
    L.push(`[b]User audit: "${u.name}":/users/${u.id}[/b]`, `Audited ${fmtDT(o.ts || Date.now())}; ${span}.`, '', '[b]Account[/b]');
    summaryLines().forEach((x) => L.push('* ' + x));
    L.push('');
    const flags = buildFlags();
    if (flags.length) { L.push('[b]Worth a look[/b]'); flags.forEach((f) => L.push('* ' + cleanFlag(f.t))); L.push(''); }
    return L.join('\n').trim();
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    return Promise.resolve(fallbackCopy(text));
  }
  async function flash(el, pr, busy) {   // brief feedback on the button or link that was clicked
    const orig = el.innerHTML;
    if (busy) el.textContent = busy;
    const r = await pr;
    el.textContent = r === 'none' ? 'Nothing selected' : (typeof r === 'string' && r) ? r : r ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { if (el.isConnected) el.innerHTML = orig; }, busy ? 2200 : 1400);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileName = (prefix, ext) => `${prefix}_${String(state.user.name).replace(/[^\w.-]+/g, '_')}_${day(Date.now())}.${ext}`;
  function toolsBar() {
    return '<div class="ua-tools">' +
      '<button data-act="report" title="The whole report, as it is shown now, as an HTML file you can send to someone">Export full report</button>' +
      '<button data-act="custom" title="Only the sections whose box you ticked, as an HTML file you can send to someone">Export selected (<span data-pickcount>0</span>)</button>' +
      '<button data-act="png" title="The whole report as one picture, copied to the clipboard so you can paste it straight into Discord">Copy PNG</button>' +
      '<button data-act="pngsel" title="Only the sections whose box you ticked, as one picture copied to the clipboard">Copy PNG selected (<span data-pickcount>0</span>)</button>' +
      '<div class="hint">Tick the box next to a section title to include it in “Export selected” and "Copy PNG selected".</div></div>';
  }
  function updatePickCount() { $('ua-report').querySelectorAll('[data-pickcount]').forEach((x) => { x.textContent = $('ua-report').querySelectorAll('input[data-pick]:checked').length; }); }

  // ---------- shareable HTML files ----------
  const EXPORT_CSS = `
    :root { --bg: #000; --fg: #222; --section: #333; --light: #4d4d4d; --text: #fff; --muted: #cbb295; --link: #ffee95; --hover: #f68b00; --accent: #e8c446; --pos: #4ccf5f; --zero: #ffc800; --neg: #ff5a5a; color-scheme: dark; }
    body { background: var(--section); color: var(--text); font: 13px/1.45 system-ui, sans-serif; margin: 0 auto; padding: 16px; max-width: 960px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    a { color: var(--link); text-decoration: none; } a:hover { color: var(--hover); text-decoration: underline; }
    code { color: var(--text); } .hint { font-size: 11px; color: var(--muted); }
    table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
    th, td { border-bottom: 1px solid var(--fg); padding: 2px 6px; text-align: left; font-size: 12px; vertical-align: top; }
    th { color: #e6e6e6; background: var(--fg); }
    details { margin-top: 8px; } summary { cursor: pointer; font-weight: bold; }
    h2 { font-size: 13px; margin: 16px 0 2px; color: var(--accent); }
    .ua-grp { margin: 18px 0 2px; padding-bottom: 3px; font-size: 11px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border-bottom: 1px solid var(--light); }
    .ua-flags { background: var(--fg); border: 1px solid var(--accent); border-radius: 6px; padding: 6px 10px; margin-top: 10px; }
    ul.ua-ul, .ua-flags ul { list-style: disc outside; margin: 4px 0 6px; padding: 0 0 0 20px; } .ua-flags li, ul.ua-ul li { display: list-item; margin: 3px 0; }
    details.ua-src { margin: 12px 0; border: 1px solid var(--accent); border-radius: 5px; background: var(--fg); }
    details.ua-src > summary { padding: 5px 8px; color: var(--accent); } details.ua-src > :not(summary) { margin-left: 8px; margin-right: 8px; }
    details.ua-src > table { width: calc(100% - 16px); margin-bottom: 8px; }
    details.ua-x { display: inline-block; margin: 0; } details.ua-x > summary { font-weight: normal; }
    .ua-links { max-width: 330px; max-height: 140px; overflow: auto; line-height: 1.5; }
    .ua-pos { color: var(--pos); font-weight: bold; } .ua-zero { color: var(--zero); font-weight: bold; } .ua-neg { color: var(--neg); font-weight: bold; }
    .ua-c { border-bottom: 1px solid var(--fg); padding: 5px 0; } .ua-c .meta { font-size: 11px; color: var(--muted); }
    .ua-vb { display: inline-block; cursor: pointer; margin: 4px 6px 4px 0; padding: 4px 10px; background: var(--fg); color: var(--link); border: 1px solid var(--light); border-radius: 4px; user-select: none; }
    .ua-vb:hover { color: var(--hover); } .ua-vb.on { border-color: var(--accent); color: var(--accent); }
    .ua-vlabel { margin: 10px 0 2px; font-weight: bold; color: var(--accent); }
    .ua-allbar { margin: 10px 0 0; text-align: right; }
    a.ua-cp { font-size: 11px; color: var(--muted); margin-left: 4px; white-space: nowrap; }
    th[data-bl-sort], th[data-src-sort] { cursor: pointer; }
  `;
  function exportDoc(title, body, note) {
    const u = state.user, o = state.opts || {};
    const span = o.quick ? 'quick audit (uploads and comments only)' : `comments and votes from ${o.from ? day(o.from) : 'the start'} to ${o.to ? day(o.to) : 'now'}`;
    return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}: ${esc(u.name)}</title><style>${EXPORT_CSS}</style></head><body>` +
      `<h1>${esc(title)}: <a href="${location.origin}/users/${u.id}" target="_blank">${esc(u.name)}</a></h1>` +
      `<div class="hint">Audited ${esc(fmtDT(o.ts || Date.now()))}; ${esc(span)}. Exported ${esc(fmtDT(Date.now()))} by e6AI User Audit 1.42. Warnings are prompts for review, not verdicts.${note ? ' ' + esc(note) : ''}</div>` +
      body + '</body></html>';
  }
  // The report exactly as it is shown now (including which of the up/down lists is showing), cleaned of buttons and made readable on its own.
  // `only`: a Set of section titles to keep (everything when omitted)
  // The five sections with a Down/Up switch: in the panel only one list shows, the export carries both.
  const VIEW_KEYS = ['Votes on posts', 'Votes on comments', 'Votes on their posts', 'Votes on their comments', 'Tags they vote on'];
  function bothViews() {
    const saved = {};
    VIEW_KEYS.forEach((k) => { saved[k] = views[k]; });
    const out = {};
    try {
      for (const v of ['down', 'up']) {
        VIEW_KEYS.forEach((k) => { views[k] = v; });
        render();
        $('ua-report').querySelectorAll('a.ua-cp').forEach((a) => {   // the list behind each "copy IDs" link, so the exported file can copy it too
          const g = copyReg[Number(a.dataset.copy)];
          if (g) { a.dataset.kind = g.kind; a.dataset.ids = g.items.map(idOf).join(','); }
        });
        out[v] = $('ua-report').cloneNode(true);
      }
    } finally {
      VIEW_KEYS.forEach((k) => { if (saved[k] === undefined) delete views[k]; else views[k] = saved[k]; });
      render();
    }
    out.cur = (k) => (saved[k] === 'up' ? 'up' : 'down');
    return out;
  }
  // mode 'html': a Down/Up switch you can click; 'static': both lists one after the other (for the picture)
  function mergeViews(down, up, cur, mode) {
    down.querySelectorAll('details[data-sec]').forEach((d) => {
      const tgBtn = d.querySelector('button[data-view-key]');
      if (!tgBtn) return;
      const tg = tgBtn.parentElement, key = tgBtn.dataset.viewKey;
      const u = [...up.querySelectorAll('details[data-sec]')].find((x) => x.dataset.sec === d.dataset.sec);
      const ut = u && u.querySelector('button[data-view-key]');
      if (!ut) return;
      const labels = { down: tg.querySelector('button[data-view="down"]').textContent, up: tg.querySelector('button[data-view="up"]').textContent };
      const after = (el) => { const a = []; for (let n = el.nextSibling; n; n = n.nextSibling) a.push(n); return a; };
      const parts = { down: after(tg), up: after(ut.parentElement) };
      const wrap = document.createElement('div');
      wrap.className = 'ua-vw';
      if (mode === 'html') {
        const row = document.createElement('div');
        ['down', 'up'].forEach((v) => {
          const b = document.createElement('span');
          b.className = 'ua-vb' + (v === cur(key) ? ' on' : '');
          b.setAttribute('role', 'button'); b.setAttribute('tabindex', '0'); b.dataset.v = v; b.textContent = labels[v];
          row.appendChild(b);
        });
        wrap.appendChild(row);
      }
      ['down', 'up'].forEach((v) => {
        const box = document.createElement('div');
        box.className = 'ua-view'; box.dataset.v = v;
        if (mode === 'html' && v !== cur(key)) box.style.display = 'none';
        if (mode !== 'html') { const l = document.createElement('div'); l.className = 'ua-vlabel'; l.textContent = labels[v]; box.appendChild(l); }
        parts[v].forEach((n) => box.appendChild(n));
        wrap.appendChild(box);
      });
      tg.replaceWith(wrap);   // everything that came after the old switch now sits inside the two boxes
    });
  }
  // Runs inside the exported HTML file (written out with toString, so it must not use anything from this script).
  const EXPORT_SCRIPT = '<script>(' + (function () {
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
    function setView(w, v) {
      $$('.ua-vb[data-v]', w).forEach(function (x) { x.classList.toggle('on', x.dataset.v === v); });
      $$('.ua-view', w).forEach(function (x) { x.style.display = x.dataset.v === v ? '' : 'none'; });
    }
    function copy(text, el) {
      var orig = el.innerHTML;
      var done = function (ok) { el.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(function () { el.innerHTML = orig; }, 1400); };
      var fallback = function () {
        var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
        ta.remove(); done(ok);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
    }
    function dtIds(kind, ids) {
      var out = ids.slice(0, 50).map(function (i) { return kind + ' #' + i; }).join(', ');
      if (ids.length > 50) out += ' (+' + (ids.length - 50) + ' more)';
      if (kind === 'post' && ids.length > 1) out += ' \u2014 "view' + (ids.length > 100 ? ' first 100' : ' all') + '":/posts?tags=id:' + ids.slice(0, 100).join(',');
      return out;
    }
    function sortTable(th) {
      var key = th.dataset.blSort || th.dataset.srcSort, table = th.closest('table'), head = th.parentNode;
      var cells = Array.prototype.slice.call(head.children), idx = cells.indexOf(th);
      var cur = cells.filter(function (c) { return /[\u25B2\u25BC]$/.test(c.textContent); })[0];
      var textKey = key === 'entry' || key === 'source' || key === 'kind';
      var dir = cur === th ? (/\u25B2$/.test(th.textContent) ? -1 : 1) : (textKey ? 1 : -1);
      cells.forEach(function (c) { c.textContent = c.textContent.replace(/ [\u25B2\u25BC]$/, ''); });
      th.textContent += dir > 0 ? ' \u25B2' : ' \u25BC';
      var rows = $$('tr', table).filter(function (r) { return !r.querySelector('th'); });
      rows.forEach(function (r, n) { if (r._i === undefined) r._i = n; });
      var val = function (r) {
        var t = (r.children[idx] ? r.children[idx].textContent : '').trim();
        return textKey ? t.toLowerCase() : (parseFloat(t.replace(/[^0-9.+-]/g, '')) || 0);
      };
      rows.sort(function (a, b) { var x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a._i - b._i; });
      rows.forEach(function (r) { r.parentNode.appendChild(r); });
    }
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;
      var vb = t.closest('.ua-vb');
      if (vb && vb.dataset.v) { setView(vb.closest('.ua-vw'), vb.dataset.v); return; }
      if (vb && vb.dataset.all) { $$('details:not(.ua-x)').forEach(function (d) { d.open = vb.dataset.all === 'open'; }); return; }
      var cp = t.closest('a.ua-cp');
      if (cp) {
        e.preventDefault();
        var ids = (cp.dataset.ids || '').split(',').filter(Boolean);
        copy(e.shiftKey ? ids.join(',') : dtIds(cp.dataset.kind, ids), cp);
        return;
      }
      var g = t.closest('a[data-goto]');
      if (g) {
        e.preventDefault();
        var d = $$('details[data-sec]').filter(function (x) { return x.dataset.sec === g.dataset.goto; })[0];
        if (!d) return;
        d.open = true;
        if (g.dataset.view) { var w = d.querySelector('.ua-vw'); if (w) setView(w, g.dataset.view); }
        var target = d;
        if (g.dataset.sub === 'src') { var x = d.querySelector('details.ua-src'); if (x) { x.open = true; target = x; } }
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      var th = t.closest('th[data-bl-sort], th[data-src-sort]');
      if (th) sortTable(th);
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ua-vb')) { e.preventDefault(); e.target.click(); }
    });
  }).toString() + ')();<\/script>';
  function reportFile(only, mode = 'html') {
    const both = bothViews();
    const root = both.down;
    mergeViews(root, both.up, both.cur, mode);
    root.removeAttribute('id');
    root.style.minHeight = '';
    root.querySelectorAll(mode === 'html' ? '.ua-tools, tr.ua-xrow' : '.ua-tools, .ua-allbar, tr.ua-xrow, a.ua-cp').forEach((n) => n.remove());
    let note = '';
    if (only) {
      const names = [];
      if (!only.has('Worth a look')) { const f = root.querySelector('.ua-flags'); if (f) f.remove(); } else if (root.querySelector('.ua-flags')) names.push('Worth a look');
      [...root.children].forEach((el) => {
        if (el.matches('details[data-sec]')) { if (only.has(el.dataset.sec)) names.push(el.dataset.sec); else el.remove(); }
      });
      root.querySelectorAll('.ua-grp').forEach((g) => {   // drop a group heading when none of its sections are left
        let n = g.nextElementSibling, any = false;
        while (n && !n.classList.contains('ua-grp')) { if (n.matches('details[data-sec]')) any = true; n = n.nextElementSibling; }
        if (!any) g.remove();
      });
      note = 'Selected sections: ' + names.join(', ') + '.';
    }
    root.querySelectorAll('input[data-pick]').forEach((n) => n.remove());
    const sm = root.querySelector('#ua-sample');
    if (sm) { if (sm.style.display === 'none' || !sm.querySelector('.ua-c')) sm.remove(); else { sm.removeAttribute('id'); sm.querySelectorAll('.row').forEach((n) => n.remove()); } }
    root.querySelectorAll('button[data-view-key]').forEach((b) => {
      if (b.classList.contains('ua-on')) { const x = document.createElement('b'); x.textContent = 'Showing: ' + b.textContent; b.replaceWith(x); } else b.remove();
    });
    root.querySelectorAll('.ua-allbar button[data-all]').forEach((b) => {   // the Expand all / Collapse all buttons stay usable in the file
      const x = document.createElement('span');
      x.className = 'ua-vb'; x.setAttribute('role', 'button'); x.setAttribute('tabindex', '0'); x.dataset.all = b.dataset.all; x.textContent = b.textContent;
      b.replaceWith(x);
    });
    root.querySelectorAll('button').forEach((b) => b.remove());
    root.querySelectorAll('a[data-goto]').forEach((a) => {   // the "worth a look" links keep working when the section they point at is in the file
      const sec = a.dataset.goto.replace(/"/g, '\\"');
      if (mode === 'html' && root.querySelector(`details[data-sec="${sec}"]`)) a.setAttribute('href', '#'); else a.replaceWith(...a.childNodes);
    });
    root.querySelectorAll('a[href^="/"]').forEach((a) => a.setAttribute('href', location.origin + a.getAttribute('href')));
    root.querySelectorAll('[title]').forEach((n) => { if (!(mode === 'html' && n.matches('a.ua-cp, th[data-bl-sort], th[data-src-sort], a[data-goto]'))) n.removeAttribute('title'); });
    root.querySelectorAll('details[data-sec], details.ua-src, details:not(.ua-x)').forEach((d) => { if (mode === 'html') d.removeAttribute('open'); else d.setAttribute('open', ''); });   // the HTML file starts collapsed; the picture needs everything open
    root.querySelectorAll('details.ua-x').forEach((d) => d.removeAttribute('open'));
    const html0 = root.innerHTML;
    const html = (mode === 'html' ? html0 : html0.replace(/ Click a column header to sort\./g, '').replace('; click one to jump to it)', ')')) + (mode === 'html' ? EXPORT_SCRIPT : '');
    return exportDoc('User audit', html, note);
  }
  // The report (or the ticked sections) as a PNG: the export page is laid out in a hidden frame, then drawn through an SVG picture onto a canvas.
  async function reportPngBlob(only) {
    const W = 1000, MAX_H = 16000;
    const frame = document.createElement('iframe');
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;height:200px;border:0;visibility:hidden`;
    frame.srcdoc = reportFile(only, 'static');
    const loaded = new Promise((res) => { frame.onload = res; });
    document.body.appendChild(frame);
    try {
      await loaded;
      const doc = frame.contentDocument;
      const H = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
      const scale = Math.min(2, MAX_H / H);
      if (scale < 0.7) throw new Error('the report is too tall for one picture, tick fewer sections and use the selected button');
      const xs = new XMLSerializer();
      const xhtml = `<div xmlns="http://www.w3.org/1999/xhtml">${xs.serializeToString(doc.querySelector('style'))}${xs.serializeToString(doc.body)}</div>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`;
      const img = new Image();
      const ready = new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the browser could not draw the report as a picture')); });
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await ready;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('the picture could not be made'))), 'image/png'));
    } finally { frame.remove(); }
  }
  async function copyPng(only, name) {
    try {
      const pending = reportPngBlob(only);
      pending.catch(() => {});
      if (navigator.clipboard && window.ClipboardItem) {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]); return 'Copied ✓'; } catch (e) { log('Could not copy the picture to the clipboard (' + e.message + '), saving it as a file instead.'); }
      }
      download(name, await pending, 'image/png');
      return 'Saved as file';
    } catch (e) { log('PNG failed: ' + e.message); return 'PNG failed (see log)'; }
  }
  function doAct(act, btn) {
    if (act === 'summary') return flash(btn, copyText(buildSummary()));
    if (act === 'report') download(fileName('audit', 'html'), reportFile(), 'text/html');
    if (act === 'png') return flash(btn, copyPng(undefined, fileName('audit', 'png')), 'Rendering…');
    if (act === 'pngsel') {
      const only = new Set([...$('ua-report').querySelectorAll('input[data-pick]:checked')].map((c) => c.dataset.pick));
      if (!only.size) return flash(btn, 'none');
      return flash(btn, copyPng(only, fileName('audit_selected', 'png')), 'Rendering…');
    }
    if (act === 'custom') {
      const only = new Set([...$('ua-report').querySelectorAll('input[data-pick]:checked')].map((c) => c.dataset.pick));
      if (!only.size) return flash(btn, 'none');
      download(fileName('audit_selected', 'html'), reportFile(only), 'text/html');
    }
  }
  $('ua-report').addEventListener('change', (e) => {
    const cb = e.target.closest && e.target.closest('input[data-pick]');
    if (!cb) return;
    if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
    updatePickCount();
  });

  const lookupFailed = new Set();   // voter ids whose profile could not be loaded

  // Tries one batched request first, then falls back to one request per user for anything still missing.
  async function lookupUsers(ids, lane) {
    const missing = new Set(ids.map(String));
    if (!missing.size) return;
    setStatus(`Looking up ${missing.size} voters…`);
    try {
      for (let i = 0; i < ids.length && !stopFlag; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const list = asList(await getJSON(`/users.json?search[id]=${chunk.join(',')}&limit=100`, lane));
        for (const u of list) if (missing.has(String(u.id))) { userInfo.set(String(u.id), u); missing.delete(String(u.id)); }
        progressSet('voters', Math.min(i + 100, ids.length) / ids.length * 0.5);
      }
    } catch { /* fall back to one request per user below */ }
    let n = 0;
    const todo = missing.size;
    for (const id of missing) {
      if (stopFlag) break;
      setStatus(`Looking up voters: ${++n}/${missing.size}`);
      progressSet('voters', 0.5 + 0.5 * n / todo * 0.98);
      try { userInfo.set(id, await getJSON(`/users/${id}.json`, lane)); lookupFailed.delete(id); }
      catch (e) { lookupFailed.add(id); log(`Could not look up user #${id}: ${e.message}`); }
    }
    progressSet('voters', 1);
    render();
  }

  $('ua-report').addEventListener('click', (e) => {
    const cpl = e.target.closest && e.target.closest('a[data-copy]');
    if (cpl) {
      e.preventDefault();
      const g = copyReg[Number(cpl.dataset.copy)];
      if (g) flash(cpl, copyText(e.shiftKey ? g.items.map(idOf).join(',') : dtIds(g.kind, g.items)));
      return;
    }
    const act = e.target.closest && e.target.closest('button[data-act]');
    if (act) { doAct(act.dataset.act, act); return; }
    const gt = e.target.closest && e.target.closest('a[data-goto]');
    if (gt) {
      e.preventDefault();
      const sec = gt.dataset.goto;
      if (gt.dataset.view) views[sec] = gt.dataset.view;
      render();
      const d = $('ua-report').querySelector(`details[data-sec="${sec.replace(/"/g, '\\"')}"]`);
      if (d) {
        d.open = true;
        let target = d;
        if (gt.dataset.sub === 'src') { const x = d.querySelector('details.ua-src'); if (x) { x.open = true; target = x; } }
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      return;
    }
    const ab = e.target.closest && e.target.closest('button[data-all]');
    if (ab) {
      const open = ab.dataset.all === 'open';
      $('ua-report').querySelectorAll('details:not(.ua-x)').forEach((d) => { d.open = open; });
      if (!open) ab.closest('.ua-allbar').scrollIntoView({ block: 'nearest' });
      return;
    }
    const tb = e.target.closest && e.target.closest('button[data-view-key]');
    if (tb) { views[tb.dataset.viewKey] = tb.dataset.view; render(); return; }
    const hs = e.target.closest && e.target.closest('th[data-src-sort]');
    if (hs) {
      const k = hs.dataset.srcSort;
      srcSort = { key: k, dir: srcSort.key === k ? -srcSort.dir : (k === 'posts' ? -1 : 1) };
      render();
      return;
    }
    const h = e.target.closest && e.target.closest('th[data-bl-sort]');
    if (!h) return;
    const key = h.dataset.blSort;
    blSort = { key, dir: blSort.key === key ? -blSort.dir : (key === 'entry' ? 1 : -1) };
    render();
  });


  // ---------- saved audits (per user, kept in the userscript manager's storage) ----------
  const CACHE_MAX_USERS = 20;              // keep at most this many users
  const CACHE_MAX_AGE = 30 * 864e5;        // forget audits older than 30 days
  const cacheKey = (id) => 'ua_cache_' + id;
  const toJSON = (v) => JSON.stringify(v, (k, x) => x instanceof Map ? { __t: 'Map', v: [...x] } : x instanceof Set ? { __t: 'Set', v: [...x] } : x);
  const fromJSON = (t) => JSON.parse(t, (k, x) => x && x.__t === 'Map' ? new Map(x.v) : x && x.__t === 'Set' ? new Set(x.v) : x);
  const readNames = () => { try { return JSON.parse(GM_getValue('ua_cache_names', '{}')) || {}; } catch { return {}; } };   // id -> user name, so the list needs no big reads
  const readIndex = () => { try { return JSON.parse(GM_getValue('ua_cache_index', '{}')) || {}; } catch { return {}; } };

  function saveCache(opts) {
    const ts = Date.now();
    try {
      GM_setValue(cacheKey(profileId), toJSON({ ts, opts, state, comments, userInfo, lookupFailed }));
      const idx = readIndex();
      idx[profileId] = ts;
      const ids = Object.keys(idx).sort((a, b) => idx[b] - idx[a]);
      ids.forEach((id, i) => {
        if (i >= CACHE_MAX_USERS || ts - idx[id] > CACHE_MAX_AGE) { GM_deleteValue(cacheKey(id)); delete idx[id]; }
      });
      GM_setValue('ua_cache_index', JSON.stringify(idx));
      const nm = readNames();
      if (state.user) nm[profileId] = state.user.name;
      Object.keys(nm).forEach((id) => { if (!(id in idx)) delete nm[id]; });
      GM_setValue('ua_cache_names', JSON.stringify(nm));
    } catch (e) { log('Could not save this audit: ' + e.message); }
    return ts;
  }

  function loadCache(id = profileId) {
    try {
      const raw = GM_getValue(cacheKey(id), null);
      if (!raw) return null;
      const c = fromJSON(raw);
      if (!c || !c.state || !c.state.user || Date.now() - c.ts > CACHE_MAX_AGE) return null;
      return c;
    } catch { return null; }
  }

  function clearCache(id = profileId) {
    try {
      GM_deleteValue(cacheKey(id));
      const idx = readIndex();
      delete idx[id];
      GM_setValue('ua_cache_index', JSON.stringify(idx));
      const nm = readNames();
      if (id in nm) { delete nm[id]; GM_setValue('ua_cache_names', JSON.stringify(nm)); }
    } catch { /* ignore */ }
  }

  // What the audit on screen actually covers: timespan, which parts were run, how much was loaded, and whether a Max limit cut it off.
  function coverageHtml() {
    const o = state.opts || {};
    const n = (x) => Number(x || 0).toLocaleString('en-US');
    const span = o.from || o.to ? `${o.from ? day(o.from) : 'the start'} → ${o.to ? day(o.to) : 'now'}` : 'all time';
    const hitC = o.maxC && comments.length >= o.maxC;
    const vs = [state.votes && state.votes.A, state.cvotes && !state.cvotes.error ? state.cvotes : null,
      state.recvPosts && state.recvPosts.capHit ? { capHit: true } : null, state.recvComments && state.recvComments.capHit ? { capHit: true } : null];
    const hitV = o.maxV && vs.some((V) => V && (V.capHit || (V.loaded !== undefined && V.loaded >= o.maxV)));
    const cap = (hit) => (hit ? ' <span class="cap">(limit reached)</span>' : '');
    return `<div class="ua-cov"><span class="k">Timespan:</span> ${esc(span)} · <span class="k">Max comments:</span> ${n(o.maxC)}${cap(hitC)} · <span class="k">Max votes:</span> ${n(o.maxV)}${cap(hitV)}</div>`;
  }

  function showStamp(ts, cached) {
    const d = new Date(ts), z = (n) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
    const mins = Math.max(0, Math.round((Date.now() - ts) / 6e4));
    const ago = mins < 2 ? 'just now' : mins < 90 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    const box = $('ua-stamp');
    const other = cached && profileId !== pageId;   // a saved audit of someone other than this page's profile (or any saved audit when off a profile)
    const nm = esc((state.user && state.user.name) || 'user #' + profileId);
    const cov = coverageHtml();
    box.innerHTML = other
      ? `<div class="ua-savedbar">` +
        (onProfile ? `<div class="ua-warn">⚠ You are looking at the saved audit of <b>${userLink(profileId, (state.user && state.user.name) || null)}</b> (#${esc(profileId)}), <b>not</b> the profile you are on (<b>${userLink(pageId, pageName)}</b>, #${esc(pageId)}). Running audits is disabled while this is open.</div>` : '') +
        `<button id="ua-clear-saved" class="ua-clear" title="Delete only this saved audit (${nm}). The other saved audits are kept.">🗑 Delete this audit</button>` +
        `<span class="hint">Saved audit from ${when} (${ago}).${onProfile ? '' : ' Open the user\'s profile to run a fresh audit.'}</span>${cov}</div>`
      : cached
      ? `<div class="ua-savedbar"><div class="ua-info">🕘 <b>Saved audit</b> Press Run audit for fresh data.</div>` +
        `<button id="ua-clear-saved" class="ua-clear" title="Delete this saved audit. Other users' saved audits are kept.">🗑 Delete this audit</button>` +
        `<span class="hint">From ${when} (${ago}).</span>${cov}</div>`
      : `<div class="ua-savedbar"><div class="ua-info">✔ <b>Audited</b> Saved for later.</div>` +
        `<button id="ua-clear-saved" class="ua-clear" title="Delete this saved audit. Other users' saved audits are kept.">🗑 Delete this audit</button>` +
        `<span class="hint">From ${when} (${ago}).</span>${cov}</div>`;
    box.style.display = '';
    renderTabs();
  }

  $('ua-stamp').addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#ua-own')) { e.preventDefault(); showOwn(); return; }
    if (e.target.closest && e.target.closest('#ua-back-saved')) { e.preventDefault(); backToSaved(); return; }
    if (!(e.target.closest && e.target.closest('#ua-clear-saved'))) return;
    e.preventDefault();
    clearCache();
    $('ua-stamp').style.display = 'none';
    if (profileId !== pageId) backToSaved();
  });

  // ---------- saved audits list (shown when the window is opened away from a profile page) ----------
  function showSavedList() {
    const box = $('ua-saved'), idx = readIndex(), names = readNames();
    const ids = Object.keys(idx).filter((id) => Date.now() - idx[id] <= CACHE_MAX_AGE).sort((a, b) => idx[b] - idx[a]);
    let added = false;
    for (const id of ids) if (!names[id]) { const c = loadCache(id); if (c) { names[id] = c.state.user.name; added = true; } }   // audits saved before names were stored
    if (added) { try { GM_setValue('ua_cache_names', JSON.stringify(names)); } catch { /* ignore */ } }
    const ownBtn = onProfile ? '<div class="hint" style="margin-bottom:8px">Opening a saved audit shows that user\'s data, not this profile\'s. Use the first tab to return to this profile.</div>' : '';
    const agoOf = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 6e4)); return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
    box.innerHTML = ids.length
      ? `<div class="ua-saved-head"><b>Saved audits (${ids.length})</b><span class="hint">Newest ${CACHE_MAX_USERS} kept, up to 30 days</span></div>` + ownBtn +
        ids.map((id) => `<div class="ua-cardrow"><a href="#" class="ua-card" data-saved="${esc(id)}"><span><span class="nm">${esc(names[id] || 'user #' + id)}</span> <span class="id">#${esc(id)}</span></span>` +
          `<span class="when"><b>${esc(fmtDT(idx[id]))}</b>${esc(agoOf(idx[id]))}</span><span class="go">›</span></a><button class="ua-del" data-del="${esc(id)}" title="Delete the saved audit of ${esc(names[id] || 'user #' + id)}">🗑</button></div>`).join('')
      : '<div class="ua-saved-head"><b>Saved audits</b></div>' + ownBtn + '<div class="hint">No saved audits yet. Run an audit on a user profile and it is saved here.</div>';
    box.style.display = '';
    setStatus('');
    renderTabs();
  }
  function backToSaved() {
    state = {}; comments = []; userInfo = new Map(); lookupFailed.clear();
    profileId = null; syncMode();
    renderComments(); render();
    $('ua-stamp').style.display = 'none';
    $('ua-name').textContent = '— saved audits';
    showSavedList();
  }
  // Panel look: controls are only usable when the shown audit belongs to this page's profile; a red frame marks someone else's audit on a profile page.
  function syncMode() {
    panel.classList.toggle('ua-off', !onProfile || profileId !== pageId);
    const other = onProfile && profileId !== null && profileId !== pageId;
    panel.classList.toggle('ua-other', other);
    $('ua-badge').style.display = other ? '' : 'none';
    renderTabs();
  }
  // The tabs: this profile (only on a profile page) | all saved audits | the saved audit of someone else that is open now.
  function renderTabs() {
    const idx = readIndex(), n = Object.keys(idx).filter((id) => Date.now() - idx[id] <= CACHE_MAX_AGE).length;
    const mode = profileId === null ? 'list' : (onProfile && profileId === pageId ? 'own' : 'view');
    let h = '';
    if (onProfile) h += `<button class="ua-tab${mode === 'own' ? ' ua-tab-on' : ''}" data-tab="own"><span class="t1">${esc(pageName || 'user #' + pageId)}</span><span class="t2">this profile</span></button>`;
    h += `<button class="ua-tab${mode === 'list' ? ' ua-tab-on' : ''}" data-tab="list"><span class="t1">Saved audits (${n})</span><span class="t2">${onProfile ? 'all users' : 'open one to view it'}</span></button>`;
    if (mode === 'view') h += `<button class="ua-tab ua-tab-on ua-tab-other" data-tab="view"><span class="t1">${esc((state.user && state.user.name) || (readNames()[profileId]) || 'user #' + profileId)}</span><span class="t2">saved audit</span></button>`;
    $('ua-tabs').innerHTML = h;
  }
  // the tabs stay put under the title bar while the report scrolls; they need to know how tall the title bar is
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => panel.style.setProperty('--ua-head-h', head.getBoundingClientRect().height + 'px')).observe(head);
  $('ua-tabs').addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('button[data-tab]');
    if (!t) return;
    if (t.dataset.tab === 'own') { if (profileId !== pageId) showOwn(); return; }
    if (t.dataset.tab === 'list') {
      if (auditRunning) return setStatus('An audit is running. Wait for it to finish, or press Stop, before opening the list.');
      backToSaved();
    }
  });
  // Back to this page's own profile: show its saved audit if there is one.
  function showOwn() {
    if (!onProfile || profileId === pageId) return;
    state = {}; comments = []; userInfo = new Map(); lookupFailed.clear();
    profileId = pageId; syncMode();
    $('ua-saved').style.display = 'none';
    $('ua-stamp').style.display = 'none';
    $('ua-name').textContent = '— ' + (pageName || 'user #' + pageId);
    const c = loadCache(pageId);
    if (c) {
      state = c.state;
      if (!state.opts && c.opts) state.opts = Object.assign({}, c.opts, { ts: c.ts });
      comments = c.comments || [];
      userInfo = c.userInfo instanceof Map ? c.userInfo : new Map();
      if (c.lookupFailed instanceof Set) c.lookupFailed.forEach((x) => lookupFailed.add(x));
      $('ua-name').textContent = '— ' + state.user.name;
      pageName = state.user.name;
    }
    renderTabs();
    try { renderComments(); render(); if (c) showStamp(c.ts, true); } catch (err) { log('Could not show the saved audit (' + err.message + ').'); }
    if (!c) { setStatus('Ready. Set the options you want, then press "Run audit".'); fillOwnName(); }
  }
  // The title shows "user #id" until the name is known: from a saved audit or the names list, otherwise one lookup of this profile.
  async function fillOwnName() {
    if (!onProfile || !/^— user #/.test($('ua-name').textContent)) return;
    const put = (n) => { if (n && profileId === pageId && /^— user #/.test($('ua-name').textContent)) { $('ua-name').textContent = '— ' + n; pageName = n; renderTabs(); } };
    put(readNames()[pageId]);
    if (!/^— user #/.test($('ua-name').textContent)) return;
    try { const u = await getJSON(`/users/${pageId}.json`); put(u && u.name); } catch { /* keep the id */ }
  }
  $('ua-saved').addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#ua-own')) { e.preventDefault(); showOwn(); return; }
    const del = e.target.closest && e.target.closest('button[data-del]');
    if (del) {   // two clicks: the first arms the button, the second deletes that one saved audit
      e.preventDefault();
      if (del.dataset.armed) { clearCache(del.dataset.del); showSavedList(); return; }
      del.dataset.armed = '1'; del.classList.add('ua-armed'); del.textContent = 'Delete?';
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.classList.remove('ua-armed'); del.textContent = '🗑'; } }, 3000);
      return;
    }
    const a = e.target.closest && e.target.closest('a[data-saved]');
    if (!a) return;
    e.preventDefault();
    const c = loadCache(a.dataset.saved);
    if (!c) { showSavedList(); return; }
    profileId = a.dataset.saved; syncMode();
    state = c.state;
    if (!state.opts && c.opts) state.opts = Object.assign({}, c.opts, { ts: c.ts });
    comments = c.comments || [];
    userInfo = c.userInfo instanceof Map ? c.userInfo : new Map();
    lookupFailed.clear();
    if (c.lookupFailed instanceof Set) c.lookupFailed.forEach((x) => lookupFailed.add(x));
    $('ua-saved').style.display = 'none';
    $('ua-name').textContent = '— ' + state.user.name;
    try { renderComments(); render(); showStamp(c.ts, true); }
    catch (err) { log('Could not show the saved audit (' + err.message + ').'); }
  });

  $('ua-run').onclick = () => runAudit(false);
  $('ua-quick').onclick = () => runAudit(true);
  $('ua-stop').onclick = () => { stopFlag = true; log('Stopping...'); };

  (function restoreSaved() {
    if (!onProfile) return;
    const c = loadCache();
    if (!c) return;
    state = c.state;
    if (!state.opts && c.opts) state.opts = Object.assign({}, c.opts, { ts: c.ts });
    comments = c.comments || [];
    userInfo = c.userInfo instanceof Map ? c.userInfo : new Map();
    lookupFailed.clear();
    if (c.lookupFailed instanceof Set) c.lookupFailed.forEach((x) => lookupFailed.add(x));
    try {
      renderComments();
      render();
      showStamp(c.ts, true);
      if (state.user && state.user.name) { $('ua-name').textContent = '— ' + state.user.name; pageName = state.user.name; renderTabs(); }
    } catch (e) { log('Could not show the saved audit (' + e.message + '). Press Run audit for fresh data.'); }
  })();
  renderTabs();
  if (onProfile && !pageName) { const nm0 = readNames()[pageId]; if (nm0) { pageName = nm0; renderTabs(); } }
})();
