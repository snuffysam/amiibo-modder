import { parseMasterKeys, loadEditorResources, lookupAbility, SsbuAmiibo } from '../amiibo-editor/ssbu-amiibo.js';

/* ---------- configuration: every repo path lives here ---------- */
const CONFIG = {
  fighterCsv: 'data/fighterList.csv',
  spiritCsv: 'data/spiritList.csv',
  aiCsv: 'data/aiList.csv',
  keyFile: 'data/key_retail.bin',
  templateDir: 'data/templates/',
  defaultBin: 'data/bins/Starter.bin',
  miiBins: {
    'Mii Brawler': 'data/bins/Mii_Brawler.bin',
    'Mii Swordfighter': 'data/bins/Mii_Swordfighter.bin',
    'Mii Gunner': 'data/bins/Mii_Gunner.bin',
  },
  // fighterList.csv name -> name used in amiibo-editor/resources/characters.json
  characterNames: { 'R.O.B.': 'R.O.B. - NES', 'Steve/Alex': 'Steve' },
  zipName: 'amiibo-lineup.zip',
};
const STARTERS = ['Squirtle', 'Ivysaur', 'Charizard'];
const isMii = (f) => f in CONFIG.miiBins;
const $ = (id) => document.getElementById(id);

/* ---------- data loading ---------- */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}
const loadCsv = async (url) => parseCsv(await (await fetchOk(url)).text());

let fighterNames = [], spirits = new Map(), spiritOptions = [], aiOptions = [], aiByLower = new Map();

async function loadData() {
  const [f, s, a] = await Promise.all([loadCsv(CONFIG.fighterCsv), loadCsv(CONFIG.spiritCsv), loadCsv(CONFIG.aiCsv)]);
  fighterNames = f.map((r) => r[0].trim());
  for (const r of s) {
    const label = `${r[0].trim()} (${(r[1] || '').trim()})`;
    spirits.set(label.toLowerCase(), { label, support: parseInt(r[1], 10) || 0, abilities: (r[2] || '').trim() });
    spiritOptions.push({ value: label });
  }
  for (const r of a) { aiOptions.push({ value: r[0].trim(), tip: (r[1] || '').trim() }); aiByLower.set(r[0].trim().toLowerCase(), r[0].trim()); }
}

/* ---------- combobox (type-ahead dropdown restricted to a list) ---------- */
function combobox({ options, placeholder = '', allowEmpty = false, label }) {
  const wrap = Object.assign(document.createElement('div'), { className: 'combo' });
  const input = Object.assign(document.createElement('input'), { type: 'text', placeholder, autocomplete: 'off', spellcheck: false });
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  if (label) input.setAttribute('aria-label', label);
  const list = Object.assign(document.createElement('ul'), { className: 'combo-list', hidden: true });
  list.setAttribute('role', 'listbox');
  wrap.append(input, list);
  let committed = '', shown = [], active = -1;
  const listeners = [];
  const tipFor = (v) => options.find((o) => o.value === v)?.tip || '';

  const hide = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const paint = () => [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  function show() {
    const q = input.value.trim().toLowerCase();
    const starts = [], inner = [];
    for (const o of options) { const l = o.value.toLowerCase(); if (!q || l.startsWith(q)) starts.push(o); else if (l.includes(q)) inner.push(o); }
    shown = [...starts, ...inner].slice(0, 80);
    list.replaceChildren(...shown.map((o, i) => {
      const li = Object.assign(document.createElement('li'), { textContent: o.value, title: o.tip || '' });
      li.setAttribute('role', 'option');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); commit(o.value); });
      return li;
    }));
    active = shown.length && q ? 0 : -1; paint();
    list.hidden = !shown.length; input.setAttribute('aria-expanded', String(!list.hidden));
  }
  function commit(v) {
    const changed = v !== committed;
    committed = v; input.value = v; input.title = tipFor(v); hide();
    if (changed) listeners.forEach((fn) => fn(v));
  }
  input.addEventListener('focus', () => { input.select(); show(); });
  input.addEventListener('input', show);
  input.addEventListener('blur', () => {
    const t = input.value.trim().toLowerCase();
    const hit = options.find((o) => o.value.toLowerCase() === t);
    if (hit) commit(hit.value); else if (allowEmpty && t === '') commit(''); else { input.value = committed; hide(); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (list.hidden) show();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % (shown.length || 1); paint();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { if (!list.hidden && active >= 0) { e.preventDefault(); commit(shown[active].value); } }
    else if (e.key === 'Escape') { input.value = committed; hide(); }
  });
  return { el: wrap, input, get value() { return committed; }, set value(v) { commit(v); }, onChange: (fn) => listeners.push(fn) };
}

