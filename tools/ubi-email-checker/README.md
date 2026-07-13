# Ubisoft Email Checker

A standalone `.exe` that checks a list of emails (or `email:pass` lines) against
Ubisoft's account-existence endpoint and sorts them into dated `valid/` and
`invalid/` folders — preserving the password on valid lines.

## Run from source

```bash
cd tools/ubi-email-checker
npm install
npm start                 # interactive prompts
# or:
node checker.js path\to\list.txt
```

## Build the .exe

```bash
npm install
npm run build             # → dist/ubi-email-checker.exe  (Node 20+ required)
```

> **Why Node SEA instead of `pkg`?** `pkg` fetches prebuilt base binaries from a
> registry that's often unreachable and doesn't track modern Node. The SEA build
> (`npm run build`) uses your local Node, bundles every dependency into one file
> with esbuild, and emits the same kind of standalone `.exe` — no Node needed on
> the target machine. A `pkg` config is still in `package.json` if you prefer it:
> `npx pkg checker.js --targets node18-win-x64 --output dist/ubi-email-checker.exe`.

## Usage

Double-click the `.exe` (or run it from a terminal). It asks for:

1. **Credential list** — a `.txt` with one entry per line: `email` or `email:pass`.
   Only the part **before the first colon** is used as the email; the full line
   is preserved for valid hits.
2. **Concurrency** — simultaneous requests (default **15**).
3. **proxies.txt** — auto-detected if it sits next to the exe; otherwise prompted.

### Output

```
ubisoft_checker_2026-06-13_07-40-12/
├── valid/   valid_emails.txt     (original lines — email:pass kept)
├── invalid/ invalid_emails.txt   (emails only)
└── error_log.txt                 (timestamp ⇥ email ⇥ reason)
```

The window title updates live: `Valid: X | Invalid: Y | Done: N/Total (P%)`.

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `UBI_APPID` | `8627b3f1-…` | Ubi-AppId header. **The example AppId in the spec is a placeholder** — if you see lots of `401/403` in the log, override this with a known-good AppId. |
| `CONCURRENCY` | `15` | Simultaneous requests. |
| `BATCH_DELAY_MS` | `75` | Pause between batches (rate-limit cushion). |
| `MAX_RETRIES` | `3` | Retries per email (rotates proxy each try). |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout. |

```bash
set UBI_APPID=2c2d31af-4ee4-4049-85dc-00dc74aef88f
set CONCURRENCY=30
ubi-email-checker.exe list.txt
```

## How results are classified

| HTTP | Meaning | Bucket |
|---|---|---|
| 200 (+ exists:true / record) | account exists | **valid** |
| 200 (exists:false) / 204 / 404 | no account | invalid |
| 400 | malformed email | invalid (logged) |
| 401 / 403 / 429 / 5xx | rate-limit / anti-bot / transient | **retry** on fresh proxy |

After `MAX_RETRIES`, an email that still errors is logged to `error_log.txt`
**and** written to `invalid/` — the queue never silently drops a line.

## Notes

- **Memory**: the input file is *streamed* (line-by-line), so 10M-line lists work
  without loading the file into RAM. Output is buffered append-writes.
- The Ubisoft email-exists API and AppIds change over time. If hit rates look
  wrong, confirm the endpoint/AppId still behave as the spec describes and adjust
  `UBI_APPID` / the status mapping in `checker.js` (`checkEmail`).
