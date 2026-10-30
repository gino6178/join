#!/usr/bin/env bash
# Deploy or update gateway B on the cloud VM serve-api-a100b (docs/a2a_two_gateways.md). Run on the PC, from Git Bash
# (the VM's admin key is there), in the repository:
#   bash agent/test/twogw/deploy_b.sh             the code, B's club, its config and its service (node and node_modules
#                                                  too, the first time)
#   bash agent/test/twogw/deploy_b.sh --runtime   copy node and node_modules again
# What goes to the VM: Serve's agent code, the demo venues, and a club of simulated members made here from a seed
# (club_b.mjs). Never agent/data/, never a real player's data. The VM makes its own key and token, which never leave it.
set -euo pipefail
SERVER=gino@192.168.31.145 D=/opt/serve-gwb
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
VMIP=$(ssh -n -o BatchMode=yes "$SERVER" cat shuttlecoach-meta/api_vm/vm_ip_b | tr -d ' \r\n')
# (the VM's host key pinned by name, as on the server: its address changes on every start. Copy the server's
# ~/.ssh/serve_api_vm_known_hosts lines for serve-api-a100b to the same file on the PC once.)
vm() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o HostKeyAlias=serve-api-a100b -o UserKnownHostsFile=~/.ssh/serve_api_vm_known_hosts -o StrictHostKeyChecking=yes -i ~/.ssh/google_compute_engine "gino@$VMIP" "$@"; }
echo "gateway B on serve-api-a100b ($VMIP)"

# 1. its own user, no login, and its folder
vm "id servegw > /dev/null 2>&1 || sudo useradd --system --home-dir $D --shell /usr/sbin/nologin servegw
    sudo mkdir -p $D/agent/data $D/node/bin $D/web/public/data $D/web/src && sudo chown -R servegw:servegw $D && sudo chmod 750 $D $D/agent/data"

# 2. node and node_modules: the server's own copies, the versions the server runs
if [ "${1:-}" = --runtime ] || ! vm "sudo test -x $D/node/bin/node"; then
  echo "copying node and node_modules from the server"
  ssh -n -o BatchMode=yes "$SERVER" 'cd ~/shuttlecoach/node && tar -czf - bin/node' | vm "sudo tar -xzf - -C $D/node && sudo chown -R servegw:servegw $D/node"
  ssh -n -o BatchMode=yes "$SERVER" 'cd ~/shuttlecoach-meta/agent && tar -czf - node_modules' | vm "sudo rm -rf $D/agent/node_modules && sudo tar -xzf - -C $D/agent && sudo chown -R servegw:servegw $D/agent/node_modules"
fi

# 3. the code: agent/src, its package.json, the files outside src/ it reads (the loop's policy,
#    and the web app's package.json the policy reads), the demo venues
(cd "$ROOT" && tar -czf - agent/src agent/package.json agent/test/policy.mjs web/package.json web/public/data/venues.json) \
  | vm "sudo rm -rf $D/agent/src && sudo tar -xzf - -C $D && sudo chown -R servegw:servegw $D/agent $D/web"

# 4. gateway B's club: ten simulated members of "Northside", from seed 31
TMP=$(mktemp -d)
node "$ROOT/agent/test/twogw/club_b.mjs" "$TMP" 10 31 > /dev/null
vm "sudo tee $D/web/public/data/club.json > /dev/null && sudo chown servegw:servegw $D/web/public/data/club.json" < "$TMP/club.json"
rm -rf "$TMP"

# 5. its settings, made once on the VM (the token is generated there and never printed), and its allow-list: gateway A,
#    reached through the tunnel's reverse forward, may ask nb01 to nb08 (nb09 and nb10 are not shared with it)
vm "sudo test -f $D/agent/.env || { printf 'PORT=23890\nGW_HOST=127.0.0.1\nA2A_BASE=http://127.0.0.1:23890\nAGENT_TOKEN=%s\nLLM_URL=http://127.0.0.1:11434/v1\nEMBED_URL=http://127.0.0.1:11434\nLLM_SLOTS=4\nA2A_PEERS_FILE=$D/agent/peers.json\nMESSENGER_PAGE_TOKEN=\nNIGHTLY=0\n' \"\$(openssl rand -hex 24)\" | sudo tee $D/agent/.env > /dev/null; }
    sudo chown servegw:servegw $D/agent/.env && sudo chmod 600 $D/agent/.env"
echo '{"self":"gwb","peers":[{"name":"gwa","origin":"http://127.0.0.1:23790","serve":["nb01","nb02","nb03","nb04","nb05","nb06","nb07","nb08"],"members":[]}]}' \
  | vm "sudo tee $D/agent/peers.json > /dev/null && sudo chown servegw:servegw $D/agent/peers.json && sudo chmod 640 $D/agent/peers.json"

# 6. the service: starts on boot, restarts on failure
vm "sudo tee /etc/systemd/system/serve-gateway-b.service > /dev/null" < "$ROOT/agent/test/twogw/serve-gateway-b.service"
vm "sudo systemctl daemon-reload && sudo systemctl enable serve-gateway-b.service > /dev/null 2>&1 && sudo systemctl restart serve-gateway-b.service"

# 7. the tunnel user may forward to Ollama and to gateway B, and listen on gateway A's one port: nothing else
vm "sudo tee /etc/ssh/sshd_config.d/60-serve-tunnel.conf > /dev/null <<'EOF'
# The GPU server key (user serve-tunnel) may forward only to Ollama and to Serve gateway B on this VM, and listen only on
# 127.0.0.1:23790 (the reverse forward to gateway A): no shell, no other port. (Serve: docs/a2a_two_gateways.md)
Match User serve-tunnel
    AllowTcpForwarding yes
    PermitOpen 127.0.0.1:11434 127.0.0.1:23890
    PermitListen 127.0.0.1:23790
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    ForceCommand /usr/sbin/nologin
EOF
sudo sshd -t && sudo systemctl reload ssh"

sleep 4
vm "systemctl is-active serve-gateway-b.service; sudo ss -ltnp | grep -E ':(23890|11434|23790) ' || true; curl -s -m 5 127.0.0.1:23890/a2a/agents | head -c 200; echo"