/* ---------- fighter blocks ---------- */
const fighters = [];

function field(text, control, cls = '') {
  const l = document.createElement('label');
  l.className = `fld ${cls}`.trim();
  const s = document.createElement('span'); s.textContent = text;
  l.append(s, control);
  return l;
}
function numberInput(min, max, value) {
  const i = Object.assign(document.createElement('input'), { type: 'number', step: 1, value });
  if (min !== undefined) i.min = min; if (max !== undefined) i.max = max;
  return i;
}
function select(items, labelFn = (x) => x) {
  const s = document.createElement('select');
  items.forEach((x, i) => s.add(new Option(labelFn(x, i), i)));
  return s;
}
const clampInt = (v, lo, hi, d) => { let n = parseInt(v, 10); if (Number.isNaN(n)) n = d; return Math.min(hi, Math.max(lo, n)); };

function addFighter(init = {}) {
  const card = Object.assign(document.createElement('section'), { className: 'fighter' });
  const spine = Object.assign(document.createElement('div'), { className: 'spine' });
  const slot = Object.assign(document.createElement('div'), { className: 'slot' });
  const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'rm', textContent: 'Remove' });
  spine.append(slot, rm);
  const fields = Object.assign(document.createElement('div'), { className: 'fields' });
  card.append(spine, fields);

  const fighter = combobox({ options: fighterNames.map((value) => ({ value })), placeholder: 'Start typing a fighter…', label: 'Fighter' });
  const starter = select(STARTERS, (x) => `${x} Start`);
  const moveInputs = ['Neutral', 'Side', 'Up', 'Down'].map(() => numberInput(1, 3, 1));
  const costume = select([...Array(8)], (_, i) => `Costume ${i + 1}`);
  const miiCostume = Object.assign(document.createElement('input'), { type: 'text' });
  const nick = Object.assign(document.createElement('input'), { type: 'text', maxLength: 9 });
  const atk = numberInput(undefined, undefined, 0), def = numberInput(undefined, undefined, 0);
  const sp = [0, 1, 2].map((i) => combobox({ options: spiritOptions, allowEmpty: true, placeholder: 'Spirit (optional)', label: `Spirit ${i + 1}` }));
  const ai = combobox({ options: aiOptions, allowEmpty: true, placeholder: 'AI (optional)', label: 'AI' });

  const fFighter = field('Fighter', fighter.el, 'w6');
  const fStarter = field('Pokémon Trainer starter', starter, 'w4');
  const moves = Object.assign(document.createElement('div'), { className: 'moves' });
  ['Neutral', 'Side', 'Up', 'Down'].forEach((n, i) => moves.append(field(n, moveInputs[i])));
  const fCostume = field('Costume', costume, 'w4');
  const fMiiCostume = field('Costume', miiCostume, 'w4');
  fields.append(fFighter, fStarter, moves, fCostume, fMiiCostume, field('Nickname', nick, 'w4'), field('Attack +', atk, 'w4'), field('Defense +', def, 'w4'),
    ...sp.map((c, i) => field(`Spirit ${i + 1}`, c.el, 'w4')), field('AI', ai.el, 'w12'));

  const refresh = () => {
    const f = fighter.value;
    fStarter.hidden = f !== 'Pokemon Trainer';
    moves.hidden = !isMii(f); fMiiCostume.hidden = !isMii(f); fCostume.hidden = isMii(f);
  };
  fighter.onChange(refresh);

  const api = {
    card,
    setSlot(n) { slot.textContent = n; rm.setAttribute('aria-label', `Remove fighter ${n}`); },
    get() {
      return {
        fighter: fighter.value, starter: starter.selectedIndex,
        moves: moveInputs.map((i) => clampInt(i.value, 1, 3, 1)),
        costume: costume.selectedIndex + 1, miiCostume: miiCostume.value,
        nickname: nick.value.slice(0, 9),
        attack: clampInt(atk.value, -32768, 32767, 0), defense: clampInt(def.value, -32768, 32767, 0),
        spirits: sp.map((c) => c.value).filter(Boolean), ai: ai.value,
      };
    },
    set(s) {
      fighter.value = s.fighter || ''; starter.selectedIndex = s.starter || 0;
      (s.moves || [1, 1, 1, 1]).forEach((v, i) => (moveInputs[i].value = v));
      costume.selectedIndex = (s.costume || 1) - 1; miiCostume.value = s.miiCostume || '';
      nick.value = (s.nickname || '').slice(0, 9); atk.value = s.attack || 0; def.value = s.defense || 0;
      sp.forEach((c, i) => (c.value = s.spirits?.[i] || '')); ai.value = s.ai || '';
      refresh();
    },
  };
  rm.addEventListener('click', () => { fighters.splice(fighters.indexOf(api), 1); card.remove(); renumber(); });
  api.set(init); refresh();
  fighters.push(api); $('lineup').append(card); renumber();
  return api;
}
function renumber() {
  fighters.forEach((f, i) => f.setSlot(i + 1));
  $('empty').hidden = fighters.length > 0;
}

