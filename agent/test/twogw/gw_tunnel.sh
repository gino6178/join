#!/usr/bin/env bash
# The two gateways' tunnel (docs/a2a_two_gateways.md): one supervised SSH connection from the GPU server to the cloud
# VM serve-api-a100b, the way api_vm/tunnel.sh reaches its Ollama, carrying
#   -L 127.0.0.1:23890 -> the VM's 127.0.0.1:23890   gateway A (this server) reaches gateway B
#   -R the VM's 127.0.0.1:23790 -> 127.0.0.1:23790   gateway B reaches gateway A back (the A2A port of A's test gateway)
# No port is open to the internet: both ends listen on localhost only, and the VM's sshd lets the tunnel user forward to
# Ollama and gateway B and listen on that one port, nothing else (/etc/ssh/sshd_config.d/60-serve-tunnel.conf there).
#   setsid -f ~/shuttlecoach-meta/twogw/gw_tunnel.sh run > /dev/null 2>&1 < /dev/null    start the restart loop
#   ~/shuttlecoach-meta/twogw/gw_tunnel.sh status | stop | kick
# Key ~/.ssh/serve_api_vm, host key pinned in ~/.ssh/serve_api_vm_known_hosts (alias serve-api-a100b), the VM's
# address read from ~/shuttlecoach-meta/api_vm/vm_ip_b before every connect (start.sh rewrites it). While the VM is
# stopped it retries once a minute, so a new address is picked up within a minute (kick: at once).
KEY=$HOME/.ssh/serve_api_vm KH=$HOME/.ssh/serve_api_vm_known_hosts VMUSER=serve-tunnel VM=serve-api-a100b
IPF=$HOME/shuttlecoach-meta/api_vm/vm_ip_b B_PORT=${B_PORT:-23890} A_PORT=${A_PORT:-23790}
LOG=/tmp/serve_twogw_tunnel.log PIDF=/tmp/serve_twogw_tunnel.pid SSHPIDF=/tmp/serve_twogw_tunnel_ssh.pid
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
# is the PID in $1 ours and running $2 (through /proc, never by matching every process's command line)
ours() { local p; p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "$2" && echo "$p"; }
case "${1:-}" in
  status)
    if p=$(ours "$PIDF" gw_tunnel.sh); then echo "two-gateway tunnel loop running (pid $p), VM address $(cat "$IPF" 2>/dev/null)"; else echo "two-gateway tunnel loop not running"; fi
    if curl -s -m 5 "127.0.0.1:$B_PORT/a2a/keys.json" > /dev/null; then echo "gateway B up: http://127.0.0.1:$B_PORT"; else echo "gateway B not reachable (VM or its service stopped, or the tunnel reconnecting); log: $LOG"; fi
    exit 0 ;;
  stop) if p=$(ours "$PIDF" gw_tunnel.sh); then kill "$p"; echo "stopped (pid $p)"; else echo "not running"; fi; exit 0 ;;
  kick) if p=$(ours "$PIDF" gw_tunnel.sh); then kill -USR1 "$p"; echo "told to reconnect (pid $p)"; else echo "not running"; exit 1; fi; exit 0 ;;
  run) ;;
  *) echo "usage: $0 run|status|stop|kick"; exit 2 ;;
esac
if p=$(ours "$PIDF" gw_tunnel.sh); then echo "already running (pid $p)"; exit 0; fi
echo $$ > "$PIDF"
cleanup() { kill $(jobs -p) 2>/dev/null; rm -f "$PIDF" "$SSHPIDF"; log "tunnel loop stopped"; exit 0; }
trap cleanup TERM INT HUP
SLP=""
trap 'delay=5; [ -n "$SLP" ] && kill "$SLP" 2>/dev/null' USR1
log "tunnel loop started (pid $$): -L $B_PORT, -R $A_PORT"
delay=5
while :; do
  ip=$(tr -d ' \r\n' < "$IPF" 2>/dev/null)
  if [ -z "$ip" ]; then log "no VM address in $IPF"; sleep 60 & SLP=$!; wait "$SLP"; SLP=""; continue; fi
  log "connecting to $ip"
  t0=$(date +%s)
  # (ServerAlive 10 s x 3: a preempted VM drops the forwards in about 30 s; peer.js gives up a request sooner, on probes)
  ssh -N -L 127.0.0.1:$B_PORT:127.0.0.1:$B_PORT -R 127.0.0.1:$A_PORT:127.0.0.1:$A_PORT "$VMUSER@$ip" -i "$KEY" \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o BatchMode=yes -o IdentitiesOnly=yes \
    -o HostKeyAlias=$VM -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=yes < /dev/null >> "$LOG" 2>&1 &
  sp=$!; echo "$sp" > "$SSHPIDF"
  wait "$sp"; rc=$?
  while kill -0 "$sp" 2>/dev/null; do wait "$sp"; rc=$?; done
  log "ssh exited with status $rc"
  if [ $(( $(date +%s) - t0 )) -gt 60 ]; then delay=5; else delay=$(( delay * 2 > 60 ? 60 : delay * 2 )); fi
  sleep "$delay" & SLP=$!; wait "$SLP"; SLP=""
done
