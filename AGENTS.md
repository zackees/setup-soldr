# Agent Notes

- After an important action feature or compatibility fix is merged, promote the floating `v0` tag only through the manual Update v0 tag workflow. Supply the full current `main` SHA and a successful FastLED/fbuild canary run ID whose logs prove `zackees/setup-soldr@<that SHA>` ran. The workflow repeats the exact-SHA contract, readiness, and local-action smoke; dry run is the default. Never move `v0` from contract success alone. Keep immutable release tags such as `v0.1.0` unchanged.
