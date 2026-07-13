# R6Checker Desktop (CLI → hardened .exe)

Key-authenticated, **HWID-locked** bulk checker. Checking runs on the server in
**BYO-proxy mode** (the user's own proxies). The client holds **no checking
logic, no proxies, and no secrets** — so even fully reverse-engineered it
exposes nothing. On top of that the build is heavily obfuscated with anti-debug.

## Features
- License key (emailed on purchase), **locked to one device** (HWID).
- Live **window title**: Valids · Invalids · VWI · CPS · progress.
- Neat per-account output: `email — VALID / INVALID / VWI` (green / red / magenta).
- **VWI capture** → `vwi.txt`, plus `results.txt` and `valid.txt`.
- In-run **[S] stop**, and a menu to **resume** unchecked accounts.

## Build to a hardened .exe (Windows, cmd prompt)

```cmd
cd cli
npm install                              :: installs obfuscator + pkg + rcedit (dev only)

:: 1) make an icon from your logo (one time)
npx png-to-ico ..\public\img\logo.png > icon.ico

:: 2) build: obfuscate -> package -> set icon
npm run build
```

Output: **`cli\dist\R6Checker.exe`** — a single standalone file (no Node needed
to run it), obfuscated, anti-debugged, with your logo icon. Ship just that.

> No icon? Run `npm run obfuscate && npm run package` to skip the icon step.
> Cross-building from Mac/Linux works (pkg downloads the Windows runtime).

## Security / anti-reverse-engineering
- **Nothing valuable in the client.** Proxies, the Ubisoft checking method, and
  all logic live on the server behind the key + HWID. The exe is just an HTTPS
  client — cracking it yields an empty shell.
- **HWID lock** — a key only works on the first PC that uses it. Owners reset it
  from the admin panel for legit device changes.
- **Obfuscation** (`build.js`): control-flow flattening, dead-code injection,
  RC4 string encryption, self-defending (breaks on beautify/tamper), and
  **debug protection** (freezes if a debugger / devtools is attached — blocks
  common RE tools). `pkg` then compiles to a V8 bytecode snapshot, so the JS
  source isn't sitting in the exe.
- **Honest note:** no client-side software is literally "uncrackable." This
  makes it impractical *and* pointless to crack.

## How customers use it
Put `accounts.txt` (email:password) and `proxies.txt` next to the exe, run it,
paste the key from their email. It checks and writes `results.txt`, `valid.txt`,
`vwi.txt`.

Server URL defaults to `https://r6checker.xyz` (override via `CHECKER_SERVER`
env or a `server.txt` file).

## Where keys come from
Customer signs up + buys an access pass on the website → the server **emails the
key automatically**. Owners can also grant access (and trigger the email) from
the admin panel.
