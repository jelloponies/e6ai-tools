// ==UserScript==
// @name         e6ai BUR Transitive Resolver
// @namespace    http://tampermonkey.net/
// @version      2026-10-20
// @description  One click resolve all transitives
// @author       Tarrgon
// @contributor  DRLa
// @contributor  Jelloponies
// @match        https://e6ai.net/bulk_update_requests/*
// @match        https://e621.net/bulk_update_requests/*
// @icon         https://e6ai.net/packs/static/default-66793a8a1f9191d01666.svg
// @grant        none
// ==/UserScript==

const BLOCKED_MARKER = '# has blocking transitive relationships, cannot be applied through bur';
const PREFILL_KEY = 'bur-transitive-prefill';
const PREFILL_MAX_AGE_MS = 5 * 60 * 1000;
const REQUEST_INTERVAL_MS = 600; // the site allows 2 requests/second (hard limit, hitting it gives a 503), stay below that
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RESULTS_ID = 'transitive-results';

/* ---------- Helpers ---------- */

const notify = (msg) => window.E621?.Toast?.notice(msg);

// Message next to the Fix button, stays visible (toasts disappear)
function setStatus(msg, isError = false) {
  const el = document.getElementById('transitive-status');
  if (!el) return;
  el.innerText = msg;
  el.style.color = isError ? '#e45f5f' : '';
}

function getScriptLines() {
  const dtext = document.querySelector('#a-show .styled-dtext');
  return dtext ? dtext.innerText.split('\n') : [];
}

const isBlocked = (line) => line.toLowerCase().endsWith(BLOCKED_MARKER);

function getBurId() {
  return location.pathname.match(/bulk_update_requests\/(\d+)/)?.[1] ?? null;
}

// The "forum #1234" reference links to /forum_topics/<topic id>?page=1#forum_post_1234
function getForumTopicId() {
  const href = document.querySelector('#a-show a[href*="/forum_topics/"]')?.getAttribute('href');
  return href?.match(/\/forum_topics\/(\d+)/)?.[1] ?? null;
}

// "create alias a (12) -> b (0) # ..." => { antecedent: 'a', consequent: 'b' }
function parseLine(line) {
  const m = line.match(/^\S+\s+\S+\s+(\S+)\s+(?:\(\d+\)\s+)?->\s+(\S+)/);
  return m ? { antecedent: m[1], consequent: m[2] } : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hands out request start times at least REQUEST_INTERVAL_MS apart, no matter how many callers wait
let nextSlot = 0;

async function waitForSlot() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + REQUEST_INTERVAL_MS; // reserved right away, so callers can't grab the same slot
  if (start > now) await sleep(start - now);
}

/* ---------- API ---------- */

const requestCache = new Map();

// fetch + JSON with a timeout and retries (rate limits, server errors, network problems)
async function fetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let error;
    let waitMs = 1000 * 2 ** attempt;

    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (res.ok) return await res.json();

      error = new Error(`${res.status} ${res.statusText} (${url})`);
      error.retry = RETRYABLE_STATUS.has(res.status);
      const retryAfter = Number(res.headers.get('Retry-After'));
      if (retryAfter > 0) waitMs = retryAfter * 1000;
    } catch (e) {
      error = e.name === 'AbortError' ? new Error(`Timed out (${url})`) : e;
      error.retry = true;
    } finally {
      clearTimeout(timer);
    }

    if (!error.retry || attempt >= MAX_RETRIES) throw error;
    nextSlot = Math.max(nextSlot, Date.now() + waitMs); // cool down: nothing else is sent until then
  }
}

// endpoint: tag_aliases | tag_implications
// searchBy: antecedent_name | consequent_name (which side `tagName` is on)
// pick: which side of the result to return
function getRelations(endpoint, searchBy, tagName, pick) {
  const url = `/${endpoint}.json?search[${searchBy}]=${encodeURIComponent(tagName)}&search[status]=Active&limit=320`;

  if (!requestCache.has(url)) {
    requestCache.set(url, fetchJson(url));
  }

  return requestCache.get(url).then((data) =>
    // An empty result comes back as { tag_aliases: [] } instead of an array
    Array.isArray(data) ? data.map((r) => r[pick]) : []
  );
}

/* ---------- Resolving ---------- */

async function resolveLine({ antecedent, consequent }) {
  const first = [];
  const second = [];

  // What this tag aliases to (at most one). If it is aliased, nothing else matters, saves 3 requests
  const [aliasedTo] = await getRelations('tag_aliases', 'antecedent_name', antecedent, 'consequent_name');

  if (aliasedTo) {
    first.push(`unalias ${antecedent} -> ${aliasedTo}`);
    return { first, second };
  }

  const [aliasedFrom, implies, impliedBy] = await Promise.all([
    getRelations('tag_aliases', 'consequent_name', antecedent, 'antecedent_name'),      // tags aliased to this tag
    getRelations('tag_implications', 'antecedent_name', antecedent, 'consequent_name'), // tags this tag implies
    getRelations('tag_implications', 'consequent_name', antecedent, 'antecedent_name'), // tags implying this tag
  ]);

  for (const alias of aliasedFrom) {
    first.push(`unalias ${alias} -> ${antecedent}`);
    second.push(`alias ${alias} -> ${consequent}`);
  }

  for (const tag of implies) {
    first.push(`unimply ${antecedent} -> ${tag}`);
    second.push(`imply ${consequent} -> ${tag}`);
  }

  for (const tag of impliedBy) {
    first.push(`unimply ${tag} -> ${antecedent}`);
    second.push(`imply ${tag} -> ${consequent}`);
  }

  return { first, second };
}

