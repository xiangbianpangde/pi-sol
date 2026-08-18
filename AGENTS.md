# /sol for coding agents

You are installing or operating the Pi `/sol` extension.

- User-facing commands: `/sol`, `/sol-followup`, `/sol-read`, `/sol-auth`.
- Browser work for ChatGPT stays in pi-oracle. Never open chatgpt.com with `agent_browser`.
- Preset is `thinking_extended` (GPT-5.6 Sol High on ChatGPT Plus). Do not fall back to Instant or Standard.
- Worker High/Power-slider patches restore themselves on `session_start` and before `/sol`. Do not ask the human to run apply scripts.
- If a job fails with `effort dropdown` or `model family control` on pi-oracle 0.7.20, run `node extensions/lib/sol/apply-sol-patches.mjs --restore` yourself, then retry the same High submit once.
- If installed pi-oracle is not 0.7.20, do not overwrite it with vendor files. Report the version mismatch.
- Chrome UI must be English. Chinese UI gets stuck on Cloudflare「请稍候…」and `/sol-auth` cannot import a session.
- Never ship `oracle-auth-seed-profile`, cookies, or Chrome user-data.

Install: `./scripts/install.sh` then `/reload` in Pi.
