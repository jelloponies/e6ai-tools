// ==UserScript==
// @name         e6AI Source Cleaner
// @namespace    e6ai-admin-tools
// @version      1.4
// @author       Jelloponies
// @description  Admin tool: remove invalid sources from one user's posts, with preview, backup and restore.
// @match        https://e6ai.net/*
// @match        https://e621.net/*
// @noframes
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const DELAY = 1100;                // ms between requests (rate limit)
  const MAX_DELAY = 5000;            // ceiling for the adaptive delay after 429s
  const MAX_RETRIES = 5;             // for 429 / 5xx / network errors
  const MAX_CONSECUTIVE_FAILS = 5;   // abort a run after this many failed edits in a row
  const MAX_BACKUPS = 5;             // applied-run backups kept in the browser
  const MAX_LOG_LINES = 2000;
  const SITE = location.origin;

  let stopFlag = false;
  let running = false;
  let delay = DELAY;                 // current pacing; grows after 429s, resets each run
  let plan = null;                   // result of the last preview; Apply only edits what is in here

  GM_addStyle(`
    /* Same palette as the User Audit script (the site's "Bloodlust" theme) */
    #sc-toggle, #sc-panel {
      --sc-background: #000000; --sc-foreground: #222222; --sc-section: #333333; --sc-section-light: #4d4d4d;
      --sc-text: #ffffff; --sc-muted: #cbb295; --sc-link: #ffee95; --sc-hover: #f68b00; --sc-accent: #e8c446;
    }
    #sc-toggle { position: fixed; bottom: 16px; right: 16px; z-index: 99999; padding: 8px 12px;
      background: #284a81; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
    #sc-toggle:hover { background: #3a5f9f; }
    #sc-panel {
      position: fixed; z-index: 99999; width: 420px; height: 560px; min-width: 300px; min-height: 260px;
      max-width: 100vw; max-height: 100vh; background: var(--sc-section); color: var(--sc-text);
      border: 1px solid var(--sc-section-light); border-radius: 8px; font-size: 13px;
      box-shadow: 0 4px 20px rgba(0,0,0,.7); display: none; flex-direction: column;
      overflow: hidden; resize: both; box-sizing: border-box; color-scheme: dark; }
    #sc-header { padding: 8px 12px; background: var(--sc-background); border-bottom: 1px solid var(--sc-section-light);
      cursor: move; user-select: none; touch-action: none; font-weight: bold; flex: 0 0 auto;
      display: flex; justify-content: space-between; align-items: center; border-radius: 8px 8px 0 0; }
    #sc-panel #sc-close { margin: 0; padding: 0 8px; font-size: 18px; line-height: 22px; }
    #sc-body { padding: 12px; overflow: auto; flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
    #sc-panel label { display: block; margin: 8px 0 2px; font-weight: bold; }
    #sc-panel input[type=text], #sc-panel textarea { width: 100%; box-sizing: border-box; padding: 4px;
      background: var(--sc-foreground); color: var(--sc-text); border: 1px solid var(--sc-section-light); border-radius: 3px; }
    #sc-panel input[type=text]:focus, #sc-panel textarea:focus { outline: 1px solid var(--sc-accent); }
    #sc-panel button { margin: 8px 6px 0 0; padding: 5px 10px; cursor: pointer; background: var(--sc-foreground);
      color: var(--sc-link); border: 1px solid var(--sc-section-light); border-radius: 4px; }
    #sc-panel button:hover:not(:disabled) { background: var(--sc-background); color: var(--sc-hover); }
    #sc-panel button:disabled { opacity: .45; cursor: not-allowed; }
    #sc-status { margin-top: 10px; font-size: 12px; font-weight: bold; color: var(--sc-accent); }
    #sc-log { margin-top: 6px; flex: 1 1 120px; min-height: 120px; overflow: auto; background: var(--sc-background);
      color: var(--sc-muted); border: 1px solid var(--sc-foreground); font-family: monospace; font-size: 11px;
      padding: 6px; white-space: pre-wrap; }
    #sc-panel .row { display: flex; gap: 12px; align-items: center; margin-top: 6px; }
    #sc-panel .hint { font-size: 11px; color: var(--sc-muted); }
  `);

  const panel = document.createElement('div');
  panel.id = 'sc-panel';
  panel.innerHTML = `
    <div id="sc-header"><span>Source Cleaner <span class="hint">(drag to move, drag corner to resize)</span></span><button id="sc-close" title="Close">&times;</button></div>
    <div id="sc-body">
    <label>Target username <span class="hint">(optional if you enter search tags)</span></label>
    <input type="text" id="sc-user" placeholder="username">
    <label>Extra search tags <span class="hint">(optional)</span></label>
    <input type="text" id="sc-tags" placeholder="e.g. director:name source:*example.com*">
    <div class="hint">Passed straight to the site's search. Narrowing it to posts that already have the bad source makes runs much faster. Don't use order: tags (paging relies on the default order).</div>
    <div class="row">
      <label style="margin:0"><input type="radio" name="sc-mode" value="exact" checked> Remove these exact sources (one per line)</label>
    </div>
    <textarea id="sc-exact" rows="3" style="width:100%;box-sizing:border-box" placeholder="example.com/user/someuser"></textarea>
    <div class="hint">Ignores http/https, www. and a trailing slash. * is a wildcard (e.g. example.com/user/*). Without *, longer links like .../someuser/post/123 are NOT removed.</div>
    <div class="row">
      <label style="margin:0"><input type="radio" name="sc-mode" value="match"> Remove sources matching regex</label>
    </div>
    <input type="text" id="sc-regex" placeholder="e.g. badsite\\.com|example\\.org">
    <div class="row">
      <label style="margin:0"><input type="radio" name="sc-mode" value="all"> Remove ALL sources</label>
    </div>
    <div class="row">
      <label style="margin:0"><input type="checkbox" id="sc-deleted"> Include deleted posts</label>
    </div>
    <label>Edit reason</label>
    <input type="text" id="sc-reason" value="Removing invalid sources">
    <div>
      <button id="sc-preview">Preview (dry run)</button>
      <button id="sc-apply">Apply previewed changes</button>
      <button id="sc-stop">Stop</button>
    </div>
    <div class="hint">Apply only edits the posts listed by the last preview. If you change any setting, run Preview again.</div>
    <div>
      <button id="sc-download">Download backup</button>
      <button id="sc-restore">Restore from file…</button>
      <input type="file" id="sc-file" accept=".json" style="display:none">
    </div>
    <div class="row">
      <label style="margin:0;font-weight:normal"><input type="checkbox" id="sc-force"> Force restore (also overwrite posts edited since the cleanup)</label>
    </div>
    <div id="sc-status"></div>
    <div id="sc-log"></div>
    <div>
      <button id="sc-copylog">Copy log</button>
      <button id="sc-clearlog">Clear log</button>
    </div>
    </div>
  `;
  const toggle = document.createElement('button');
  toggle.id = 'sc-toggle';
  toggle.textContent = 'Source Cleaner';
  document.body.append(panel, toggle);

  // ---------- movable / resizable window ----------
  let geom = {};
  try { geom = JSON.parse(GM_getValue('panelGeom', '{}')); } catch { /* ignore */ }
  if (!(geom && geom.width > 100 && geom.height > 100 && typeof geom.left === 'number' && typeof geom.top === 'number')) geom = {};
  let placed = false;

  function clampPanel() {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.min(Math.max(0, panel.offsetLeft), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(0, panel.offsetTop), Math.max(0, window.innerHeight - h));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  function saveGeom() {
    // A closed (hidden) window measures 0 x 0 at 0,0, so saving then would wipe the remembered position.
    if (panel.style.display !== 'flex' || !placed || !panel.offsetWidth || !panel.offsetHeight) return;
    GM_setValue('panelGeom', JSON.stringify({
      left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight,
    }));
  }
  function placePanel() {
    if (placed) return;
    placed = true;
    if (geom.width) panel.style.width = geom.width + 'px';
    if (geom.height) panel.style.height = geom.height + 'px';
    panel.style.height = Math.min(panel.offsetHeight, window.innerHeight - 72) + 'px';
    if (typeof geom.left === 'number') {
      panel.style.left = geom.left + 'px';
      panel.style.top = geom.top + 'px';
    } else {
      panel.style.left = (window.innerWidth - panel.offsetWidth - 16) + 'px';
      panel.style.top = (window.innerHeight - panel.offsetHeight - 56) + 'px';
    }
    clampPanel();
    // remember size changes made with the resize handle
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(saveGeom, 300); }).observe(panel);
  }

  toggle.onclick = () => {
    const open = panel.style.display !== 'flex';
    panel.style.display = open ? 'flex' : 'none';
    if (open) { placePanel(); clampPanel(); }
  };

  panel.querySelector('#sc-close').addEventListener('click', () => { panel.style.display = 'none'; });
  const header = panel.querySelector('#sc-header');
  let drag = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#sc-close')) return;
    drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panel.style.left = (e.clientX - drag.dx) + 'px';
    panel.style.top = (e.clientY - drag.dy) + 'px';
    clampPanel();
  });
  const endDrag = () => { if (drag) { drag = null; saveGeom(); } };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => { if (panel.style.display === 'flex') clampPanel(); });

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);

  // Append text nodes instead of rebuilding one huge string, and keep the log bounded.
  const log = (msg) => {
    const l = $('sc-log');
    l.appendChild(document.createTextNode(msg + '\n'));
    while (l.childNodes.length > MAX_LOG_LINES) l.removeChild(l.firstChild);
    l.scrollTop = l.scrollHeight;
  };
  const setStatus = (text) => { $('sc-status').textContent = text; };

  // Sleeps in short slices so Stop takes effect quickly, even during a long retry backoff.
  const sleep = async (ms) => {
    const end = Date.now() + ms;
    while (!stopFlag) {
      const left = end - Date.now();
      if (left <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(250, left)));
    }
  };

  // Normalize a source for exact comparison: drop scheme, www., trailing slashes; lowercase.
  const norm = (s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const hostOf = (s) => norm(s).split(/[/?#]/)[0] || '(empty)';
  const sameSources = (a, b) => a.slice().sort().join('\n') === b.slice().sort().join('\n');
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  function setBusy(b) {
    running = b;
    ['sc-preview', 'sc-apply', 'sc-restore'].forEach((id) => { $(id).disabled = b; });
  }

  // Runs one operation at a time.
  async function guarded(fn, ...args) {
    if (running) return log('Something is already running. Wait for it to finish or press Stop.');
    stopFlag = false;
    delay = DELAY;
    setBusy(true);
    try { await fn(...args); }
    catch (e) { log('Unexpected error: ' + e.message); }
    finally { setBusy(false); }
  }

  // ---------- remembered settings ----------
  const FIELDS = ['sc-user', 'sc-tags', 'sc-exact', 'sc-regex', 'sc-reason'];
  const currentMode = () => document.querySelector('input[name=sc-mode]:checked').value;
  function saveSettings() {
    const s = { mode: currentMode(), deleted: $('sc-deleted').checked };
    FIELDS.forEach((id) => (s[id] = $(id).value));
    GM_setValue('settings', JSON.stringify(s));
  }
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(GM_getValue('settings', '{}')); } catch { /* ignore */ }
    FIELDS.forEach((id) => { if (typeof s[id] === 'string') $(id).value = s[id]; });
    const radio = document.querySelector(`input[name=sc-mode][value="${s.mode}"]`);
    if (radio) radio.checked = true;
    $('sc-deleted').checked = !!s.deleted;
  }
  loadSettings();
  panel.addEventListener('input', saveSettings);
  panel.addEventListener('change', saveSettings);

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
        if (e.status === 429) delay = Math.min(Math.round(delay * 1.5), MAX_DELAY); // slow down for the rest of the run
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
  }, url);

  const updateSources = (id, oldSources, newSources, reason) => withRetry(async () => {
    const body = new URLSearchParams({
      'post[source]': newSources.join('\n'),
      'post[old_source]': oldSources.join('\n'),
      'post[edit_reason]': reason,
    });
    checkOk(await fetch(`/posts/${id}.json`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf(), Accept: 'application/json' },
      body,
    }));
  }, `post #${id}`);

  async function* fetchPosts(query) {
    let page = '1';
    while (!stopFlag) {
      const data = await getJSON(`/posts.json?tags=${encodeURIComponent(query)}&limit=320&page=${page}`);
      const posts = data.posts || [];
      if (!posts.length) return;
      yield* posts;
      page = 'b' + posts[posts.length - 1].id;
      await sleep(delay);
    }
  }

  // ---------- backups ----------
  // Backup format (v2): { version, site, label, time, posts: { [id]: { original: [...], after: [...] } } }
  // Older (v1) files are a flat { [id]: { original: [...] } } with no site information.
  function downloadJSON(entry) {
    const safe = (s) => String(s || 'x').replace(/[^\w.-]+/g, '_');
    const site = entry.site ? new URL(entry.site).hostname : 'unknown-site';
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' }));
    a.href = url;
    a.download = `sources_backup_${safe(site)}_${safe(entry.label)}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function loadBackups() {
    try {
      const list = JSON.parse(GM_getValue('appliedBackups', '[]'));
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  // Replaces the entry for this run if already saved, otherwise adds it; keeps the newest MAX_BACKUPS.
  function persistBackup(entry) {
    if (!Object.keys(entry.posts).length) return;
    const list = loadBackups().filter((b) => b.time !== entry.time);
    list.unshift(entry);
    GM_setValue('appliedBackups', JSON.stringify(list.slice(0, MAX_BACKUPS)));
  }

  function downloadBackup() {
    const mine = loadBackups().find((b) => b.site === SITE);
    if (mine) {
      log(`Downloading backup of the last Apply on ${SITE} (${Object.keys(mine.posts).length} posts, ${new Date(mine.time).toLocaleString()}).`);
      return downloadJSON(mine);
    }
    let legacy = null;
    try { legacy = JSON.parse(GM_getValue('appliedBackup', 'null')); } catch { /* ignore */ }
    if (legacy && legacy.data && Object.keys(legacy.data).length) {
      log('No v1.4 backup for this site. Downloading a pre-1.4 backup instead. It has NO site information, so it may belong to a different site.');
      return downloadJSON({ version: 2, site: null, label: legacy.label, time: legacy.time, posts: legacy.data });
    }
    log('No applied backup for this site yet. Run Preview, then Apply.');
  }

  // Accepts v2 and legacy v1 files. Returns { site, posts } or { error }.
  function normalizeBackup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid backup file (unexpected structure).' };
    const isV2 = raw.posts && typeof raw.posts === 'object';
    const posts = isV2 ? raw.posts : raw;
    const bad = Object.keys(posts).filter((id) => {
      const e = posts[id];
      return !/^\d+$/.test(id) || !e || !Array.isArray(e.original) || !e.original.every((s) => typeof s === 'string');
    });
    if (bad.length) return { error: `Invalid backup file: ${bad.length} malformed entries (first: ${bad[0]}). Nothing was changed.` };
    return { site: isV2 ? (raw.site || null) : null, posts };
  }

  // ---------- run: preview & apply ----------
  const currentSpec = () => ({
    site: SITE,
    user: $('sc-user').value.trim().replace(/ /g, '_'),
    extra: $('sc-tags').value.trim(),
    mode: currentMode(),
    exact: $('sc-exact').value,
    regex: $('sc-regex').value,
    deleted: $('sc-deleted').checked,
  });
  const buildQuery = (spec) => [spec.user && `user:${spec.user}`, spec.extra, spec.deleted && 'status:any'].filter(Boolean).join(' ');

  // Returns { filter(oldSources) -> keptSources } or { error }.
  function buildFilter(spec) {
    if (spec.mode === 'all') return { filter: () => [] };
    if (spec.mode === 'exact') {
      const lines = spec.exact.split('\n').map(norm).filter(Boolean);
      if (!lines.length) return { error: 'Enter at least one source to remove.' };
      // each line: plain text must match the whole source; * matches any characters
      const regexes = lines.map((l) =>
        new RegExp('^' + l.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
      return { filter: (old) => old.filter((s) => !regexes.some((r) => r.test(norm(s)))) };
    }
    if (!spec.regex) return { error: 'Enter a regex or choose another mode.' };
    let re;
    try { re = new RegExp(spec.regex, 'i'); } catch (e) { return { error: 'Bad regex: ' + e.message }; }
    return { filter: (old) => old.filter((s) => !re.test(s)) };
  }

  async function preview() {
    const spec = currentSpec();
    plan = null;
    if (!spec.user && !spec.extra) return log('Enter a username or some search tags.');
    if (/(^|\s)-?order:/i.test(spec.extra)) return log('Remove the order: tag from the extra tags. Paging only works with the default order.');
    const f = buildFilter(spec);
    if (f.error) return log(f.error);
    const query = buildQuery(spec);

    const items = [];
    const domains = new Map();
    let scanned = 0, removedCount = 0, errored = false;
    const status = () => setStatus(`scanned ${scanned} · affected ${items.length} · sources to remove ${removedCount}`);

    log(`--- PREVIEW: ${query} ---`);
    try {
      for await (const post of fetchPosts(query)) {
        if (stopFlag) break;
        scanned++;
        const old = post.sources || [];
        if (old.length) {
          const keep = f.filter(old);
          if (keep.length !== old.length) {
            const gone = old.filter((s) => !keep.includes(s));
            items.push({ id: post.id, old, keep });
            removedCount += old.length - keep.length;
            gone.forEach((s) => { const h = hostOf(s); domains.set(h, (domains.get(h) || 0) + 1); });
            log(`#${post.id}: ${old.length} -> ${keep.length}  removed: ${gone.join(' , ')}`);
          }
        }
        status();
      }
    } catch (e) {
      errored = true;
      log('Error: ' + e.message);
    }
    status();

    plan = {
      spec, signature: JSON.stringify(spec), query, items, scanned,
      removed: removedCount, partial: stopFlag || errored, time: Date.now(),
    };
    log(`DRY RUN: scanned ${scanned}, affected ${items.length}, sources to remove ${removedCount}` +
      `${plan.partial ? ' (INCOMPLETE: stopped early or hit an error)' : ''}.`);
    if (domains.size) {
      const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      log('Removed sources by domain:\n' + top.map(([h, n]) => `  ${h}  x${n}`).join('\n') +
        (domains.size > top.length ? `\n  ... and ${domains.size - top.length} more domains` : ''));
    }
    if (items.length) log('Happy with this? Press "Apply previewed changes".');
  }

  async function apply() {
    if (!plan || !plan.items.length) return log('Nothing to apply. Run Preview first.');
    const spec = currentSpec();
    if (JSON.stringify(spec) !== plan.signature) return log('Settings changed since the last preview. Run Preview again first.');

    const modeLabel = { exact: 'remove exact sources', match: 'remove sources matching regex', all: 'REMOVE ALL SOURCES' }[spec.mode];
    const summary = `Query: ${plan.query}\nMode: ${modeLabel}\nPosts to edit: ${plan.items.length}\nSources to remove: ${plan.removed}` +
      (plan.partial ? '\n(The preview was incomplete; only the posts it listed will be changed.)' : '');
    if (spec.mode === 'all') {
      const answer = prompt(`${summary}\n\nThis removes EVERY source from these posts. Type REMOVE ALL to continue.`);
      if ((answer || '').trim() !== 'REMOVE ALL') return log('Cancelled.');
    } else if (!confirm(`${summary}\n\nApply these changes?`)) {
      return;
    }

    const reason = $('sc-reason').value.trim() || 'Removing invalid sources';
    const label = spec.user || 'search';
    const entry = { version: 2, site: SITE, label, time: Date.now(), posts: {} };
    const todo = plan.items;
    let done = 0, failed = 0, removedCount = 0, consecutive = 0, unsaved = 0, aborted = false;
    const status = () => setStatus(`edited ${done}/${todo.length} · sources removed ${removedCount}` + (failed ? ` · failed ${failed}` : ''));

    log(`--- APPLY: ${plan.query} (${todo.length} posts) ---`);
    try {
      for (const it of todo) {
        if (stopFlag) break;
        try {
          await updateSources(it.id, it.old, it.keep, reason);
          // Only successful edits go into the backup.
          entry.posts[it.id] = { original: it.old, after: it.keep };
          done++;
          removedCount += it.old.length - it.keep.length;
          consecutive = 0;
          log(`#${it.id} updated (${it.old.length} -> ${it.keep.length})`);
          if (++unsaved >= 20) { persistBackup(entry); unsaved = 0; }
        } catch (e) {
          failed++;
          consecutive++;
          log(`  !! #${it.id} failed: ${e.message}`);
          if (consecutive >= MAX_CONSECUTIVE_FAILS) {
            aborted = true;
            log(`Aborting: ${MAX_CONSECUTIVE_FAILS} edits failed in a row. Check that you are still logged in, then run Preview again.`);
            break;
          }
        }
        status();
        await sleep(delay);
      }
    } finally {
      status();
      persistBackup(entry);
    }

    log(`APPLIED: edited ${done}/${todo.length}, sources removed ${removedCount}` +
      `${failed ? ', failed ' + failed : ''}${stopFlag ? ' (stopped early)' : ''}${aborted ? ' (aborted)' : ''}.`);
    if (done) {
      log('Backup saved in the browser and downloaded as a file.');
      downloadJSON(entry);
    }
    plan = null; // the preview is used up; run Preview again to check for leftovers
    if (done < todo.length) log('Run Preview again to pick up the posts that were not edited.');
  }

  // ---------- restore ----------
  async function restore(file) {
    let raw;
    try { raw = JSON.parse(await file.text()); } catch { return log('Invalid backup file (not JSON).'); }
    const b = normalizeBackup(raw);
    if (b.error) return log(b.error);
    if (b.site && b.site !== SITE) return log(`This backup is from ${b.site}, but you are on ${SITE}. Open the right site to restore it. Nothing was changed.`);
    const ids = Object.keys(b.posts);
    if (!ids.length) return log('The backup is empty.');
    if (!b.site && !confirm(`This backup has no site information (it was made by an older version).\nMake sure it was made on ${SITE}; otherwise it will edit unrelated posts.\n\nContinue?`)) return;
    const force = $('sc-force').checked;
    if (!confirm(`Restore original sources on ${ids.length} posts?` +
      (force ? '\n\nForce is ON: edits made after the cleanup will be overwritten.' : '\n\nPosts edited since the cleanup will be skipped.'))) return;

    log(`--- RESTORE ${ids.length} posts${force ? ' (force)' : ''} ---`);
    let restored = 0, skipped = 0, failed = 0, consecutive = 0;
    const status = () => setStatus(`restored ${restored} · skipped ${skipped}` + (failed ? ` · failed ${failed}` : '') + ` · of ${ids.length}`);
    for (const id of ids) {
      if (stopFlag) break;
      const entry = b.posts[id];
      try {
        const cur = (await getJSON(`/posts/${id}.json`)).post.sources || [];
        if (sameSources(cur, entry.original)) {
          skipped++;
          log(`#${id} already has the original sources, skipped`);
        } else if (!force && Array.isArray(entry.after) && !sameSources(cur, entry.after)) {
          skipped++;
          log(`#${id} was edited after the cleanup, skipped (tick "Force restore" to overwrite)`);
        } else {
          await updateSources(id, cur, entry.original, 'Restoring sources (cleanup reverted)');
          restored++;
          log(`#${id} restored (${restored}/${ids.length})`);
        }
        consecutive = 0;
      } catch (e) {
        failed++;
        consecutive++;
        log(`  !! #${id} failed: ${e.message}`);
        if (consecutive >= MAX_CONSECUTIVE_FAILS) {
          log(`Aborting: ${MAX_CONSECUTIVE_FAILS} failures in a row. Check that you are still logged in.`);
          break;
        }
      }
      status();
      await sleep(delay);
    }
    log(`Restore finished: restored ${restored}, skipped ${skipped}${failed ? ', failed ' + failed : ''}${stopFlag ? ' (stopped early)' : ''}.`);
  }

  // ---------- wiring ----------
  $('sc-preview').onclick = () => guarded(preview);
  $('sc-apply').onclick = () => guarded(apply);
  $('sc-stop').onclick = () => {
    if (!running) return log('Nothing is running.');
    stopFlag = true;
    log('Stopping...');
  };
  $('sc-download').onclick = downloadBackup;
  $('sc-restore').onclick = () => $('sc-file').click();
  $('sc-file').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // so picking the same file again still fires change
    if (f) guarded(restore, f);
  };
  $('sc-copylog').onclick = () => { GM_setClipboard($('sc-log').textContent); log('Log copied.'); };
  $('sc-clearlog').onclick = () => { $('sc-log').textContent = ''; };
})();