/* ---------- plain-text format ---------- */
const signed = (n) => (n < 0 ? `${n}` : `+${n}`);

function toText(list) {
  return list.map((s) => {
    const support = s.spirits.reduce((n, x) => n + (spirits.get(x.toLowerCase())?.support || 0), 0);
    let head;
    if (isMii(s.fighter)) head = `${s.fighter} (${s.moves.join('')}) (${s.miiCostume})`;
    else if (s.fighter === 'Pokemon Trainer') head = `${s.fighter} (${STARTERS[s.starter]} Start) (Costume ${s.costume})`;
    else head = `${s.fighter} (Costume ${s.costume})`;
    const lines = [head];
    if (s.nickname) lines.push(s.nickname);
    lines.push(`Attack ${signed(s.attack)}/Defense ${signed(s.defense)}/Support +${support}`);
    lines.push(...s.spirits);
    if (s.ai) lines.push(s.ai);
    return lines.join('\n');
  }).join('\n\n');
}

function parseText(text) {
  const warnings = [], out = [];
  const byLen = [...fighterNames].sort((a, b) => b.length - a.length);
  const lookupFighter = (n) => fighterNames.find((f) => f.toLowerCase() === n.trim().toLowerCase());
  let cur = null, sawStats = false;
  const start = (s) => { cur = { fighter: '', starter: 0, moves: [1, 1, 1, 1], costume: 1, miiCostume: '', nickname: '', attack: 0, defense: 0, spirits: [], ai: '', ...s }; out.push(cur); sawStats = false; };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^(Mii (?:Brawler|Swordfighter|Gunner))\s*\(([1-3]{4})\)\s*(?:\((.*)\))?$/i)) && lookupFighter(m[1])) {
      start({ fighter: lookupFighter(m[1]), moves: [...m[2]].map(Number), miiCostume: m[3] || '' }); continue;
    }
    if ((m = line.match(/^(.+?)\s*\((Squirtle|Ivysaur|Charizard) Start\)\s*\(Costume ([1-8])\)$/i)) && lookupFighter(m[1])) {
      start({ fighter: lookupFighter(m[1]), starter: STARTERS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()), costume: +m[3] }); continue;
    }
    if ((m = line.match(/^(.+?)\s*\(Costume ([1-8])\)$/i)) && lookupFighter(m[1])) {
      start({ fighter: lookupFighter(m[1]), costume: +m[2] }); continue;
    }
    if (!cur) { warnings.push(`Ignored line before the first fighter: "${line}"`); continue; }
    if (/^(Attack|Defense|Support)\b/i.test(line)) {
      sawStats = true;
      const a = line.match(/Attack\s*([+-]?\s*\d+)/i), d = line.match(/Defense\s*([+-]?\s*\d+)/i);
      if (a) cur.attack = parseInt(a[1].replace(/\s/g, ''), 10);
      if (d) cur.defense = parseInt(d[1].replace(/\s/g, ''), 10);
      continue;
    }
    const sp = spirits.get(line.toLowerCase());
    if (sp) { if (cur.spirits.length < 3) cur.spirits.push(sp.label); else warnings.push(`${cur.fighter}: more than 3 spirits, ignored "${line}"`); continue; }
    const aiName = aiByLower.get(line.toLowerCase()) || aiByLower.get(`${line.toLowerCase()} ai`);
    if (aiName) { cur.ai = aiName; continue; }
    if (!sawStats && !cur.nickname) { cur.nickname = line.slice(0, 9); if (line.length > 9) warnings.push(`Nickname "${line}" cut to 9 characters.`); continue; }
    warnings.push(`${cur.fighter}: could not understand "${line}"`);
  }
  return { fighters: out, warnings };
}

