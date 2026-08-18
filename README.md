# pi-sol — `/sol` for ChatGPT GPT-5.6 Sol High inside Pi

**Ask ChatGPT web GPT-5.6 Sol High without leaving your Pi coding-agent session.**

`pi-sol` is a thin Pi extension over [pi-oracle](https://github.com/fitchmultz/pi-oracle). Pi prepares the question and any files you explicitly select; an isolated pi-oracle browser worker owns the ChatGPT session and returns the answer to Pi.

The preset is fixed to ChatGPT Plus **High** (`thinking_extended`). `/sol` does not silently fall back to Instant or Standard.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js >=22](https://img.shields.io/badge/node.js-%3E%3D22-339933)
![ChatGPT Plus High](https://img.shields.io/badge/ChatGPT-Plus%20High-10a37f)

**English** | [简体中文](./README.zh-CN.md)

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Why pi-sol?](#why-pi-sol)
- [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility)
- [How it works](#how-it-works)
- [Behavior guarantees](#behavior-guarantees)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

Before installing, make sure you have:

- A working [Pi](https://github.com/badlogic/pi-mono) installation
- `npm:pi-oracle` installed
- A ChatGPT **Plus** account signed in through local Chrome
- Node.js **22 or newer**
- Chrome's interface language set to **English** before running `/sol-auth`

> [!IMPORTANT]
> **Chrome must use an English UI for ChatGPT authentication.**
>
> With a Chinese Chrome UI, the isolated browser can become stuck on Cloudflare「请稍候…」 or `about:blank`, leaving `/sol-auth` without a usable ChatGPT session.
>
> Open `chrome://settings/languages`, move **English** to the top, fully quit and relaunch Chrome, then run `/sol-auth` again.

> [!IMPORTANT]
> The vendored worker restore is version-gated; see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility) for the exact marker check, restore rule, and version-mismatch behavior.

---

## Quick start

### 1. Install

```bash
git clone https://github.com/xiangbianpangde/pi-sol.git
cd pi-sol
./scripts/install.sh
```

The installer copies the extension, the skill, and the vendored patch files into your Pi configuration (`~/.pi/agent/`); any restore into the installed `pi-oracle` worker happens later at runtime under the [compatibility rule](#pi-oracle-0720-compatibility) below.

### 2. Reload Pi

In Pi:

```text
/reload
```

Or start a new Pi session.

### 3. Authenticate ChatGPT

```text
/sol-auth
```

This copies ChatGPT login cookies from your local Chrome profile into pi-oracle's isolated browser seed.

> [!WARNING]
> `/sol-auth` handles your ChatGPT session cookies. **Never commit, publish, paste into an issue, or otherwise share** ChatGPT cookies, Chrome profile data, or `oracle-auth-seed-profile` files.

### 4. Run the smoke test

First verify a synchronous request:

```text
/sol ping
```

Then verify the background-job path:

```text
/sol --bg ping
```

Copy the returned job ID and read it:

```text
/sol-read <job-id>
```

A working setup completes the synchronous request **and** makes the background job readable without silently dropping to Instant or Standard.

<!-- Screenshot placeholder — add this file before uncommenting the image line:
![Successful pi-sol smoke test in Pi](./docs/screenshots/smoke-test.png)
Capture `/sol ping`, `/sol --bg ping`, the returned job ID, and `/sol-read <job-id>`. Crop out account identifiers, ChatGPT conversation URLs, cookies, private prompts, and unrelated terminal history.
-->

After the smoke test, try a real question:

```text
/sol Review this architecture decision and identify the three highest-risk assumptions.
```

---

## Commands

| Command | What it does |
|---|---|
| `/sol [--bg] [--follow <job-id>] [--files a,b] <prompt>` | Ask ChatGPT GPT-5.6 Sol High. Waits for the answer by default. |
| `/sol-followup <job-id> [--bg] [--files a,b] <prompt>` | Continue an earlier `/sol` ChatGPT thread. |
| `/sol-read [job-id]` | Read a saved job. With no ID, it falls back to an `oracle-*` job discovered in the configured jobs directory; pass the returned `/sol` job ID when you need an unambiguous result. |
| `/sol-auth` | Sync ChatGPT cookies from local Chrome into pi-oracle's isolated browser seed. |

> `/sol --follow <job-id> <prompt>` and `/sol-followup <job-id> <prompt>` **both continue an existing `/sol` ChatGPT thread**. Use whichever form is more convenient; `/sol-followup` is the dedicated command form.

### Common options

- **Default:** synchronous — wait for Sol and return the answer in Pi.
- **`--bg`:** submit in the background and return a job ID; read it later with `/sol-read`. Background results are pi-oracle jobs. They live under `$PI_ORACLE_JOBS_DIR` when that variable is configured, otherwise under `/tmp/oracle-<id>/`; `/sol-read` is the normal way to read them from Pi.
- **`--files a,b`:** send only the explicitly listed files. Whole repositories are never auto-archived. Files you select that live outside the current project are copied to `.pi/sol-staging/<id>/` so `pi-oracle` can receive a project-relative path.
- **`--follow <job-id>`:** continue an existing ChatGPT thread from `/sol`. See the alias note above.

The model preset is always `thinking_extended`, which `pi-sol` uses for GPT-5.6 Sol **High** on ChatGPT Plus. It does not silently downgrade to Instant or Standard. See [SKILL.md](./skills/sol/SKILL.md) for the full in-Pi operating procedure.

---

## Why pi-sol?

`pi-sol` gives Pi one controlled path to ChatGPT web:

- Stay inside the Pi workflow instead of manually switching to ChatGPT.
- Let Pi prepare the question and explicitly selected local files.
- Use synchronous or background `/sol` jobs.
- Continue an earlier ChatGPT thread with `/sol-followup`.
- Keep ChatGPT browser automation inside pi-oracle's isolated worker.
- Auto-restore the supported High / Power-slider compatibility patch when needed.

### Why use pi-sol on top of `pi-oracle`?

`pi-oracle` provides the underlying ChatGPT browser worker. `pi-sol` adds the Pi-facing contract around it: `/sol` and `/sol-followup` slash commands, the fixed `thinking_extended` / Plus **High** preset (no silent fallback), explicit local-file staging, the ChatGPT `agent_browser` guard, and version-gated worker restoration. See [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility) for the exact restore boundary. If you only want raw ChatGPT automation, use `pi-oracle` directly. If you want a single `/sol` command that always lands on Plus High, install `pi-sol`.

### pi-sol vs opening chatgpt.com

| | `pi-sol` | Open ChatGPT manually |
|---|---|---|
| Stay inside Pi | Yes | No |
| Pi prepares the request | Yes | Manual |
| Explicit local file staging | `--files` | Manual upload |
| Background Pi job | `--bg` + `/sol-read` | No Pi-managed job |
| Follow an earlier `/sol` thread | `/sol-followup` | Separate browser workflow |
| ChatGPT browser ownership | Isolated pi-oracle worker | Your normal browser |
| pi-oracle High compatibility handling | Automatic where supported | Not applicable |

---

## pi-oracle 0.7.20 compatibility

`pi-sol` vendors a High / Power-slider compatibility patch derived from **pi-oracle 0.7.20**. The unpatched 0.7.20 worker can fail against the compact / Power model-selection UI with errors such as:

```text
Could not open effort dropdown for requested effort: Extended
Could not find model family control for instant
```

The restore rule is deliberately narrow:

1. On `session_start` and every `before_agent_start`, `pi-sol` checks the installed worker for the required High / Power-slider patch markers.
2. If all required markers are already present, no vendor copy is needed.
3. If markers are missing, `pi-sol` restores the vendored worker files only when the installed `pi-oracle` version exactly matches the vendored version, **0.7.20**.
4. If the installed version is different or unreadable, `pi-sol` refuses to overwrite the worker; do not force-copy the 0.7.20 vendor files over it.
5. `pi update npm:pi-oracle` may replace patched worker files; when restoration is allowed, the next automatic check restores them.
6. If a supported High submit still hits the old effort-dropdown or model-family-control error, the in-Pi agent may run the restore once and retry the same `thinking_extended` submit once; the user should not be asked to run patch scripts, and `/sol` must not downgrade to Instant or Standard.

This is the compatibility boundary for the vendored restore mechanism; it is not a claim that every other `pi-oracle` version is supported or unsupported.

---

## How it works

```mermaid
flowchart LR
    subgraph Pi["Pi coding agent"]
        U["Pi user<br/>/sol"] --> E["pi-sol extension<br/>parse + stage + guard"]
        E --> SK["sol skill"]
        SK -->|"oracle_preflight / auth / submit / read"| RT["pi-oracle runtime"]
    end
    subgraph Oracle["pi-oracle (separate npm package)"]
        RT --> PCH["ensureSolOraclePatches()<br/>version-gated restore"]
        RT --> W["isolated Chrome worker"]
    end
    W --> C["ChatGPT web<br/>GPT-5.6 Sol High"]
    C --> W
    W --> RT
    RT --> SK
    SK --> U
    B["agent_browser"] -. "ChatGPT URLs blocked" .-> E
```

`pi-sol` does not create a second ChatGPT browser session. The extension parses commands, stages explicitly selected files, injects the relay instructions, and blocks ChatGPT URLs in `agent_browser`; the in-Pi `sol` skill drives `oracle_preflight`, `oracle_auth`, `oracle_submit`, and `oracle_read`, while `pi-oracle` owns the isolated Chrome session.

For the exact worker-patch decision, see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility).

### Background-job lifecycle

```mermaid
flowchart LR
    BG["/sol --bg &lt;prompt&gt;"] --> S["oracle_submit"]
    S --> J["return job ID"]
    S --> W["pi-oracle worker"]
    W --> D["job directory<br/>$PI_ORACLE_JOBS_DIR/oracle-&lt;id&gt;/ or /tmp/oracle-&lt;id&gt;/"]
    J --> R["/sol-read &lt;job-id&gt;<br/>local read"]
    D --> R
    R --> O["status + saved response"]
```

Synchronous `/sol` reuses the same `oracle_submit` + `oracle_read` flow but blocks in Pi until the response is ready.

The detailed hydration rules and decision logic live in [SKILL.md](./skills/sol/SKILL.md) and the test suite.

---

## Behavior guarantees

### Model selection

- `/sol` targets GPT-5.6 Sol **High** on ChatGPT Plus.
- The internal preset name is `thinking_extended`.
- `pi-sol` does not silently fall back to Instant or Standard.
- Extra High / Pro is not treated as the Plus High preset.

### Browser ownership

ChatGPT browser automation belongs exclusively to pi-oracle's isolated worker. For that reason, `pi-sol` blocks `agent_browser` from opening:

- `chatgpt.com`
- `www.chatgpt.com`
- `chat.openai.com`
- `chatgpt.openai.com`
- `auth.openai.com`

This prevents two browser-automation paths from competing for the ChatGPT session. Use `/sol` for ChatGPT instead.

### Files and local staging

User-selected local files are **strictly opt-in**: they are included only when you pass `--files`. `pi-sol` does not archive or upload the whole repository automatically.

```text
/sol --files paper.pdf,src/example.ts <prompt>
```

Internally, `/sol` may stage a generated `request.md` containing the request. If you explicitly select a file **outside the current project**, it is copied to `.pi/sol-staging/<id>/` so `pi-oracle` can receive a project-relative path. Files inside the current project are referenced in place and are not copied.

**Local pre-submit checks:**

- Maximum **10 files** per turn
- Images: **20 MiB**
- Spreadsheets: **50 MiB**
- Known text / document extensions and extensionless files: **20 MiB** local byte cap, used as a rough proxy for ChatGPT's approximately **2M-token** document limit
- Other non-blocked extensions: **512 MiB** hard cap
- **Rejected locally:** known executables and installers (`.exe`, `.dmg`, `.apk`, …)

These checks prevent known-invalid payloads from being submitted, but they are not a complete mirror of ChatGPT web validation; ChatGPT may still reject an unsupported file type or apply additional service-side token, rate, storage, login, challenge, or policy limits.

### Authentication and policy failures

Login, challenge, and content-policy failures are treated as **terminal** conditions. `pi-sol` does not bypass them or silently switch to another model.

### pi-oracle updates

For update-time restore behavior, version gating, and the marker-first exception, see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility); users should not run the worker restore script manually.

For coding-agent invariants, see [AGENTS.md](./AGENTS.md).
For patch-development rules, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Troubleshooting

### `/sol-auth` is stuck on「请稍候…」 or `about:blank`

Check Chrome's interface language first.

1. Open `chrome://settings/languages`.
2. Move **English** to the top.
3. Fully quit Chrome.
4. Relaunch Chrome.
5. Run:

```text
/sol-auth
```

A Chinese Chrome UI can prevent the isolated oracle browser from obtaining a usable ChatGPT session.

### `/sol-auth` says the Chrome cookie database is locked

Fully quit Chrome once, then retry:

```text
/sol-auth
```

The browser can temporarily lock the cookie database while it is running.

### I get `Could not open effort dropdown for requested effort: Extended`

You may also see:

```text
Could not find model family control for instant
```

Reload Pi (or start a new session) and retry the same `/sol` request; if the error persists, see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility) for the exact restore and version-mismatch rule, and do not work around it by switching to Instant or Standard.

### pi-sol reports a pi-oracle version mismatch

A version mismatch matters when patch markers are missing and restoration is required; see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility) for the exact rule, and do not force-copy the vendored worker over a different installed version.

### `/sol` says High is unavailable

`/sol` is intentionally fixed to Plus High. Check that:

- You are authenticated to the intended ChatGPT Plus account (`/sol-auth` succeeds).
- The ChatGPT session itself exposes High.

`pi-sol` will not silently substitute Instant or Standard.

### `agent_browser` refuses to open chatgpt.com

This is expected behavior. ChatGPT browser automation is reserved for pi-oracle's isolated worker so two browser sessions do not compete. Use:

```text
/sol <question>
```

instead.

### A file is rejected before `/sol` submits

`--files` applies local count, byte-size, and known executable/installer checks before submission; see [Files and local staging](#files-and-local-staging) for the exact local checks, then remove or reduce the rejected input and retry.

### `/sol-read` says no jobs were found

Run a `/sol` request first:

```text
/sol --bg <question>
```

Then read the returned job:

```text
/sol-read <job-id>
```

With no job ID, `/sol-read` falls back to an `oracle-*` job discovered in the configured jobs directory and is not scoped only to `/sol`, so use the returned job ID when other pi-oracle jobs may exist.

---

## FAQ

### What is "Sol High"?

In this project, **Sol High** means ChatGPT web GPT-5.6 using the ChatGPT Plus **High** reasoning setting. `pi-sol` refers to that preset internally as `thinking_extended`. It is not the same thing as Extra High or Pro.

### What is `thinking_extended`?

`thinking_extended` is the pi-oracle preset name used by `/sol` for the ChatGPT Plus High setting. It is an implementation-level name. As a user, you normally only need to run:

```text
/sol <question>
```

### Does `/sol` ever fall back to Instant or Standard?

No. If the requested High configuration cannot be established, `pi-sol` treats that as an error rather than silently returning an answer from a lower setting.

### Why does Chrome have to be in English?

`/sol-auth` imports your existing ChatGPT login into pi-oracle's isolated browser environment. With an affected Chinese Chrome UI, the authentication flow can become stuck on Cloudflare「请稍候…」 or `about:blank`. Set English first in `chrome://settings/languages`, then fully relaunch Chrome and run `/sol-auth` again.

### Why not just open chatgpt.com with `agent_browser`?

pi-oracle already owns an isolated browser session for ChatGPT. Opening ChatGPT through Pi's general `agent_browser` creates a second automation path that can collide with the oracle worker session. `pi-sol` therefore blocks ChatGPT URLs in `agent_browser` intentionally. Use `/sol` for ChatGPT instead.

### Is my prompt or file data sent to OpenAI?

Yes. `/sol` submits your question to ChatGPT web, so the prompt is sent to ChatGPT / OpenAI as part of that request. Files are sent **only** when you explicitly list them with `--files`; `pi-sol` does not automatically archive or upload the whole repository. `/sol-auth` copies your local ChatGPT session cookies into pi-oracle's isolated browser seed — do not commit, publish, or share those cookies or browser-profile data.

### What happens after `pi update npm:pi-oracle`?

An update can replace pi-oracle's installed worker; see [pi-oracle 0.7.20 compatibility](#pi-oracle-0720-compatibility) for the exact marker check, restore boundary, and version-mismatch behavior.

---

## Development

### Tests

```bash
npm test
```

The test suite covers:

- `/sol` command parsing
- Explicit file staging and validation (`--files` limits, executable rejection)
- The `agent_browser` ChatGPT-domain guard
- High / Power-slider UI handling
- Preventing Instant or Medium from being accepted as High
- Automatic patch restoration after a simulated `pi-oracle` update
- Refusing to overwrite an unsupported or newer `pi-oracle` version

### Project layout

```text
README.md                    English README (this file)
README.zh-CN.md              Simplified Chinese README
extensions/sol.ts              Pi slash commands + hooks
extensions/lib/sol/            parse, files, guard, jobs, prompts, patches
extensions/lib/sol/vendor/     patched pi-oracle 0.7.20 worker (MIT)
extensions/__tests__/          node:test suite
skills/sol/SKILL.md            in-Pi model procedure
scripts/install.sh             copy into ~/.pi/agent
```

Screenshots referenced from this README live under `docs/screenshots/`.

---

## Contributing

Bug reports and pull requests are welcome.

Before changing `/sol` behavior or the bundled worker patch, read:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — patch and test requirements
- [`AGENTS.md`](./AGENTS.md) — coding-agent invariants
- [`skills/sol/SKILL.md`](./skills/sol/SKILL.md) — in-Pi oracle procedure

When reporting a problem, include:

- Pi version
- `pi-oracle` version
- Operating system
- The exact `/sol` command or error message
- Whether `/sol-auth` succeeds

**Never attach ChatGPT cookies, Chrome profiles, or `oracle-auth-seed-profile` data to an issue.**

Project: [github.com/xiangbianpangde/pi-sol](https://github.com/xiangbianpangde/pi-sol)

---

## License

MIT. Vendor worker files are patched from [pi-oracle](https://github.com/fitchmultz/pi-oracle) (MIT, © Mitch Fultz). See [NOTICE](./NOTICE).