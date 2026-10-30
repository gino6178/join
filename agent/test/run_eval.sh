#!/usr/bin/env bash
# The Autopilot evaluation on the GPU server, detached; its rows go to /tmp/eval.log as each week finishes.
#   setsid -f ~/shuttlecoach-meta/agent/test/run_eval.sh
cd ~/shuttlecoach-meta/agent || exit 1
timeout 3600 ~/shuttlecoach/node/bin/node test/autopilot_eval.mjs data/autopilot_eval.json 2>&1 | grep --line-buffered -v "^\[gateway\]" > /tmp/eval.log
echo EVAL_DONE >> /tmp/eval.log
