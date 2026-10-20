// ==UserScript==
// @name         e6ai BUR Transitive Resolver
// @namespace    http://tampermonkey.net/
// @version      2025-06-10
// @description  One click resolve all transitives
// @author       Tarrgon
//@contributor   DRLa
//@contributor   Jelloponies
// @match        https://e6ai.net/bulk_update_requests/*
// @icon         https://e6ai.net/packs/static/default-66793a8a1f9191d01666.svg
// @grant        none
// ==/UserScript==

// Tags that alias to this tag
async function getTagConsequentAliases(tagName) {
  const res = await fetch(`https://e6ai.net/tag_aliases.json?search[consequent_name]=${tagName}&search[status]=Active`);

  const data = await res.json();

  if (data.tag_aliases) return [];

  return data.map(a => a.antecedent_name);
}

// Tags that this tag aliases to, should only ever be one...
async function getTagAntecedentAliases(tagName) {
  const res = await fetch(`https://e6ai.net/tag_aliases.json?search[antecedent_name]=${tagName}&search[status]=Active`);

  const data = await res.json();

  if (data.tag_aliases) return [];

  return data.map(a => a.consequent_name);
}

// Tags that imply this tag
async function getTagConsequentImplications(tagName) {
  const res = await fetch(`https://e6ai.net/tag_implications.json?search[consequent_name]=${tagName}&search[status]=Active`);

  const data = await res.json();

  if (data.tag_implications) return [];

  return data.map(a => a.antecedent_name);
}

// Tags that this tag implies
async function getTagAntecedentImplications(tagName) {
  const res = await fetch(`https://e6ai.net/tag_implications.json?search[antecedent_name]=${tagName}&search[status]=Active`);

  const data = await res.json();

  if (data.tag_implications) return [];

  return data.map(a => a.consequent_name);
}

async function resolveTransitives() {
  const firstBur = [];
  const secondBur = [];

  const scriptLines = document.querySelector('#a-show .styled-dtext').innerText.split('\n');

  const count = scriptLines.filter(l => l.toLowerCase().endsWith('# has blocking transitive relationships, cannot be applied through bur')).length;
  let done = 0;

  for (const line of scriptLines) {
    if (line.toLowerCase().endsWith('# has blocking transitive relationships, cannot be applied through bur')) {
      E621.Toast.notice(`${done}/${count} transitives resolved...`);
      const split = line.split(' -> ');
      const antecedent = split[0].split(' ').at(-2);
      const consequent = split[1].split(' ')[0];

      const [aliasedTo] = await getTagAntecedentAliases(antecedent);

      if (aliasedTo) {
        firstBur.push([`unalias ${antecedent} -> ${aliasedTo}`]);
        continue;
      }

      const consequentAliases = await getTagConsequentAliases(antecedent);

      for (const consequentAlias of consequentAliases) {
        firstBur.push(`unalias ${consequentAlias} -> ${antecedent}`);
        secondBur.push(`alias ${consequentAlias} -> ${consequent}`);
      }

      const antecedentImplications = await getTagAntecedentImplications(antecedent);

      for (const antecedentImplication of antecedentImplications) {
        firstBur.push(`unimply ${antecedent} -> ${antecedentImplication}`);
        secondBur.push(`imply ${consequent} -> ${antecedentImplication}`);
      }

      const consequentImplications = await getTagConsequentImplications(antecedent);

      for (const consequentImplication of consequentImplications) {
        firstBur.push(`unimply ${consequentImplication} -> ${antecedent}`);
        secondBur.push(`imply ${consequentImplication} -> ${consequent}`);
      }

      done++;
    }
  }

  return [Array.from(new Set(firstBur)), Array.from(new Set(secondBur))];
}

const PREFILL_KEY = 'bur-transitive-prefill';

function getBurId() {
  const m = location.pathname.match(/bulk_update_requests\/(\d+)/);
  return m ? m[1] : null;
}

// The "forum #1234" reference on the BUR page links to /forum_topics/<topic id>?page=1#forum_post_1234
function getForumTopicId() {
  const link = document.querySelector('#a-show a[href*="/forum_topics/"]');
  if (!link) return null;
  const m = link.getAttribute('href').match(/\/forum_topics\/(\d+)/);
  return m ? m[1] : null;
}

