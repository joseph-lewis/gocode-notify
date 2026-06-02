# gocode-notify — Ralph/Homer loop opt-in snippet  (PRD §5.6, trigger C)
#
# OPT-IN. This snippet is NOT auto-injected by `gocode-notify setup`; the
# installer never edits your loop scripts without consent. Paste these two
# lines into the completion/halt path of any loop you control (this repo's
# `ralph`/`homer` skills, Geoffrey Huntley's `while :; do … done` one-liner,
# or your own driver) to get a phone push when the loop finishes or halts.
#
# Prereq: you've already paired this machine once with
#   npx @trygocode/notify@latest login --code <CODE>
# (get <CODE> from the GoCode app → "Connect a coding agent").
#
# Both lines are fire-and-forget: the `|| true` guarantees a failed/slow push
# can never block or fail your loop (the CLI also self-times-out in 5s).

# --- At loop completion (the loop finished all work cleanly) -----------------
gocode-notify send --kind loop_completed --source ralph --project "$(basename "$PWD")" || true

# --- At loop halt (paused_max_failures / awaiting_human / question raised) ---
gocode-notify send --kind loop_halted --source ralph --project "$(basename "$PWD")" \
  --title "Ralph halted — needs you" || true
