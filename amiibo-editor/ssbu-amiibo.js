/*
 * Browser port of the core of smash-amiibo-editor (https://github.com/jozz024/smash-amiibo-editor)
 * and the pyamiibo crypto it relies on. Original work MIT licensed (see ./LICENSE).
 * No dependencies: uses the built-in Web Crypto API (needs https:// or http://localhost).
 */

const subtle = globalThis.crypto.subtle;
const KEY_SHA256 = {
  data: '868106135941cbcab3552bd14880a7a34304ef340958a6998b61a38ba3ce13d3',
  tag: 'b48727797cd2548200b99c665b20a78190470163ccb8e5682149f1b2f7a006cf',
};

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function hmac256(key, ...parts) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, concat(...parts)));
}

/** Validate and split the 160-byte key_retail.bin into data/tag master keys. */
export async function parseMasterKeys(buf) {
  const b = new Uint8Array(buf);
  if (b.length !== 160) throw new Error(`key_retail.bin is ${b.length} bytes (should be 160).`);
  const one = async (slice, expected, label) => {
    if (hex(await subtle.digest('SHA-256', slice)) !== expected)
      throw new Error(`key_retail.bin failed the ${label} key check (wrong or corrupt key file).`);
    return {
      hmacKey: slice.slice(0, 16), typeString: slice.slice(16, 30),
      magicSize: slice[31], magicBytes: slice.slice(32, 48), xorPad: slice.slice(48, 80),
    };
  };
  return { data: await one(b.slice(0, 80), KEY_SHA256.data, 'data'), tag: await one(b.slice(80), KEY_SHA256.tag, 'tag') };
}

/* ---- layout conversion (pyamiibo cli) ---- */
export function dumpToAmiitools(d) {
  const o = d.slice();
  o.set(d.slice(0x008, 0x010), 0x000); o.set(d.slice(0x080, 0x0a0), 0x008);
  o.set(d.slice(0x010, 0x034), 0x028); o.set(d.slice(0x0a0, 0x208), 0x04c);
  o.set(d.slice(0x034, 0x054), 0x1b4); o.set(d.slice(0x000, 0x008), 0x1d4);
  o.set(d.slice(0x054, 0x080), 0x1dc);
  return o;
}
export function amiitoolsToDump(i) {
  const o = i.slice();
  o.set(i.slice(0x000, 0x008), 0x008); o.set(i.slice(0x008, 0x028), 0x080);
  o.set(i.slice(0x028, 0x04c), 0x010); o.set(i.slice(0x04c, 0x1b4), 0x0a0);
  o.set(i.slice(0x1b4, 0x1d4), 0x034); o.set(i.slice(0x1d4, 0x1dc), 0x000);
  o.set(i.slice(0x1dc, 0x208), 0x054);
  return o;
}

/* ---- checksums from ssbu_amiibo.py ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 1; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let t = 0;
  for (const k of bytes) t = ((t >>> 8) ^ CRC_TABLE[(k ^ t) & 0xff]) >>> 0;
  return (t ^ 0xffffffff) >>> 0;
}
function crc16Wii(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      crc = crc & 0x10000 ? (crc ^ 0x1021) & 0xffff : crc & 0xffff;
    }
  }
  return crc;
}
const putLE32 = (d, off, v) => { for (let i = 0; i < 4; i++) d[off + i] = (v >>> (8 * i)) & 0xff; };

/* ---- key derivation / crypto (pyamiibo AmiiboDump) ---- */
async function deriveKey(d, key, deriveAes) {
  const append = 16 - key.magicSize;
  const extract = concat(d.slice(0x11, 0x13), new Uint8Array(14));
  const uid = d.slice(0, 8);
  const user = d.slice(0x60, 0x80).map((v, i) => v ^ key.xorPad[i]);
  const seed = concat(key.typeString, extract.slice(0, append), key.magicBytes.slice(0, key.magicSize), uid, uid, user);
  const k1 = await hmac256(key.hmacKey, Uint8Array.of(0, 1), seed);
  if (!deriveAes) return { hmacKey: k1.slice(0, 16) };
  const k0 = await hmac256(key.hmacKey, Uint8Array.of(0, 0), seed);
  return { hmacKey: k1.slice(0, 16), aesKey: k0.slice(0, 16), iv: k0.slice(16, 32) };
}
const cryptBlock = (d) => concat(d.slice(0x14, 0x34), d.slice(0xa0, 0x208));
function putCryptBlock(d, v) { d.set(v.slice(0, 0x20), 0x14); d.set(v.slice(0x20), 0xa0); }
async function aesCtr(aesKey, iv, bytes) {
  // CTR: encrypt and decrypt are the same operation
  const k = await subtle.importKey('raw', aesKey, 'AES-CTR', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 128 }, k, bytes));
}
async function hmacs(d, tagKey, dataKey) {
  const tag = await hmac256(tagKey, d.slice(0, 8), d.slice(0x54, 0x80));
  const data = await hmac256(dataKey, d.slice(0x11, 0x34), d.slice(0xa0, 0x208), tag, d.slice(0, 8), d.slice(0x54, 0x80));
  return { tag, data };
}