// Stores the data in localStorage (URLs would get too long for big scripts) and opens the new BUR page,
// where the second half of this userscript fills in the form.
function openNewBur(script, title, reason, forumTopicId) {
  try {
    localStorage.setItem(PREFILL_KEY, JSON.stringify({ script, title, reason, forumTopicId, time: Date.now() }));
  } catch (e) {
    console.error('Could not store BUR prefill data', e);
  }
  window.open('https://e6ai.net/bulk_update_requests/new?transitive_prefill=1', '_blank');
}

function addNewBur(bur, titleText, burTitle, burReason, forumTopicId) {
  const anchor = document.getElementById('fix-button');

  const details = document.createElement('details');
  details.open = true;
  details.style.margin = '0.5em 0';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor: pointer; display: flex; align-items: center; gap: 1em;';

  // display: flex removes the browser's default arrow, so draw our own
  const arrow = document.createElement('span');
  arrow.style.cssText = 'font-size: 1.2em; width: 1em;';
  const updateArrow = () => { arrow.innerText = details.open ? '\u25BC' : '\u25B6'; };
  updateArrow();
  summary.appendChild(arrow);

  const title = document.createElement('h1');
  title.style.cssText = 'display: inline-block; margin: 0.5em 0;';
  title.innerText = titleText;
  summary.appendChild(title);

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
    // Don't toggle the collapsible when clicking the button
    e.preventDefault();
    e.stopPropagation();
    openNewBur(bur, burTitle, burReason, forumTopicId);
  });
  summary.appendChild(openButton);

  details.appendChild(summary);

  const pre = document.createElement('pre');
  const p = document.createElement('p');
  p.innerText = bur;
  pre.appendChild(p);
  details.appendChild(pre);

  anchor.after(details);
}

function addFixButton() {
  const header = document.querySelector('#a-show h2');
  const button = document.createElement('button');
  button.id = 'fix-button';
  button.classList.add('button', 'btn-success')
  button.innerText = 'Fix Transitives';

  button.addEventListener('click', async () => {
    const [firstBur, secondBur] = await resolveTransitives();
    const burId = getBurId();
    const burUrl = location.origin + location.pathname;
    const forumTopicId = getForumTopicId();

    const title = document.createElement('h1');
    title.style['margin-top'] = '0.5em';
    title.innerText = 'Original Script';
    button.after(title);

    addNewBur(
      secondBur.join('\n'),
      'Second',
      `Resolve transitives for BUR #${burId} (2/2)`,
      `Part 2 of 2 to resolve the blocking transitive relationships of ${burUrl}. Must be approved after part 1.`,
      forumTopicId
    );
    addNewBur(
      firstBur.join('\n'),
      'First',
      `Resolve transitives for BUR #${burId} (1/2)`,
      `Part 1 of 2 to resolve the blocking transitive relationships of ${burUrl}. Must be approved before part 2.`,
      forumTopicId
    );
  });

  header.after(button);
}

// Runs on /bulk_update_requests/new: fills in the form with the stored data
function prefillNewBur() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(PREFILL_KEY));
    localStorage.removeItem(PREFILL_KEY); // use only once
  } catch (e) {
    return;
  }

  // Ignore stale data (e.g. a tab that never got opened)
  if (!data || Date.now() - data.time > 5 * 60 * 1000) return;

  const fill = (name, value) => {
    const el = document.querySelector(`[name="bulk_update_request[${name}]"]`);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  fill('script', data.script);
  fill('title', data.title);
  fill('reason', data.reason);

  if (data.forumTopicId) {
    // Field name is a guess, so fall back to finding the input via its "Forum topic" label
    if (!fill('forum_topic_id', data.forumTopicId)) {
      const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim().toLowerCase() === 'forum topic');
      const input = label && (document.getElementById(label.htmlFor) || label.parentElement.querySelector('input'));
      if (input) {
        input.value = data.forumTopicId;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
}

(async function () {
  'use strict';

  if (location.pathname.startsWith('/bulk_update_requests/new')) {
    prefillNewBur();
    return;
  }

  const dtext = document.querySelector('#a-show .styled-dtext');
  if (!dtext) return;

  const scriptLines = dtext.innerText.split('\n');

  for (const line of scriptLines) {
    if (line.toLowerCase().endsWith('# has blocking transitive relationships, cannot be applied through bur')) {
      addFixButton();
      return;
    }
  }
})();
