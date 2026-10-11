#!/usr/bin/env bash
# Provision the dietary-supplement-analysis Beta TestNet supplier on this server.
# Ubuntu 24.04 on Oracle Cloud (ARM64 or x86_64). Run as the `ubuntu` user (uses sudo).
#
#   ./provision.sh base       Docker, swap, firewall, log limits, /opt/pocket
#   ./provision.sh backend    clone the repo at $REF and start the backend container
#   ./provision.sh operator   install pocketd, create the operator key ON THIS SERVER
#   ./provision.sh stack      HA RelayMiner (redis + miner + relayer), pinned versions
#   ./provision.sh caddy      TLS for the relay and agents hostnames, demo route rate-limited (needs DNS first)
#   ./provision.sh pubkey     1 uPOKT self-transfer so the operator's public key is on-chain
#   ./provision.sh status     what is running, health, memory, operator address
#
# Secrets: the operator private key is written only to $STACK/supplier-keys.yaml (uid 1000,
# mode 400) and $STACK/operator-key.json (mode 600). It is never printed.
set -euo pipefail

SERVICE_ID=dietary-supplement-analysis
REPO=https://github.com/micallb/dietary-supplement-analysis.git
REF=${REF:-main}
RELAY_HOST=pokt-beta.trackmysupplement.com
AGENTS_HOST=agents.trackmysupplement.com
RM_IMAGE=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0
REDIS_IMAGE=redis:8.10.1-alpine
CADDY_IMAGE=caddy:2
CADDY_LOCAL_IMAGE=pocket-caddy-ratelimit:local
POCKETD_VERSION=v0.1.35
POCKETD_SHA_ARM64=9a13cbf008a3e20a5cbb1daef588b253ec027c07d9c7252e5854c44d8d11abc9
POCKETD_SHA_AMD64=99b88aa839a19d6b89b4923cadbc5848ba161a828e514ea9751dffd569066a3b
CHAIN_ID=pocket-lego-testnet
RPC_URL=https://sauron-rpc.beta.infra.pocket.network
GRPC_URL=sauron-grpc.beta.infra.pocket.network:443
ROOT=/opt/pocket
STACK=$ROOT/supplier-beta
SVC=$ROOT/services/$SERVICE_ID
KR="--keyring-backend test --home $STACK/pocket-home"
D="sudo docker"

log(){ echo "[$(date +%H:%M:%S)] $*"; }

phase_base(){
  log "packages"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git curl python3 netfilter-persistent >/dev/null
  sudo usermod -aG docker ubuntu || true
  log "docker log limits"
  echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
  log "swap"
  if ! swapon --show | grep -q /swapfile; then
    sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  fi
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  log "firewall: open 80/tcp, 443/tcp, 443/udp (Oracle's Ubuntu image rejects them by default)"
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    sudo iptables -C INPUT $rule -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 $rule -j ACCEPT
  done
  sudo netfilter-persistent save >/dev/null 2>&1 || true
  sudo mkdir -p $ROOT && sudo chown ubuntu:ubuntu $ROOT
  $D network inspect pocket-supplier >/dev/null 2>&1 || $D network create pocket-supplier >/dev/null
  log "base done: $(docker --version 2>/dev/null || sudo docker --version), $(free -m | awk '/Swap/{print $2" MB swap"}')"
}

phase_backend(){
  mkdir -p $SVC/deploy
  if [ -d $SVC/backend/.git ]; then
    git -C $SVC/backend fetch -q --depth 1 origin "$REF" && git -C $SVC/backend checkout -q --detach FETCH_HEAD
  else
    git clone -q --depth 1 --branch "$REF" $REPO $SVC/backend
  fi
  log "backend source at $(git -C $SVC/backend log -1 --format='%h %s' | cut -c1-80)"
  cat > $SVC/deploy/docker-compose.yaml <<YAML
# $SERVICE_ID backend. Reached only over the pocket-supplier Docker network:
# by the relayer (paid relays) and by Caddy for the $AGENTS_HOST demo route.
services:
  backend:
    build: ../backend
    image: $SERVICE_ID-backend:latest
    container_name: $SERVICE_ID-backend
    restart: unless-stopped
    environment:
      LOG_LEVEL: info
    expose: ["8080"]
    mem_limit: 512m
    networks: [supplier]
networks:
  supplier:
    external: true
    name: pocket-supplier
YAML
  (cd $SVC/deploy && $D compose -p $SERVICE_ID up -d --build 2>&1 | tail -3)
  for i in $(seq 1 30); do
    if $D exec $SERVICE_ID-backend node -e "fetch('http://127.0.0.1:8080/v1/version').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
      log "backend healthy"; return 0; fi
    sleep 2
  done
  log "backend did not answer"; return 1
}