/* ---- resources ---- */
const NUM_RE = /(:\s*)(\d{15,})(?=\s*[,}])/g; // characters.json ids exceed 2^53: keep exact via BigInt

export async function loadEditorResources(baseUrl = new URL('./resources/', import.meta.url)) {
  const get = async (f) => { const r = await fetch(new URL(f, baseUrl)); if (!r.ok) throw new Error(`Cannot load ${f}`); return r.text(); };
  const [abil, chars, regs] = await Promise.all([get('abilities.txt'), get('characters.json'), get('regions.json')]);
  const abilities = abil.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const characters = new Map(Object.entries(JSON.parse(chars.replace(NUM_RE, '$1"$2"')).characters).map(([k, v]) => [k, BigInt(v)]));
  const enums = new Map(), texts = new Map();
  for (const r of JSON.parse(regs).regions) {
    const start = parseInt(r.start, 16);
    if (r.type === 'enum') enums.set(`ENUM-${start}-${r.length}-${r.bit_start_location}`, r.options);
    if (r.type === 'text') texts.set(`Text-${start}-${r.length}`, r.big_endian);
  }
  return { abilities, characters, enums, texts, abilityIndex: buildAbilityIndex(abilities) };
}

/* ---- ability name lookup: "Critical-Health Stats Up x2" -> index of "Critical-Health Stats ↑↑ (L 2)" ---- */
const ALIASES = { 'unflinching charged smash attacks': 'unflinching charged smashes' };
export function normalizeAbility(s) {
  s = s.replace(/\s*\((?:[LU])\s*[^)]*\)\s*$/, '');
  s = s.replace(/(?:↑\s*)+/g, (m) => { const n = (m.match(/↑/g) || []).length; return n > 1 ? `Up x${n} ` : 'Up '; });
  s = s.replace(/(?:↓\s*)+/g, (m) => { const n = (m.match(/↓/g) || []).length; return n > 1 ? `Down x${n} ` : 'Down '; });
  s = s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return ALIASES[s] || s;
}
function buildAbilityIndex(lines) {
  const m = new Map();
  lines.forEach((l, i) => { const k = normalizeAbility(l); (m.get(k) || m.set(k, []).get(k)).push(i + 1); });
  return m; // value = list of 1-based ability ids (None is 0)
}
/** Returns {id, line, ambiguous} or null. Where an ability exists in several variants (L/U), the first is used. */
export function lookupAbility(res, name) {
  const ids = res.abilityIndex.get(normalizeAbility(name));
  if (!ids) return null;
  return { id: ids[0], line: res.abilities[ids[0] - 1], ambiguous: ids.length > 1 ? ids.map((i) => res.abilities[i - 1]) : null };
}

/* ---- bit helpers (identical semantics to VirtualAmiiboFile.get_bits/set_bits) ---- */
function stepPos(p, reverse) {
  if (reverse) { p.i--; if (p.i === -1) { p.i = 7; p.byte++; } } else { p.i++; if (p.i === 8) { p.i = 0; p.byte++; } }
}
function bankersRound(x) { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1; }

