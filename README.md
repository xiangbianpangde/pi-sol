# /sol

**Stay in [Pi](https://github.com/badlogic/pi-mono). Ask web ChatGPT GPT-5.6 Sol High. Do not open chatgpt.com yourself.**

`/sol` is a thin Pi extension over [pi-oracle](https://github.com/fitchmultz/pi-oracle). The local model only prepares the question and files. An isolated oracle worker owns the ChatGPT session, locks **Plus High** (`thinking_extended`), and brings the answer back.

中文：在 Pi 里问网页版 ChatGPT GPT-5.6 Sol High。本地模型不自己开浏览器；隔离 worker 管会话。Plus 最高档是 High，不是 Extra High / Pro。

---

## Why this exists

pi-oracle 0.7.20 was written against the old Instant / Thinking / Pro sheet. ChatGPT Plus now shows a composer **High** button and a **Power** slider.

The old worker treats `menu "High"` as a model-configuration sheet, then dies looking for a dropdown that is gone:

```text
Could not open effort dropdown for requested effort: Extended
Could not find model family control for instant
```

Driving `chatgpt.com` with Pi's `agent_browser` is worse: it collides with the oracle worker session. `/sol` blocks that on purpose.

This repo is the wrapper + the Plus High / Power-slider worker patch + automatic restore after `pi update npm:pi-oracle`.

## What you get

| Surface | Role |
|---|---|
| `/sol` | Ask Sol High. Default waits. `--bg` returns a job id. |
| `/sol-followup` | Continue an earlier ChatGPT thread. |
| `/sol-read` | Print the latest (or named) job. |
| `/sol-auth` | Copy ChatGPT cookies from local Chrome into the isolated seed. |
| `agent_browser` guard | Blocks chatgpt.com / chat.openai.com / auth.openai.com. |
| File staging | Explicit `--files` only. No whole-repo archive. Rejects `.exe` / oversize images. |
| Worker patches | Recognize High + Power. Wait if the picker has not hydrated. Do not click a missing effort dropdown. |
| Auto-restore | On Pi `session_start` and every `/sol`, re-apply the 0.7.20 vendor patch if `pi update` wiped it. Refuse to overwrite a newer pi-oracle. |

Live check on this machine: job `3c4db6be-dfa6-43ee-b0da-8c0fc4aa1a06`, preset `thinking_extended`, response `SOL_SMOKE_OK`.

## Install

Needs a working [Pi](https://github.com/badlogic/pi-mono) with `npm:pi-oracle` and ChatGPT Plus.

> **Chrome must be English, or `/sol-auth` fails.**
>
> 隔离 Chrome / 本机用来同步 cookie 的 Chrome **界面语言必须是 English**。中文界面会被 Cloudflare 卡在「请稍候…」，worker 拿不到 ChatGPT 登录态，`oracle_auth` / `/sol-auth` 会失败。
>
> `chrome://settings/languages` → move **English** to the top → relaunch Chrome → then `/sol-auth`.
>
> If Chrome already ran with a Chinese UI, quit it fully and auth again. Do not leave a Chinese-language profile for the isolated oracle seed to inherit.

```bash
git clone https://github.com/xiangbianpangde/pi-sol.git
cd pi-sol
./scripts/install.sh
```

The script copies:

- `extensions/sol.ts` → `~/.pi/agent/extensions/sol.ts`
- `extensions/lib/sol/` → `~/.pi/agent/extensions/lib/sol/`
- `skills/sol/` → `~/.pi/agent/skills/sol/`

Then `/reload` in Pi (or start a new session).

First use:

```text
/sol-auth
/sol ping
```

If Chrome has the cookie DB locked, quit Chrome once and run `/sol-auth` again.

If auth still fails with a challenge page or `about:blank`, the browser language is almost always the cause — see the English-UI warning above. A Chinese Chrome will not get a usable ChatGPT session.

## Usage

```text
/sol [--bg] [--follow <job-id>] [--files a.pdf,src/a.ts] <prompt>
/sol-followup <job-id> [--bg] [--files a,b] <prompt>
/sol-read [job-id]
/sol-auth
```

- Default is synchronous: wait for Sol, then show the saved answer.
- `--bg` submits and stops. Read later with `/sol-read`.
- `--files` is an explicit list (max 10). Project files stay in place; outsiders are copied to `.pi/sol-staging/<id>/`.
- Preset is always `thinking_extended` (GPT-5.6 Sol **High**). `/sol` will not silently fall back to Instant or Standard.

## How it is wired

```text
you ── /sol ──► Pi extension
                  │  stage files
                  │  restore worker patches if missing
                  │  block agent_browser → chatgpt.com
                  ▼
              local model
                  │  oracle_preflight / oracle_auth
                  │  oracle_submit  provider=chatgpt
                  │                 preset=thinking_extended
                  ▼
              pi-oracle worker  (isolated Chrome + seed cookies)
                  │  High already selected? skip reconfiguration
                  │  Power slider open on High? same
                  │  Instant/Medium? try Advanced → High, else fail
                  ▼
              /tmp/oracle-<id>/response.md
```

The human does not run patch scripts. The extension restores the 0.7.20 vendor worker before submit. If installed pi-oracle is no longer `0.7.20`, restore is refused so a newer worker is not overwritten.

## Design rules

1. `/sol` is a real tool path (`oracle_*`). A heading that says Sol without a job id is a fake.
2. Browser automation for ChatGPT stays inside the oracle worker.
3. Plus max is High. Extra High / Pro need a Pro plan; do not invent them.
4. Content-policy, login, and challenge failures are terminal.
5. Chrome UI must be English. Chinese UI → Cloudflare「请稍候…」→ no auth.
6. After `pi update npm:pi-oracle` on 0.7.20, the next `/sol` puts the patch back. No user step.

## Tests

```bash
npm test
```

30 tests: parse / stage / guard / High+Power snapshots / Instant-Medium must not skip / auto-restore after a simulated update / refuse to overwrite 0.8.0.

## Layout

```text
extensions/sol.ts              Pi slash commands + hooks
extensions/lib/sol/            parse, files, guard, jobs, prompts, patches
extensions/lib/sol/vendor/     patched pi-oracle 0.7.20 worker (MIT)
extensions/__tests__/          node:test suite
skills/sol/SKILL.md            in-Pi model procedure
scripts/install.sh             copy into ~/.pi/agent
```

## License

MIT. Vendor worker files are patched from [pi-oracle](https://github.com/fitchmultz/pi-oracle) (MIT, © Mitch Fultz). See [NOTICE](./NOTICE).