phase_operator(){
  if ! command -v pocketd >/dev/null || [ "$(pocketd version 2>/dev/null)" != "${POCKETD_VERSION#v}" ]; then
    case "$(uname -m)" in aarch64) A=linux_arm64; S=$POCKETD_SHA_ARM64;; x86_64) A=linux_amd64; S=$POCKETD_SHA_AMD64;; esac
    T=$(mktemp -d)
    curl -fsSL -o $T/p.tgz https://github.com/pokt-network/poktroll/releases/download/$POCKETD_VERSION/pocket_$A.tar.gz
    echo "$S  $T/p.tgz" | sha256sum -c - >/dev/null
    tar -xzf $T/p.tgz -C $T && sudo install -m 0755 $T/pocketd /usr/local/bin/pocketd && rm -rf $T
  fi
  log "pocketd $(pocketd version)"
  mkdir -p $STACK/pocket-home && chmod 700 $STACK/pocket-home
  # shellcheck disable=SC2086
  if ! pocketd keys show operator $KR >/dev/null 2>&1; then
    pocketd keys add operator $KR --no-backup --output json >/dev/null 2>&1
    log "created operator key on this server"
  fi
  # shellcheck disable=SC2086
  ADDR=$(pocketd keys show operator -a $KR)
  ( umask 077
    # shellcheck disable=SC2086
    HEX=$(echo y | pocketd keys export operator --unarmored-hex --unsafe $KR 2>/dev/null)
    [ ${#HEX} -eq 64 ] || { echo "key export failed" >&2; exit 1; }
    printf '{"name":"operator","address":"%s","private_key_hex":"%s"}\n' "$ADDR" "$HEX" > $STACK/operator-key.json
    sudo rm -f $STACK/supplier-keys.yaml
    printf '# Operator signing key for the HA RelayMiner. Never commit, copy or print.\nkeys:\n  - "%s"\n' "$HEX" > $STACK/supplier-keys.yaml
  )
  sudo chown 1000:1000 $STACK/supplier-keys.yaml && sudo chmod 400 $STACK/supplier-keys.yaml
  echo "OPERATOR_ADDRESS=$ADDR" | tee $STACK/operator-address.env
}

write_stack_files(){
  cat > $STACK/docker-compose.yaml <<YAML
# HA RelayMiner for Beta TestNet. One stack per network per server, serving every
# service the supplier is staked for. Sized for a 4 GB server (server-recommendations.md).
name: pocket-supplier-beta
services:
  redis:
    image: $REDIS_IMAGE
    container_name: pocket-beta-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 490mb --maxmemory-policy noeviction
    mem_limit: 614m
    volumes: [redis-data:/data]   # session trees: never delete this volume
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, timeout: 3s, retries: 5 }
    networks: [supplier]
  miner:
    image: $RM_IMAGE
    container_name: pocket-beta-miner
    restart: unless-stopped
    command: ["miner", "--config", "/config/config.yaml"]
    mem_limit: 614m
    environment: { GOMEMLIMIT: 550MiB, GOMAXPROCS: "1" }
    volumes:
      - ./miner-config.yaml:/config/config.yaml:ro
      - ./supplier-keys.yaml:/keys/supplier-keys.yaml:ro
    ports: ["127.0.0.1:9092:9092"]
    depends_on: { redis: { condition: service_healthy } }
    networks: [supplier]
  relayer:
    image: $RM_IMAGE
    container_name: pocket-beta-relayer
    restart: unless-stopped
    command: ["relayer", "--config", "/config/config.yaml"]
    mem_limit: 307m
    environment: { GOMEMLIMIT: 276MiB, GOMAXPROCS: "1" }
    volumes:
      - ./relayer-config.yaml:/config/config.yaml:ro
      - ./supplier-keys.yaml:/keys/supplier-keys.yaml:ro
    expose: ["8080"]
    ports: ["127.0.0.1:8081:8081", "127.0.0.1:9090:9090"]
    depends_on: { redis: { condition: service_healthy }, miner: { condition: service_started } }
    networks: [supplier]
networks:
  supplier: { external: true, name: pocket-supplier }
volumes:
  redis-data:
YAML
  cat > $STACK/relayer-config.yaml <<YAML
listen_addr: "0.0.0.0:8080"
redis:
  url: "redis://redis:6379"
keys:
  keys_file: "/keys/supplier-keys.yaml"
pocket_node:
  query_node_rpc_url: "$RPC_URL"
  query_node_grpc_url: "$GRPC_URL"
  grpc_insecure: false
default_validation_mode: eager
services:
  $SERVICE_ID:
    timeout_profile: fast
    validation_mode: eager
    max_body_size_bytes: 20971520
    default_backend: rest
    backends:
      rest:
        url: "http://$SERVICE_ID-backend:8080"
        health_check:
          endpoint: "/v1/health"
          interval_seconds: 10
          timeout_seconds: 5
default_request_timeout_seconds: 30
default_max_body_size_bytes: 20971520
health_check:
  enabled: true
  addr: "0.0.0.0:8081"
timeout_profiles:
  fast:
    request_timeout_seconds: 30
    response_header_timeout_seconds: 30
    dial_timeout_seconds: 5
    tls_handshake_timeout_seconds: 10
  streaming:
    request_timeout_seconds: 600
    response_header_timeout_seconds: 0
    dial_timeout_seconds: 10
    tls_handshake_timeout_seconds: 15
YAML
  cat > $STACK/miner-config.yaml <<YAML
redis:
  url: "redis://redis:6379"
  claim_idle_timeout_ms: 60000
pocket_node:
  chain_id: "$CHAIN_ID"
  query_node_rpc_url: "$RPC_URL"
  query_node_grpc_url: "$GRPC_URL"
  grpc_insecure: false
  query_timeout_seconds: 5
keys:
  keys_file: "/keys/supplier-keys.yaml"
block_time_seconds: 30
balance_monitor:
  enabled: true
  check_interval_seconds: 300
  balance_threshold_upokt: 10000
transaction:
  gas_limit: 0
  gas_price: "0.000001upokt"
  gas_adjustment: 1.7
leader_election:
  leader_ttl_seconds: 30
  heartbeat_rate_seconds: 10
metrics:
  enabled: true
  addr: "0.0.0.0:9092"
logging:
  level: "info"
  format: json
YAML
}