async function resolveTransitives() {
  const lines = getScriptLines().filter(isBlocked).map(parseLine).filter(Boolean);
  let done = 0;

  const progress = (n) => {
    const msg = `${n}/${lines.length} transitives resolved...`;
    notify(msg);
    setStatus(msg);
  };
  progress(0);

  // One line at a time keeps the counter steady. The request spacing is the bottleneck anyway, so this isn't slower
  const results = [];
  for (const line of lines) {
    results.push(await resolveLine(line));
    progress(++done);
  }

  // Set keeps insertion order and removes duplicates
  const first = [...new Set(results.flatMap((r) => r.first))];
  const second = [...new Set(results.flatMap((r) => r.second))];
  return { first, second };
}

/* ---------- UI (BUR page) ---------- */

// Stores the data in localStorage (URLs would get too long for big scripts) and opens the new BUR page,
// where prefillNewBur() fills in the form.
function openNewBur(data) {
  try {
    localStorage.setItem(PREFILL_KEY, JSON.stringify({ ...data, time: Date.now() }));
  } catch (e) {
    console.error('Could not store BUR prefill data', e);
  }
  window.open('/bulk_update_requests/new', '_blank');
}

function createBurSection(heading, script, burData) {
  const details = document.createElement('details');
  details.open = true;
  details.style.margin = '0.5em 0';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor: pointer; display: flex; align-items: center; gap: 0.5em;';

  // display: flex removes the browser's default arrow, so draw our own
  const arrow = document.createElement('span');
  arrow.style.cssText = 'font-size: 1.2em; width: 1em;';
  const updateArrow = () => { arrow.innerText = details.open ? '\u25BC' : '\u25B6'; };
  updateArrow();

  const title = document.createElement('h1');
  title.style.cssText = 'display: inline-block; margin: 0.5em 0.5em 0.5em 0;';
  title.innerText = heading;

  // Toggle manually so it works regardless of site styles
  summary.addEventListener('click', (e) => {
    e.preventDefault();
    details.open = !details.open;
    updateArrow();
  });

  const openButton = document.createElement('button');
  openButton.classList.add('button', 'btn-neutral');
  openButton.innerText = 'Open as new BUR';
  openButton.addEventListener('click', (e) => {
    // Don't toggle the section when clicking the button
    e.preventDefault();
    e.stopPropagation();
    openNewBur({ script, ...burData });
  });

  summary.append(arrow, title, openButton);

  const pre = document.createElement('pre');
  const p = document.createElement('p');
  p.innerText = script;
  pre.appendChild(p);

  details.append(summary, pre);
  return details;
}

function renderResults(button, { first, second }) {
  document.getElementById(RESULTS_ID)?.remove();

  const burId = getBurId();
  const burUrl = location.origin + location.pathname;
  const forumTopicId = getForumTopicId();

  const part = (n, order) => ({
    title: `Resolve transitives for BUR #${burId} (${n}/2)`,
    reason: `Part ${n} of 2 to resolve the blocking transitive relationships of ${burUrl}. Must be approved ${order}.`,
    forumTopicId,
  });

  const container = document.createElement('div');
  container.id = RESULTS_ID;

  const original = document.createElement('h1');
  original.style.marginTop = '0.5em';
  original.innerText = 'Original Script';

  container.append(
    createBurSection('First', first.join('\n'), part(1, 'before part 2')),
    createBurSection('Second', second.join('\n'), part(2, 'after part 1')),
    original,
  );

  (document.getElementById('transitive-status') ?? button).after(container);
}

function addFixButton() {
  const header = document.querySelector('#a-show h2');
  if (!header) return;

  const button = document.createElement('button');
  button.id = 'fix-button';
  button.classList.add('button', 'btn-success');
  button.innerText = 'Fix Transitives';

  const status = document.createElement('span');
  status.id = 'transitive-status';
  status.style.marginLeft = '0.75em';

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Resolving...');
    try {
      renderResults(button, await resolveTransitives());
      setStatus('');
    } catch (e) {
      console.error(e);
      setStatus(`Could not resolve transitives: ${e.message}`, true);
    } finally {
      button.disabled = false;
    }
  });

  header.after(button);
  button.after(status);
}

/* ---------- UI (new BUR page) ---------- */

function setField(el, value) {
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function prefillNewBur() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(PREFILL_KEY));
    localStorage.removeItem(PREFILL_KEY); // use only once
  } catch (e) {
    return;
  }

  // Ignore stale data (e.g. a tab that never got opened)
  if (!data || Date.now() - data.time > PREFILL_MAX_AGE_MS) return;

  const field = (name) => document.querySelector(`[name="bulk_update_request[${name}]"]`);

  setField(field('script'), data.script);
  setField(field('title'), data.title);
  setField(field('reason'), data.reason);

  if (data.forumTopicId) {
    // Field name is a guess, so fall back to finding the input via its "Forum topic" label
    if (!setField(field('forum_topic_id'), data.forumTopicId)) {
      const label = [...document.querySelectorAll('label')]
        .find((l) => l.textContent.trim().toLowerCase() === 'forum topic');
      const input = label && (document.getElementById(label.htmlFor) || label.parentElement.querySelector('input'));
      setField(input, data.forumTopicId);
    }
  }
}

/* ---------- Entry point ---------- */

(function () {
  'use strict';

  if (location.pathname.startsWith('/bulk_update_requests/new')) {
    prefillNewBur();
  } else if (getScriptLines().some(isBlocked)) {
    addFixButton();
  }
})();