/* ---------- dialog ---------- */
const dlg = $('pasteDialog');
$('pasteText').addEventListener('click', () => {
  $('pasteArea').value = toText(fighters.map((f) => f.get()));
  $('pasteWarn').hidden = true; dlg.showModal();
});
$('pasteCancel').addEventListener('click', () => dlg.close());
$('pasteApply').addEventListener('click', () => {
  const { fighters: parsed, warnings } = parseText($('pasteArea').value);
  fighters.splice(0).forEach((f) => f.card.remove());
  parsed.forEach((s) => addFighter(s));
  renumber();
  dlg.close();
  if (warnings.length) showStatus('Applied with notes:', warnings.map((w) => ({ cls: 'note', text: w })));
});
$('addFighter').addEventListener('click', () => addFighter().card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));

/* ---------- status area ---------- */
function showStatus(head, items = []) {
  const box = $('status'); box.hidden = false; box.replaceChildren();
  const p = document.createElement('div'); p.textContent = head; box.append(p);
  if (items.length) {
    const ul = document.createElement('ul');
    items.forEach((i) => ul.append(Object.assign(document.createElement('li'), { className: i.cls || '', textContent: i.text })));
    box.append(ul);
  }
}

/* ---------- export ---------- */
let localKey = null;
$('keyFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { localKey = await parseMasterKeys(await f.arrayBuffer()); $('keyPick').hidden = true; showStatus('Key loaded. Press Export BIN again.'); }
  catch (err) { showStatus(err.message, [{ cls: 'bad', text: 'That file was rejected.' }]); }
});
async function getKeys() {
  if (localKey) return localKey;
  let r;
  try { r = await fetchOk(CONFIG.keyFile); } catch { $('keyPick').hidden = false; throw new Error(`Could not load ${CONFIG.keyFile}.`); }
  return parseMasterKeys(await r.arrayBuffer());
}

