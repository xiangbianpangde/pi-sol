# Contributing

1. Keep `/sol` a relay. Do not add a second ChatGPT browser path.
2. Plus High is `thinking_extended`. Tests must fail if Instant/Medium can skip as High.
3. After changing the worker, copy the live files into `extensions/lib/sol/vendor/` and keep `ORACLE_VERSION` in sync with `pi-oracle/package.json`.
4. `npm test` must pass. Do not commit cookies, Chrome profiles, or `oracle-auth-seed-profile`.
