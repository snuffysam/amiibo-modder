# Amiibo Lineup Builder

A static site (GitHub Pages) for building Super Smash Bros. Ultimate amiibo lineups in bulk: pick fighters,
costumes, nicknames, Attack/Defense, up to three spirits and a CPU AI, then download every amiibo as a `.bin`
inside one ZIP. The amiibo editing code is a JavaScript port of
[jozz024/smash-amiibo-editor](https://github.com/jozz024/smash-amiibo-editor) (MIT, licence kept in `amiibo-editor/LICENSE`).
The port was checked byte-for-byte against the original Python tool.

## Repo layout

```
index.html
css/style.css
js/app.js                      UI, text format, export loop (all paths are in CONFIG at the top)
amiibo-editor/                 <- the Amiibo modification code lives here
  ssbu-amiibo.js               decrypt / edit / re-encrypt (Web Crypto, no dependencies)
  LICENSE                      upstream MIT licence
  resources/                   abilities.txt, characters.json, regions.json (copied from upstream)
data/
  fighterList.csv  spiritList.csv  aiList.csv
  key_retail.bin               <- YOU add this (see below)
  bins/                        Starter.bin, Mii_Brawler.bin, Mii_Gunner.bin, Mii_Swordfighter.bin
  templates/                   KraidAI.json, MedusaAI.json, ... one per AI
tools/selftest.mjs             optional: node tools/selftest.mjs
```

## Publish

1. Put this folder's contents at the root of your repo (so `index.html` is at the top level).
2. Add your `key_retail.bin` as `data/key_retail.bin`.
3. Repo Settings -> Pages -> deploy from the branch root.

**About the key:** a public repo makes `key_retail.bin` downloadable by anyone. If you'd rather not host it, leave
it out: when the file isn't found, the page shows a file picker so you can load the key from your own computer
(it never leaves your browser).

## Run locally

Browsers block `fetch` on `file://`, so serve the folder: `python3 -m http.server`, then open http://localhost:8000.

## Naming rules and behaviour

- **AI templates:** "Kraid AI" loads `data/templates/KraidAI.json` (spaces removed; "Waddle Dee AI" -> `WaddleDeeAI.json`).
  Only Alucard, Kraid, Medusa and Waddle Dee were supplied. For any other AI the export still works but leaves the
  base file's CPU behaviour and tells you which template is missing.
- **Mii bins** use the underscore names you uploaded (`Mii_Brawler.bin`).
- **Character names:** `R.O.B.` -> `R.O.B. - NES`, `Steve/Alex` -> `Steve`; everything else matches `characters.json` directly.
- **Support** in the text format is the sum of the chosen spirits' column B; it is recomputed on export and ignored on paste.
- **Abilities:** column C is matched to `abilities.txt` (`Up x2` -> arrows, hyphens ignored). Two names exist in two variants
  (`Air Attack Up`, `Hyper Smash Attacks`); the first listed is used and the export status says so. A spirit set can grant
  at most 3 abilities; extras are dropped with a note.
- **Files:** `Fighter.bin`, or `Fighter_1.bin`, `Fighter_2.bin` when a fighter appears more than once. `/` in names becomes `-`.
- As in the original editor, a changed AI region marks the nickname with a trailing `□`; that is why nicknames cap at 9 characters.