export class SsbuAmiibo {
  constructor(keys, res) { this.keys = keys; this.res = res; }

  /** bytes: locked 540-byte (or 532-572 byte) dump. Resolves to an unlocked, amiitools-layout editor. */
  static async open(keys, res, bytes) {
    let b = new Uint8Array(bytes).slice(); // own copy: unlocking edits in place
    if (b.length !== 540) {
      if (b.length < 532 || b.length > 572) throw new Error(`Invalid dump size (${b.length} bytes).`);
      const f = new Uint8Array(540); f.set(b.slice(0, 540)); b = f;
    }
    const a = new SsbuAmiibo(keys, res);
    a.d = b;
    await a.#unlock();
    return a;
  }

  async #unlock() {
    const d = this.d;
    const k = { tag: await deriveKey(d, this.keys.tag, false), data: await deriveKey(d, this.keys.data, true) };
    putCryptBlock(d, await aesCtr(k.data.aesKey, k.data.iv, cryptBlock(d)));
    const h = await hmacs(d, k.tag.hmacKey, k.data.hmacKey);
    if (!same(h.tag, d.slice(0x34, 0x54))) throw new Error('Tag HMAC mismatch: wrong key_retail.bin or corrupt dump.');
    if (!same(h.data, d.slice(0x80, 0xa0))) throw new Error('Data HMAC mismatch: wrong key_retail.bin or corrupt dump.');
    if (hex(d.slice(266, 270)) !== '34f80200') { // not an SSBU amiibo yet: initialise game data
      d[0x14] |= 1 << 5;
      d.set([0x34, 0xf8, 0x02, 0x00], 266);
      d.set([0x01, 0x00, 0x6a, 0x80, 0x30, 0x16, 0xe0, 0x00], 0x100);
      d.fill(0, 0x130, 0x208);
      putLE32(d, 304, crc32(d.slice(308, 520)));
    }
    const c = crc32(d.slice(308, 520));
    if (hex(d.slice(304, 308)) !== hex(Uint8Array.of(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24)))
      throw new Error('The checksum for this amiibo game data is not correct. Use an untampered amiibo.');
    this.baseline = d.slice();
    this.data = dumpToAmiitools(d);
  }

  /* --- nickname handling in dump layout (used when locking) --- */
  static #nick(d) {
    let s = '';
    for (let o = 0x20; o < 0x34; o += 2) { const c = (d[o] << 8) | d[o + 1]; if (c === 0) break; s += String.fromCharCode(c); }
    return s.replace(/\0+$/, '');
  }
  static #setNick(d, s) {
    if (s.length > 10) throw new Error('nickname too long');
    d.fill(0, 0x20, 0x34);
    [...s].forEach((ch, i) => { const c = ch.charCodeAt(0); d[0x20 + 2 * i] = c >> 8; d[0x21 + 2 * i] = c & 255; });
  }

  /** Re-encrypts and returns the final 540-byte .bin */
  async export() {
    const d = amiitoolsToDump(this.data);
    const mark = (n) => (n.endsWith('□') ? n : n.length >= 10 ? n.slice(0, 9) + '□' : n + '□');
    const now = SsbuAmiibo.#nick(d), before = SsbuAmiibo.#nick(this.baseline);
    if (!same(d.slice(444, 502), this.baseline.slice(444, 502))) {
      d[311] |= 1;
      SsbuAmiibo.#setNick(d, mark(now));
    } else if (before.endsWith('□') && !now.endsWith('□')) {
      SsbuAmiibo.#setNick(d, mark(now));
    }
    putLE32(d, 304, crc32(d.slice(308, 520)));
    const m = crc16Wii(d.slice(0xa0, 0xfe));
    d[0xfe] = m >> 8; d[0xff] = m & 255;
    const k = { tag: await deriveKey(d, this.keys.tag, false), data: await deriveKey(d, this.keys.data, true) };
    const h = await hmacs(d, k.tag.hmacKey, k.data.hmacKey);
    d.set(h.tag, 0x34); d.set(h.data, 0x80);
    putCryptBlock(d, await aesCtr(k.data.aesKey, k.data.iv, cryptBlock(d)));
    d.fill(0, 532, 540); // password + ack, as the original editor does when saving
    return d;
  }

  /* --- raw bit access on the amiitools layout --- */
  getBits(byte, bit, n, reverse = false) {
    const p = { byte, i: bit }; let s = '';
    for (let k = 0; k < n; k++) { s += (this.data[p.byte] >> (7 - p.i)) & 1; stepPos(p, reverse); }
    if (reverse) s = [...s].reverse().join('');
    return BigInt('0b' + s);
  }
  setBits(byte, bit, n, value, reverse = false) {
    const s = BigInt(value).toString(2).padStart(n, '0');
    if (s.length > n) throw new RangeError(`value ${value} does not fit in ${n} bits`);
    const p = { byte, i: bit };
    for (let k = 0; k < n; k++) {
      const v = reverse ? s[n - 1 - k] : s[k], mask = 0x80 >> p.i;
      this.data[p.byte] = v === '1' ? this.data[p.byte] | mask : this.data[p.byte] & ~mask;
      stepPos(p, reverse);
    }
  }
  #setText(start, text, bigEndian, maxChars = 10) {
    const out = new Uint8Array(20);
    [...text].slice(0, maxChars).forEach((ch, i) => {
      const c = ch.charCodeAt(0);
      out[2 * i] = bigEndian ? c >> 8 : c & 255; out[2 * i + 1] = bigEndian ? c & 255 : c >> 8;
    });
    this.data.set(out, start);
  }

  /* --- template (.json of "type-start-length[-bit]": value) --- */
  applyTemplate(tpl) {
    for (const [sig, raw] of Object.entries(tpl)) {
      const [type, a, b, c] = sig.split('-'); const start = +a, len = +b;
      try {
        if (type === 'ENUM') { const o = this.res.enums.get(sig)?.[raw]; if (o !== undefined) this.setBits(start, +c, len, o); }
        else if (type === 'percentage') this.setBits(start, +c, len, bankersRound((Math.min(100, Math.max(0, parseFloat(raw))) / 100) * (2 ** len - 1)), true);
        else if (type === 'unsigned') this.#setInt(start, len, parseInt(raw, 10), false);
        else if (type === 'signed') this.#setInt(start, len, parseInt(raw, 10), true);
        else if (type === 'bits') this.setBits(start, +c, len, parseInt(raw, 2));
        else if (type === 'Text') this.#setText(start, String(raw), this.res.texts.get(`Text-${start}-${len}`) ?? true);
      } catch { /* skip malformed entry, like the original editor */ }
    }
  }
  #setInt(start, bits, v, signed) {
    const lim = 2 ** bits; if (signed) v = Math.max(-lim / 2, Math.min(lim / 2 - 1, v)); else v = Math.max(0, Math.min(lim - 1, v));
    let u = BigInt.asUintN(bits, BigInt(v));
    for (let i = 0; i < bits / 8; i++) { this.data[start + i] = Number(u & 0xffn); u >>= 8n; }
  }

  /* --- the edits the website needs --- */
  setCharacter(name) {
    const id = this.res.characters.get(name);
    if (id === undefined) throw new Error(`Unknown amiibo character "${name}"`);
    this.setBits(476, 0, 64, id);
  }
  setNickname(name) { this.#setText(56, name, true, 9); }
  setAbilities(ids) { [236, 237, 238].forEach((off, i) => this.data[off] = ids[i] || 0); }
  setStats(attack, defense) {
    this.#setInt(336, 16, 6000 + 500 * attack, true);
    this.#setInt(338, 16, 6000 + 500 * defense, true);
  }
  setCostume(n) { this.setBits(419, 4, 4, n - 1); }                 // 1..8
  setPokemonStarter(i) { this.setBits(418, 0, 8, i); }              // 0 Squirtle, 1 Ivysaur, 2 Charizard
  setMiiSpecials([neutral, side, up, down]) {                       // each 1..3
    this.setBits(239, 6, 2, neutral - 1); this.setBits(239, 4, 2, side - 1);
    this.setBits(239, 2, 2, up - 1); this.setBits(239, 0, 2, down - 1);
  }
}
