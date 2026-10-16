// ==UserScript==
// @name         e6AI Source Cleaner
// @namespace    e6ai-admin-tools
// @version      1.3
// @icon         https://e6ai.net/packs/static/default-66793a8a1f9191d01666.svg
// @author       Jelloponies
// @description  Admin tool: remove invalid sources from one user's posts, with preview, backup and restore.
// @match        https://e6ai.net/*
// @match        https://e621.net/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const DELAY = 1100;       // ms between requests (rate limit)
  const MAX_RETRIES = 5;    // for 429 / 5xx / network errors
  let stopFlag = false;
  let previewBackup = {};   // result of the last preview (not persisted)

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
    #sc-panel button:hover { background: var(--sc-background); color: var(--sc-hover); }
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
    <div class="hint">Passed straight to the site's search. Narrowing it to posts that already have the bad source makes runs much faster.</div>
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
      <button id="sc-apply">Apply</button>
      <button id="sc-stop">Stop</button>
    </div>
    <div>
      <button id="sc-download">Download backup</button>
      <button id="sc-restore">Restore from file…</button>
      <input type="file" id="sc-file" accept=".json" style="display:none">
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

  const $ = (id) => document.getElementById(id);
  const log = (msg) => { const l = $('sc-log'); l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Normalize a source for exact comparison: drop scheme, www., trailing slashes; lowercase.
  const norm = (s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  // ---------- remembered settings ----------
  const FIELDS = ['sc-user', 'sc-tags', 'sc-exact', 'sc-regex', 'sc-reason'];
  function saveSettings() {
    const s = { mode: document.querySelector('input[name=sc-mode]:checked').value, deleted: $('sc-deleted').checked };
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
      await sleep(DELAY);
    }
  }

  // ---------- backups ----------
  function downloadJSON(data, label) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `sources_backup_${label || 'user'}_${Date.now()}.json`;
    a.click();
  }

  function downloadBackup() {
    let saved = null;
    try { saved = JSON.parse(GM_getValue('appliedBackup', 'null')); } catch { /* ignore */ }
    if (saved && Object.keys(saved.data).length) {
      log(`Downloading backup of the last Apply (${Object.keys(saved.data).length} posts, ${new Date(saved.time).toLocaleString()}).`);
      return downloadJSON(saved.data, saved.label);
    }
    if (Object.keys(previewBackup).length) {
      log('No saved Apply backup; downloading the last preview list instead.');
      return downloadJSON(previewBackup, 'preview');
    }
    log('No backup yet. Run Apply first.');
  }

  // ---------- main run ----------
  async function run(apply) {
    stopFlag = false;
    const user = $('sc-user').value.trim().replace(/ /g, '_');
    const extra = $('sc-tags').value.trim();
    const mode = document.querySelector('input[name=sc-mode]:checked').value;
    const reason = $('sc-reason').value.trim() || 'Removing invalid sources';
    if (!user && !extra) return log('Enter a username or some search tags.');

    let re = null;
    let exactMatch = null;
    if (mode === 'exact') {
      const lines = $('sc-exact').value.split('\n').map(norm).filter(Boolean);
      if (!lines.length) return log('Enter at least one source to remove.');
      // each line: plain text must match the whole source; * matches any characters
      const regexes = lines.map((l) =>
        new RegExp('^' + l.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
      exactMatch = (s) => regexes.some((r) => r.test(s));
    }
    if (mode === 'match') {
      if (!$('sc-regex').value) return log('Enter a regex or choose another mode.');
      try { re = new RegExp($('sc-regex').value, 'i'); } catch (e) { return log('Bad regex: ' + e.message); }
    }

    const query = [user && `user:${user}`, extra, $('sc-deleted').checked && 'status:any'].filter(Boolean).join(' ');
    if (apply && !confirm(`Apply changes to posts matching:\n${query}\n\nRun a preview first if you haven't.`)) return;

    const runBackup = {};
    let scanned = 0, changed = 0, failed = 0, removedCount = 0, unsaved = 0;
    const label = user || 'search';
    const status = () => {
      $('sc-status').textContent = `scanned ${scanned} · affected ${changed} · sources removed ${removedCount}` +
        (failed ? ` · failed ${failed}` : '');
    };
    const saveBackup = () => {
      if (apply && Object.keys(runBackup).length) {
        GM_setValue('appliedBackup', JSON.stringify({ label, time: Date.now(), data: runBackup }));
      }
      unsaved = 0;
    };

    log(`--- ${apply ? 'APPLY' : 'PREVIEW'}: ${query} ---`);
    try {
      for await (const post of fetchPosts(query)) {
        if (stopFlag) break;
        scanned++;
        const old = post.sources || [];
        if (old.length) {
          const keep = mode === 'all' ? []
            : mode === 'exact' ? old.filter((s) => !exactMatch(norm(s)))
            : old.filter((s) => !re.test(s));
          if (keep.length !== old.length) {
            changed++;
            removedCount += old.length - keep.length;
            runBackup[post.id] = { original: old };
            log(`#${post.id}: ${old.length} -> ${keep.length}  removed: ${old.filter((s) => !keep.includes(s)).join(' , ')}`);
            if (apply) {
              try { await updateSources(post.id, old, keep, reason); }
              catch (e) { failed++; log(`  !! #${post.id} failed: ${e.message}`); }
              if (++unsaved >= 20) saveBackup();
              await sleep(DELAY);
            }
          }
        }
        status();
      }
    } catch (e) {
      log('Error: ' + e.message);
    } finally {
      status();
      if (apply) saveBackup(); else previewBackup = runBackup;
    }

    log(`${apply ? 'APPLIED' : 'DRY RUN'}: scanned ${scanned}, affected ${changed}, sources removed ${removedCount}` +
      `${failed ? ', failed ' + failed : ''}${stopFlag ? ' (stopped early)' : ''}.`);
    if (apply && changed) {
      log('Backup saved in the browser and downloaded as a file.');
      downloadJSON(runBackup, label);
    }
  }

  async function restore(file) {
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { return log('Invalid backup file.'); }
    const ids = Object.keys(backup);
    if (!confirm(`Restore original sources on ${ids.length} posts?`)) return;
    stopFlag = false;
    log(`--- RESTORE ${ids.length} posts ---`);
    let done = 0;
    for (const id of ids) {
      if (stopFlag) break;
      try {
        const cur = (await getJSON(`/posts/${id}.json`)).post.sources || [];
        await updateSources(id, cur, backup[id].original, 'Restoring sources (cleanup reverted)');
        log(`#${id} restored (${++done}/${ids.length})`);
      } catch (e) { log(`  !! #${id} failed: ${e.message}`); }
      await sleep(DELAY);
    }
    log('Restore finished.');
  }

  $('sc-preview').onclick = () => run(false);
  $('sc-apply').onclick = () => run(true);
  $('sc-stop').onclick = () => { stopFlag = true; log('Stopping...'); };
  $('sc-download').onclick = downloadBackup;
  $('sc-restore').onclick = () => $('sc-file').click();
  $('sc-file').onchange = (e) => e.target.files[0] && restore(e.target.files[0]);
  $('sc-copylog').onclick = () => { GM_setClipboard($('sc-log').textContent); log('Log copied.'); };
  $('sc-clearlog').onclick = () => { $('sc-log').textContent = ''; };
})();