const safeName = (n) => n.replace(/[\\/:*?"<>|]/g, '-').trim();
function abilityIds(spiritLabels, who, warn) {
  const ids = [];
  for (const label of spiritLabels) {
    const sp = spirits.get(label.toLowerCase());
    for (const part of (sp?.abilities || '').split('+').map((x) => x.trim()).filter(Boolean)) {
      const hit = lookupAbility(editorRes, part);
      if (!hit) { warn(`${who}: no ability named "${part}" (from ${label}) in abilities.txt, skipped.`); continue; }
      if (hit.ambiguous) warn(`${who}: "${part}" matches several abilities; used "${hit.line}" (others: ${hit.ambiguous.slice(1).join(', ')}).`);
      ids.push(hit.id);
    }
  }
  if (ids.length > 3) warn(`${who}: spirits grant ${ids.length} abilities; only the first 3 fit.`);
  return ids.slice(0, 3);
}

let editorRes = null;
$('exportBin').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  if (!fighters.length) { showStatus('Add at least one fighter first.'); return; }
  const states = fighters.map((f) => f.get());
  const empty = states.findIndex((s) => !s.fighter);
  if (empty >= 0) { showStatus(`Fighter ${empty + 1} has no fighter selected.`); return; }
  btn.disabled = true;
  const log = [];
  try {
    showStatus('Loading key and resources…');
    const keys = await getKeys();
    editorRes ||= await loadEditorResources();
    const binCache = new Map(), tplCache = new Map();
    const bin = async (url) => { if (!binCache.has(url)) binCache.set(url, fetchOk(url).then((r) => r.arrayBuffer())); return binCache.get(url); };
    const template = async (ai) => {
      if (tplCache.has(ai)) return tplCache.get(ai);
      const base = ai.replace(/\s+/g, ''), alt = ai.replace(/[^A-Za-z0-9]/g, '');
      let tpl = null;
      for (const n of new Set([base, alt])) { try { tpl = await (await fetchOk(`${CONFIG.templateDir}${n}.json`)).json(); break; } catch { /* try next */ } }
      tplCache.set(ai, tpl); return tpl;
    };

    const totals = {}; states.forEach((s) => (totals[safeName(s.fighter)] = (totals[safeName(s.fighter)] || 0) + 1));
    const seen = {}, zip = new JSZip();
    for (const [i, s] of states.entries()) {
      const who = `Fighter ${i + 1} (${s.fighter})`;
      showStatus(`Building ${who}…`, log);
      try {
        const amiibo = await SsbuAmiibo.open(keys, editorRes, await bin(isMii(s.fighter) ? CONFIG.miiBins[s.fighter] : CONFIG.defaultBin));
        if (s.ai) {
          const tpl = await template(s.ai);
          if (tpl) amiibo.applyTemplate(tpl);
          else log.push({ cls: 'note', text: `${who}: no template file for "${s.ai}" in ${CONFIG.templateDir}; CPU behaviour left as in the base file.` });
        }
        amiibo.setCharacter(CONFIG.characterNames[s.fighter] || s.fighter);
        amiibo.setNickname(s.nickname);
        amiibo.setAbilities(abilityIds(s.spirits, who, (t) => log.push({ cls: 'note', text: t })));
        amiibo.setStats(s.attack, s.defense);
        if (isMii(s.fighter)) amiibo.setMiiSpecials(s.moves);
        else { amiibo.setCostume(s.costume); if (s.fighter === 'Pokemon Trainer') amiibo.setPokemonStarter(s.starter); }

        const base = safeName(s.fighter);
        const name = totals[base] > 1 ? `${base}_${(seen[base] = (seen[base] || 0) + 1)}.bin` : `${base}.bin`;
        zip.file(name, await amiibo.export());
      } catch (err) {
        log.push({ cls: 'bad', text: `${who}: ${err.message}` });
      }
    }
    if (!Object.keys(zip.files).length) throw new Error('No files were generated.');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: CONFIG.zipName });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showStatus(`Done: ${Object.keys(zip.files).length} file(s) in ${CONFIG.zipName}.`, log);
  } catch (err) {
    showStatus(err.message, log.concat([{ cls: 'bad', text: 'Export stopped.' }]));
  } finally { btn.disabled = false; }
});

/* ---------- start ---------- */
const toolbarBtns = document.querySelectorAll('.toolbar button');
toolbarBtns.forEach((b) => (b.disabled = true));
loadData().then(() => { renumber(); toolbarBtns.forEach((b) => (b.disabled = false)); }).catch((err) => {
  showStatus(`Could not load the data files (${err.message}). If you opened index.html straight from disk, serve the folder over http instead (see README).`);
});