phase_stack(){
  [ -f $STACK/supplier-keys.yaml ] || { log "run: ./provision.sh operator first"; return 1; }
  write_stack_files
  cd $STACK
  $D pull -q $RM_IMAGE >/dev/null && $D pull -q $REDIS_IMAGE >/dev/null
  for c in miner relayer; do
    OUT=$($D run --rm -v $STACK/$c-config.yaml:/config/config.yaml:ro -v $STACK/supplier-keys.yaml:/keys/supplier-keys.yaml:ro $RM_IMAGE $c validate --config /config/config.yaml 2>&1 | grep -v -i 'key"' | tail -3) || true
    log "validate $c: $OUT"
  done
  $D compose up -d redis miner 2>&1 | tail -2
  sleep 10
  $D compose up -d relayer 2>&1 | tail -2
  sleep 8
  log "relayer health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/health) ready: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ready)"
  $D logs pocket-beta-relayer 2>&1 | grep -i -E 'signing keys loaded|no key providers|error' | tail -3 || true
  $D logs pocket-beta-miner 2>&1 | grep -i -E 'HA Miner started|error' | tail -3 || true
}

phase_caddy(){
  IP=${PUBLIC_IP:?set PUBLIC_IP}
  for h in $RELAY_HOST $AGENTS_HOST; do
    R=$(getent ahostsv4 $h | awk 'NR==1{print $1}')
    [ "$R" = "$IP" ] || { log "$h resolves to '${R:-nothing}', not $IP; add the DNS A record first"; return 1; }
  done
  mkdir -p $ROOT/caddy
  # Stock Caddy has no rate limiter; build one with github.com/mholt/caddy-ratelimit.
  cat > $ROOT/caddy/Dockerfile <<DF
FROM $CADDY_IMAGE-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit
FROM $CADDY_IMAGE
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
DF
  (cd $ROOT/caddy && $D build -q -t $CADDY_LOCAL_IMAGE . >/dev/null) && log "built $CADDY_LOCAL_IMAGE"
  cat > $ROOT/caddy/Caddyfile <<CADDY
{
	order rate_limit before reverse_proxy
}

# Paid relays: the staked supplier endpoint. Every relay is signed; no auth here.
$RELAY_HOST {
	reverse_proxy pocket-beta-relayer:8080
	request_body {
		max_size 20MB
	}
}

# Direct demo route for judges and humans (not a Pocket relay, not paid).
# Rate-limited so the free route can't hammer the NIH DSLD API.
$AGENTS_HOST {
	request_body {
		max_size 1MB
	}
	rate_limit {
		zone per_client {
			match {
				not path /mcp
			}
			key {remote_host}
			events 30
			window 1m
		}
		# MCP clients (claude.ai and others) share egress IPs; the backend limits per connection.
		zone per_client_mcp {
			match {
				path /mcp
			}
			key {remote_host}
			events 300
			window 1m
		}
		zone all_clients {
			key demo
			events 600
			window 1m
		}
	}
	reverse_proxy $SERVICE_ID-backend:8080
	handle_errors 429 {
		header Content-Type application/json
		respond \`{"error":{"code":"RATE_LIMITED","message":"Demo endpoint rate limit reached. Retry shortly, or use the service through Pocket Network.","retryable":true,"field":null}}\` 429
	}
}
CADDY
  cat > $ROOT/caddy/docker-compose.yaml <<YAML
name: pocket-caddy
services:
  caddy:
    image: $CADDY_LOCAL_IMAGE
    container_name: pocket-caddy
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    mem_limit: 128m
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks: [supplier]
networks:
  supplier: { external: true, name: pocket-supplier }
volumes:
  caddy-data:
  caddy-config:
YAML
  (cd $ROOT/caddy && $D compose up -d 2>&1 | tail -2)
  sleep 20
  for h in $AGENTS_HOST $RELAY_HOST; do
    log "https://$h -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://$h/ || echo fail)"
  done
}

phase_pubkey(){
  # shellcheck disable=SC2086
  ADDR=$(pocketd keys show operator -a $KR)
  BAL=$(curl -s https://sauron-api.beta.infra.pocket.network/cosmos/bank/v1beta1/balances/$ADDR | python3 -c "import json,sys;b=json.load(sys.stdin).get('balances',[]);print(next((x['amount'] for x in b if x['denom']=='upokt'),'0'))")
  log "operator $ADDR balance ${BAL} upokt"
  [ "$BAL" != "0" ] || { log "fund the operator first"; return 1; }
  # shellcheck disable=SC2086
  pocketd tx bank send operator $ADDR 1upokt $KR --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('pubkey tx', d.get('txhash'), 'code', d.get('code'))"
}

phase_status(){
  $D ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
  echo "relayer health $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/health) ready $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ready)"
  free -m | awk 'NR<=3'
  [ -f $STACK/operator-address.env ] && cat $STACK/operator-address.env
  $D stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'
}

case "${1:-}" in
  base|backend|operator|stack|caddy|pubkey|status) "phase_$1" ;;
  all) phase_base && phase_backend && phase_operator && phase_stack ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
