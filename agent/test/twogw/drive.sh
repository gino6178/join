#!/usr/bin/env bash
# Runs the two-gateway eval (test/a2a_two_gateways.mjs) on the GPU server and acts on its MARK lines from the PC, where
# the VM's admin key is (docs/a2a_two_gateways.md):
#   FREEZE_B / THAW_B   SIGSTOP / SIGCONT gateway B's process: a peer that stops answering in the middle of a request
#   STOP_B / START_B    systemctl stop / start gateway B's service (never the VM)
#   bash agent/test/twogw/drive.sh [N=12]
# Gateway B is always left running and thawed at the end, whatever happened.
set -u
SERVER=gino@192.168.31.145 LOG=/tmp/serve_twogw_eval.log
VMIP=$(ssh -n -o BatchMode=yes "$SERVER" cat shuttlecoach-meta/api_vm/vm_ip_b | tr -d ' \r\n')
vm() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 -o HostKeyAlias=serve-api-a100b -o UserKnownHostsFile=~/.ssh/serve_api_vm_known_hosts -o StrictHostKeyChecking=yes -i ~/.ssh/google_compute_engine "gino@$VMIP" "$@"; }
restore() { vm "sudo systemctl kill -s SIGCONT serve-gateway-b.service 2>/dev/null; sudo systemctl start serve-gateway-b.service"; }
trap restore EXIT
ENVS="LLM_URL=${LLM_URL:-http://127.0.0.1:11445/v1} LLM_SLOTS=${LLM_SLOTS:-8} EMBED_URL=${EMBED_URL:-http://127.0.0.1:11445}"
# FRESH=1: gateway B's talks, holds and games from earlier runs are moved aside first (its key and pins stay)
if [ "${FRESH:-0}" = 1 ]; then
  vm "sudo systemctl stop serve-gateway-b.service; T=/opt/serve-gwb/agent/data.old-\$(date +%s); sudo mkdir -p \$T; sudo find /opt/serve-gwb/agent/data -mindepth 1 -maxdepth 1 ! -name card-key.pem ! -name peer_pins.json -exec mv -t \$T {} +; sudo systemctl start serve-gateway-b.service"
  sleep 5; echo "$(date +%T) gateway B's earlier talks moved aside"
fi
ssh -n -o BatchMode=yes "$SERVER" "cd ~/shuttlecoach-meta/twogw/agent && rm -f $LOG && $ENVS setsid -f bash -c '~/shuttlecoach/node/bin/node test/a2a_two_gateways.mjs ${1:-12} > $LOG 2>&1; echo EXIT \$? >> $LOG' < /dev/null > /dev/null 2>&1"
echo "$(date +%T) eval started on the server, log $LOG"
seen=""
while :; do
  marks=$(ssh -n -o BatchMode=yes "$SERVER" "grep -E '^(MARK |DONE|EXIT )' $LOG 2>/dev/null")
  for m in FREEZE_B THAW_B STOP_B START_B; do
    if grep -q "^MARK $m" <<< "$marks" && [[ "$seen" != *" $m"* ]]; then
      seen="$seen $m"
      case $m in
        FREEZE_B) vm "sudo systemctl kill -s SIGSTOP serve-gateway-b.service" ;;
        THAW_B) vm "sudo systemctl kill -s SIGCONT serve-gateway-b.service" ;;
        STOP_B) vm "sudo systemctl stop serve-gateway-b.service" ;;
        START_B) vm "sudo systemctl start serve-gateway-b.service" ;;
      esac
      echo "$(date +%T) $m done on the VM"
    fi
  done
  grep -qE '^(DONE|EXIT )' <<< "$marks" && break
  sleep 2
done
ssh -n -o BatchMode=yes "$SERVER" "grep -vE '^\s*$' $LOG | tail -60"
