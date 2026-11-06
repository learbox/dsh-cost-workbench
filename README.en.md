# Cost Workbench (dsh-cost-workbench)

[中文](README.md) | English

A **cost-estimation workbench** that lives in the right sidebar of a DeepSeek Harness session:
a note library, pricing basis, material prices, variation ledger, cost calculator, glossary,
meeting recordings, and prompt templates — plus global search and a usage badge.

Your data is plain Markdown in an Obsidian vault. The workbench is just another view of the
same files; there is no second database.

This plugin is derived from `dsh-legal-workbench` (original authors' copyright, MIT), reworked for
cost estimating on Windows. See [License](#license).

## Install

**Requires** Windows 10/11 and the DeepSeek Harness 0.2.2 desktop app. The plugin is installed as a
**link** from the local source folder — no download, no network access needed.

1. **Quit DeepSeek Harness completely**: tray icon → Quit, then confirm in Task Manager that no
   `DeepSeek` process is left. Closing the window is not enough; the tray process keeps running.
2. In PowerShell (a normal, non-elevated shell is fine):

   ```powershell
   cd "C:\path\to\dsh-cost-workbench"
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

   The script checks the process, resolves the plugin folder, calls the bundled DSH CLI, and tells
   you to restart the app when it finishes.

   > Replace `C:\path\to\dsh-cost-workbench` with the folder you actually put the plugin in
   > (the script uses its own parent directory as the plugin folder).
3. **Restart DeepSeek Harness.**
4. Open any session and click the workbench icon next to the session title, or press `Alt+W`.

### Manual install (same thing)

```powershell
& "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\path\to\dsh-cost-workbench"
```

Using a custom profile? Replace `desktop` with your profile name (see `C:\Users\<you>\.dsh\profiles\`).
Either way, the change takes effect after an app restart.

### If the install fails

The script prints the absolute path of the profile patch file:

```
C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml
```

It only prints the path — it never edits the file for you. Check that the CLI version matches the
app (0.2.2), back up the file, then append a `dsh-cost-workbench` insert entry as described by the
script and restart the app.

## First run

Configuration needs exactly one thing: the path of your Obsidian vault. Two entry points:

- **Settings → Cost Workbench** (recommended — come back here to change it any time)
- the first-run prompt inside the workbench panel (fallback)

Either pick a folder with **“Choose…”** (system folder picker; a missing folder is created), or paste
the path directly:

```
D:\Obsidian\造价工作台
```

Saving takes effect immediately, with no restart. An empty path is reported instead of failing silently.
To change the vault later, open **Settings → Cost Workbench** again and save.

### Opening notes in Obsidian

The library card's **Open** button uses an `obsidian://` deep link, which requires the folder to be
registered as a vault in Obsidian:

1. Open Obsidian → “Open another vault” → “Open folder as vault”
2. Pick your workbench vault folder (e.g. `E:\文档\Obsidian\造价工作台`)
3. From then on **Open** jumps straight to the note

If the vault name inside Obsidian differs from the folder name, fill in
**Settings → Cost Workbench → Obsidian vault name** (leave empty to use the folder name).
Without the vault registered, Obsidian shows `Vault not found` — add it once as above.

### Transcription and balances (optional)

Live transcription in the meeting card and the **DeepSeek balance** / **voice resource pack**
badges at the top of the panel need credentials, entered under **Settings → Cost Workbench** in
the “Transcription and balances” card:

| Field | Used for | Where to get it |
|---|---|---|
| Volcengine streaming API Key | live meeting transcription | Volcengine Console → Speech → App management |
| Volcengine AccessKey / SecretKey | voice resource-pack balance | Volcengine Console → Access Control → Keys |
| DeepSeek API Key | DeepSeek balance badge | DeepSeek Platform → API Keys |

They are stored in `~/.dsh-workbench/asr.json`; the UI only shows configured / not configured and
never echoes secrets. You can also edit that file directly. Leave a configured field blank to keep
it; press “Clear” next to it to remove it.

**Nothing else breaks without them**: library, the three tables, the calculator, glossary and search
all work; only transcription is unavailable and the badges stay hidden. The badges live in the
workbench panel's top toolbar, next to the refresh button.

If that vault does not exist yet, run the seed script first (it is idempotent — existing files are
skipped, never overwritten):

```powershell
cd "C:\path\to\dsh-cost-workbench"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\seed-vault.ps1
```

The default target is `%USERPROFILE%\Obsidian\造价工作台`; pass
`-VaultPath "D:\Obsidian\造价工作台"` to create it somewhere else (then point the workbench
at that same folder with “Choose…”).

It creates the `Workbench/` tables (a glossary with 30 cost terms, five sample pricing-basis rows,
empty material-price and variation ledgers) and four starter notes under `00 资料库/`.

## Opening it

- **A session with messages**: the icon to the right of the session title.
- **A brand-new empty session**: the rightmost button in the row above the composer.
- **Shortcut**: `Alt+W` on Windows (`⌥W` on macOS); `Esc` closes.

It docks as a tab in the right sidebar (resizable, full-screenable, closable). When the sidebar is
not available in a session it falls back to an overlay instead of failing silently.

## The eight cards

| Card | What it does |
|---|---|
| **Library** | Tree of `00 资料库/`; read a note on the right, edit it back, insert it into the composer, open it in Obsidian, or copy it |
| **Pricing basis** | Code, name, category, version/number, effective date, note; create/edit/delete lands on disk immediately |
| **Material prices** | Material, spec, unit, price, region, date, source; a duplicate "material + spec + unit + region" is rejected |
| **Variations** | Code, project, reason, amount, date, status (pending / approved / settled / rejected) — the ledger for variations, site instructions and claims |
| **Cost calculator** | Five sections: ① build-up of a comprehensive unit price from labour/material/machine/overhead%/profit%/statutory fee/tax%; ② total cost (work items + measures + other + fees + tax, tax defaults to 9%); ③ rebar theoretical weight (diameter in mm → kg/m, comma-separated batch, `w = d² × 0.00617`); ④ cost per m² and steel content per m²; ⑤ unit conversions (m³↔L, t↔kg, MPa↔N/mm², 万元↔元, m²↔亩) |
| **Glossary** | Chinese, English, domain, tags, note — five columns, CRUD lands immediately, whole table can be inserted into the chat |
| **Meetings** | Record in the browser (16k/16bit/mono WAV), transcribe while recording, pause/resume, annotate, highlight, play back; audio and transcripts go to `会议记录/` |
| **Prompt templates** | Templates from `prompts.json`, inserted into the composer (never sent). Ships with 7 cost templates: tender review, bid document outline, variation order, claim and delay analysis, inquiry/clarification letter, settlement review checklist, BOQ pricing note — plus a whole-glossary insert |

Above the cards:

- **Global search** across the library, all three tables, the glossary, and meeting transcripts and annotations; results are labelled by source.
- **Usage badge**: DeepSeek balance and remaining speech hours. Hidden until you supply your own
  credentials; everything else works without it.

## Cost mode / Lite mode

A segmented **造价 / 普通** (cost / lite) button sits at the right of the toolbar.

- **Cost** (default): all eight cards.
- **Lite**: only the global search box; every card is hidden.

The choice is stored in the browser's `localStorage` under `dsh-cost-workbench.mode`
(`cost` / `lite`). It is never written into the vault and never uploaded. There is no shortcut for
the switch — click the button.

## Inserting prompts

It writes to the composer and never sends. If there is already a draft, it asks first:
**append / replace / cancel**, defaulting to leaving your text alone.

## Library and Obsidian

- Notes under `00 资料库/` are the whole content of the Library card; the workbench is just a view.
- Save in Obsidian, switch back in the workbench, and you see the new content (it re-reads on open,
  search and focus).
- Edits made here are written back to the same file, so Obsidian sees them immediately.
- To avoid clobbering: a save compares against the version you read. If the file changed elsewhere,
  it refuses to write and offers **reload** or **overwrite anyway**. A backup is kept before each save.

## Project = the current session workspace

The workbench reads the workspace bound to the current DSH session and treats it as the
**current project**; there is nothing to pick manually:

- Library = the workspace itself (markdown notes in the project folder)
- Variations / material prices / pricing basis → `<workspace>\造价工作台\`
- Meeting recordings → `<workspace>\会议记录\`
- Glossary and prompt templates → the “public library” configured in Settings (shared by projects)

The panel toolbar shows the current project name (the workspace folder name). Switching
session/workspace in DSH switches the workbench automatically.

Usage: add a project folder as a DSH workspace, e.g.
`E:\文档\learbox的工作空间\2018年工作文件\华远售楼处`, then open the workbench in a session of
that workspace — data is written into that project folder, next to the BOQ and tender files.

The first time a project is recognised, `造价工作台\`, `会议记录\` and the three empty tables are
**created automatically**; existing files are never overwritten (if the folder is not writable it
falls back to creating them on the first write).

## Where things live

```
D:\Obsidian\造价工作台\          the Obsidian vault (single source of truth)
  00 资料库\
    01 计价依据\
    02 招投标流程\
    03 合同与索赔\
    04 常用模板\
  会议记录\                            recordings and transcripts
  Workbench\术语表.md                  glossary
  Workbench\计价依据.md                pricing basis
  Workbench\材料价格.md                material prices
  Workbench\变更签证台账.md            variation ledger
  Workbench\.backups\                  automatic backups (before every write)

C:\Users\<you>\.dsh-workbench\cards.json      card list (created on first run)
C:\Users\<you>\.dsh-workbench\prompts.json    prompt templates
C:\Users\<you>\.dsh-workbench\config.json     first-run config (vault path, folder names)
C:\Users\<you>\.dsh-workbench\asr.json        optional transcription credentials
```

Changing `cards.json` / `prompts.json` / the tables / the glossary / notes: **refresh the page**.
Changing plugin code: the client needs a refresh; the host half and `cordis.patch.yml` need an app
restart.

## Uninstall

Disable or remove the plugin from Settings → Plugins, or run:

```powershell
& "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-cost-workbench
```

Uninstalling **does not delete** your vault, `cards.json`, `prompts.json`, the tables, the glossary or
your recordings.

## Known limitations on Windows

- **"Open in Obsidian" uses the `obsidian://` protocol** and needs Obsidian installed and registered.
  Without it the button reports the problem instead of crashing.
- **The shortcut is `Alt+W`** (not macOS's `⌥W`). The host or an IME may claim `Alt+W`; use the icon then.
- **Microphone access** is controlled by Windows: Settings → Privacy & security → Microphone → allow
  desktop apps before recording for the first time.
- **Images in notes are not rendered**; they appear as a filename label. Text content (headings,
  lists, bold, code, wikilinks) is shown normally.
- Markdown support is deliberately minimal: no HTML, no embedded PDFs, no mermaid.
- Annotations anchor to the **first line** of a multi-line selection; the highlight colour is fixed.
- Transcribing an imported audio file shows no progress bar.
- **Chinese characters and spaces in paths are fine**, but use absolute paths in the config.
- **The panel opens but stays empty**: click the **refresh** button at the top right of the panel.
- The workbench reads and writes the vault directly: Obsidian edits appear after a refresh, workbench
  edits appear in Obsidian immediately (same files).

## Rollback

- **Disable the plugin**: Settings → Plugins → disable, or the `plugin remove` command above, then
  restart the app. Your vault and config files stay.
- **Roll back to the pre-fork version**: fetch `dsh-legal-workbench` v1.1.1 from upstream and point
  `plugin add` at that source folder. The old and new vault layouts differ, so re-point the vault path
  in the first-run screen afterwards.
- **Roll back a single file**: `Workbench\.backups\` holds the pre-write copy of every file; Obsidian's
  file recovery snapshots are a second option.

## Troubleshooting

- **Clicking the icon does nothing**: some sessions have no right sidebar yet, so the workbench opens
  as an overlay (`Alt+W`). If that still fails, restart the app.
- **It asks you to configure something**: it only needs the vault path; fill it in once.
- **No cards after installing**: make sure the app was **fully quit** (including the tray) before
  restarting, and that `dsh plugin --profile desktop list` shows `dsh-cost-workbench`.
- **A table refuses to save**: a single field may not contain a pipe `|`, a newline or a tab (it would
  break the Markdown table); the UI tells you which column.

## License

MIT — see [LICENSE](./LICENSE).

This plugin is derived from [`dsh-legal-workbench`](https://github.com/gaog88666-boop/dsh-legal-workbench).
The original code and documentation are copyright their authors under the MIT license; this repository
reworks them for cost estimating on Windows. The upstream MIT license and copyright notice continue to
apply to the derived portions — see [LICENSE](./LICENSE).
