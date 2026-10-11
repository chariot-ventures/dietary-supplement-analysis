# Server recommendations

What a supplier server needs, how to size and prepare it, and what running one taught us. It applies to anyone who supplies an HTTP service on Pocket Network (Shannon), whether the server is set up by the Pocket Service Manager app or by hand. Where the app already does something for you, the text says so.

Everything here was learned on live Beta TestNet and MainNet suppliers between 2026-09-14 and 2026-09-28. Software versions are pinned and dated below. Chain values (stake minimums, fees, penalties, session length) are never quoted here: they are governance parameters, so fetch them at the moment you need them (`references/live-parameters.md`).

## 1. At a glance

| | Recommendation |
|---|---|
| Operating system | Linux, x86_64 or ARM64. Verified on Ubuntu 24.04 LTS. |
| Memory | 3 GB is the hard floor (the stack refuses to start below it). 4 GB for a few light services; 8 GB once any backend needs more than about 512 MB or traffic is steady. |
| Swap | Yes. A swap file of about the size of memory (4 GB on a 4 GB server). |
| CPU | 2 vCPUs minimum, 4 comfortable. |
| Disk | 25 GB SSD minimum, 50 GB comfortable. |
| Access | SSH with a key only; a normal user in the `docker` group with passwordless `sudo`. |
| Software | Docker Engine with the Compose v2 plugin (`docker compose`), `python3`, `curl`. |
| Network | A public IPv4 address, ports 80 and 443 reachable from the internet, one DNS hostname per network pointing at the server. |
| RelayMiner | The HA RelayMiner (`pocket-relay-miner`) only, one stack per network per server, a pinned version. |
| Backends | One container per service, shared by both networks, with its own memory limit. |

## 2. What runs on a supplier server

A server is network-agnostic. What is per network is the **supplier stack**, because a stack's chain ID, node URLs, operator key, and stake all belong to one network.

| Part | How many | Notes |
|---|---|---|
| Supplier stack: Redis, miner, relayer | One per network (so at most two: Beta TestNet and MainNet) | Each in its own directory with its own operator key, Compose project, loopback ports, and public hostname. Redis and the miner sit on the stack's private Docker network; only the relayer joins the shared one. |
| Caddy | One per server | Terminates TLS for every stack. One site file per network maps that network's hostname to its relayer. The only container published to the internet. |
| Service backends | One container per service | On the shared `pocket-supplier` Docker network, reached by container name (`http://<service-id>-backend:8080`). One backend serves both networks' relayers. |

Rules that follow from this:

- **Never one stack per service.** One supplier stake covers every service the supplier lists, and one relayer routes by the service ID inside each relay. Adding a service means starting its backend and adding one entry to the relayer's service list, then re-staking the supplier with the service in its list.
- **Never one stack for both networks.** A relay carries nothing a proxy could route on, so each network needs its own hostname and relayer. An early layout with one stack per server hid the Beta server on MainNet (2026-09-14).
- **Never the legacy single-process `pocketd relayminer`.** It is deprecated, and its claim signing needs the `x-cosmos-block-height` gRPC header that the public Sauron endpoints strip: relays are served, every claim fails with "unexpected 'x-cosmos-block-height' header length; got 0", and the session's earnings are lost (verified on Beta, 2026-09-14). The HA RelayMiner does not depend on that header.

Default layout (the app's):

| Path | What |
|---|---|
| `/opt/pocket/supplier-beta/`, `/opt/pocket/supplier-main/` | The two stacks (a stack provisioned before the per-network layout may keep an older directory name; that is fine). |
| `/opt/pocket/caddy/` | The shared Caddy, its `Caddyfile`, `sites/<network>.caddy`, and `sites/routes/<service-id>.route` for extra public paths. |
| `/opt/pocket/services/<service-id>/` | Each service's backend source and its compose file. |

Loopback ports per stack (never public):

| | Beta TestNet | MainNet |
|---|---|---|
| Relayer health (`/health`, `/ready`) | 8081 | 8082 |
| Relayer metrics | 9090 | 9091 |
| Miner metrics | 9092 | 9093 |

## 3. Sizing the server

### Two kinds of size

The sizes in `references/deploy.md` §8 (and on the docs' Deploy a Service page) are the RelayMiner project's reference sizes: the limits in its Docker Compose example, which fits several suppliers with ordinary traffic, and the machine behind its published capacity report. Use those when planning for real volume.

A new service with light traffic, served by one supplier, runs on much less, as long as every part has a memory limit. The rest of this section is that smaller case, measured on live suppliers. Grow toward the reference sizes as traffic grows; the RelayMiner's benchmarks (github.com/pokt-network/pocket-relay-miner, `docs/benchmarks`) explain how to size for a given load.

### Memory

Memory is the constraint that matters on a small server. CPU is mostly idle between bursts, and disk use is modest.

The stack sizes itself from the server's own memory each time it starts (the app's `supplier.sh start` does this; do the same by hand):

1. Keep back a quarter of total memory, and never less than 1 GiB, for the operating system, Docker, Caddy, and **every service backend**.
2. Split the rest in two, one share per network, **whether or not the second network's stack exists yet**, so adding the second network later never starves the first.
3. Within a stack's share: Redis 40%, miner 40%, relayer 20% (the RelayMiner project's own proportions). Redis's `maxmemory` is 80% of its container limit; each Go process's `GOMEMLIMIT` is 90% of its container limit; `GOMAXPROCS` is half the CPUs, at least 1.
4. Refuse to start if a stack's share would be under 1 GiB. That makes **3 GB the minimum server**.

What that gives (servers report slightly less memory than their nominal size, so real limits come out a little lower):

| Server memory | Kept back for system and backends | Each stack | Redis / miner / relayer limits |
|---|---|---|---|
| 3 GB | 1 GB | 1 GB | ~410 / 410 / 205 MB |
| 4 GB | 1 GB | ~1.5 GB | ~614 / 614 / 307 MB |
| 8 GB | 2 GB | 3 GB | ~1.2 GB / 1.2 GB / 614 MB |
| 16 GB | 4 GB | 6 GB | ~2.4 GB / 2.4 GB / 1.2 GB |

The part to plan for is the amount kept back. On a 4 GB server it is 1 GB, and that has to hold the operating system, Docker, Caddy, and every backend together. What a supplier actually used, measured on a 4 GB server running both networks and four services (2026-09-28, light traffic):

| Container | In use | Limit |
|---|---|---|
| Relayer (each network) | ~31 MB | 289 MB |
| Miner (each network) | ~35 MB | 578 MB |
| Redis (each network) | ~6 MB | 578 MB |
| Caddy | ~15 MB | none |
| A Node.js charts renderer | ~106 MB | 768 MB |
| A data-analysis backend | ~272 MB | 2 GB |
| Two small backends | ~14 MB and ~29 MB | none and 256 MB |

The stacks sit far below their limits at rest; the limits are there for bursts and for the Redis session trees of a busy session. The backends are what grows. So:

- **Size the server for the backends, not the RelayMiner.** Add up what your backends need under load, add 1 GB for the system, then add the two stack shares. If that does not fit in 4 GB, take 8 GB.
- **Give every backend a memory limit** (`mem_limit` in its compose file). Without one, a single runaway backend can take the memory the stacks were promised. The app sets 512 MB for a service deployed without its own compose file (from 0.1.14); a service that needs more ships its own `deploy/docker-compose.yaml` with a larger limit.

### Swap

Add a swap file. Without swap, a server that runs out of memory has the kernel kill a process outright, and the process chosen can be the relayer, the miner, Redis, or a backend: a dropped relay at best, a lost session tree at worst. With swap, the same moment is a slowdown instead.

A swap file about the size of memory (4 GB on a 4 GB server) is plenty. Keep swappiness at the default (60). Make it survive a reboot (an `/etc/fstab` entry). Swap is a safety margin, not extra capacity: if the server swaps steadily, it needs more memory.

The app does not create swap yet; it is part of preparing the server.

### CPU

Two vCPUs are enough to start; four are comfortable. The relayer and miner use a fraction of one core at light traffic. CPU matters for backends that compute (rendering, analysis, inference) and for bursts: gateways hedge and retry, so a service sees several near-simultaneous requests, not an even trickle.

### Disk

25 GB SSD is the minimum, 50 GB comfortable. A supplier with both networks and four services used about 11 GB in total, of which about 2.2 GB was Docker images and 0.75 GB was build cache. What grows over time:

- Images and build cache from redeploys (each redeploy builds the backend again).
- Container logs, which Docker keeps without limit by default (see section 8).
- Redis's append-only file, which holds unclaimed session trees. It is small, but it must be on persistent disk: losing it forfeits every relay not yet claimed.

## 4. Choosing a provider and a server

- **A plain Linux virtual server is enough.** Any provider that gives a public IPv4 address, root access, and a choice of Ubuntu LTS works.
- **Keep the supplier on its own server where you can.** Sharing a small server with another application halves the memory the stacks can safely use. If a server already runs something else, count that application's memory as part of the amount kept back, and size up.
- **A home or office connection behind a router** works only if ports 80 and 443 can be forwarded to the server. The app assumes the public endpoint answers on 443 directly; a supplier whose router forwards another port (a staked URL such as `https://host:8445`) is not supported by the app yet.
- **A full node of your own is optional.** The HA RelayMiner works against the public Sauron RPC and gRPC endpoints (verified with a settled claim on Beta, 2026-09-14; the MainNet stacks run the same way). A production operator may still prefer a node they control for latency and independence; that is a separate, much larger server (the Pocket docs' hardware page has its size).

## 5. Preparing the server

Do these once, before provisioning. The app does everything after this list. You do not have to do them by hand: once Claude Code can connect to the server over SSH, it can do all of them for you (section 11).

1. **Operating system.** A current Ubuntu LTS (24.04 verified), updated.
2. **A normal user for the supplier**, for example `deploy`:
   - member of the `docker` group, so Docker runs without `sudo`;
   - passwordless `sudo`, because provisioning fixes ownership of the key files (`chown` to the container's user, mode 400) and runs no interactive prompt;
   - able to write `/opt/pocket` (create it and give it to that user).
3. **SSH with a key only.** An ed25519 key on the PC that manages the server; turn password login off and root login off (or key-only). If the key has a passphrase, it must be held by the SSH agent, because the app connects non-interactively and accepts a new server's host key on first connection.
4. **Docker Engine with the Compose v2 plugin** (`docker compose`, not the old `docker-compose`). Ubuntu's own packages worked (Docker 29.1, Compose 2.40); Docker's official packages work too. Plus `python3` and `curl`, which the stack's helper uses.
5. **Swap**, as in section 3.
6. **Firewall.** Allow 22 (SSH), 80 and 443 (TCP), and 443 (UDP, for HTTP/3). Nothing else needs to be reachable. Two things to know:
   - Ports Docker publishes bypass a host firewall such as `ufw`. The stack is built for that: only Caddy publishes public ports, and every health and metrics port is bound to `127.0.0.1`. Do not change those bindings to `0.0.0.0`.
   - A provider's cloud firewall, if there is one, must also allow 80 and 443.
7. **DNS, before provisioning.** One hostname per network (for example `services-beta.example.org` for Beta TestNet and `services.example.org` for MainNet), each with an A record pointing at the server. Caddy requests the certificate the moment the stack starts, and it cannot get one for a name that does not yet resolve to the server.
8. **Clock synchronisation** on (it is by default on Ubuntu). Certificates and signed traffic assume a correct clock.

## 6. The RelayMiner stack

### Versions: pin them, keep them together

| Component | Version (verified 2026-09-28) | Rule |
|---|---|---|
| `ghcr.io/pokt-network/pocket-relay-miner` | `v0.1.0` | Relayer and miner run the **same exact tag**. Never a moving tag such as `:rc` or `:latest`, never mixed versions. |
| `redis` | `8.10.1-alpine` | RelayMiner v0.1.0 refuses Redis below 8.10. |
| `ghcr.io/pokt-network/pocketd` | `0.1.35` | Used on the server only to create the operator key and publish its public key. |
| `caddy` | `2` | |

Why pinning is not optional: on 2026-09-27 the RelayMiner published its first versioned release, and the moving tag that earlier stacks followed was rebuilt from newer code that refuses older Redis settings. Every stack on the moving tag failed on its next download. The app now writes the pinned versions into each stack (`stack.env`), and a new version reaches a server only through a deliberate update.

### Redis

- `--maxmemory-policy noeviction`. RelayMiner v0.1.0 refuses any other policy, and rightly: an evicted key is a claim that can no longer be proved.
- `--appendonly yes` on a named, persistent volume. The session trees for relays not yet claimed live in Redis; losing the volume forfeits them.
- `maxmemory` below the container limit (80% of it), so Redis refuses writes before the kernel kills it.

### Relayer

- **Validate relays before they reach the backend:** `default_validation_mode: eager` for every service (what the app sets), or `validation_mode: eager` on each service entry. The default (`optimistic`) forwards first and holds request and response bodies in memory until each relay is validated, up to 128 MiB per service and never less than 64 MiB. On a 4 GB server with several services that queue outgrew the relayer's ~260 MiB limit, and a burst of traffic restarted it (fixed in stack layout 3, 2026-09-28).
- **It will not start with an empty service list** ("at least one service must be configured"). A newly provisioned stack starts Redis, the miner, and Caddy; the relayer starts when the first service is added.
- **It is ready only when the whole stack is.** `/ready` answers 503 until the miner has published its service manifest, so start the miner first and let the relayer wait on the miner's health.
- **Request limits.** Body size 20 MB (`default_max_body_size_bytes`), matched by Caddy's `request_body max_size 20MB`; request timeout 30 s (`timeout_profile: fast`). A service that answers slower than 10 s risks being cut off by gateways, whatever the relayer allows.
- **Its keys section is named `keys`**, pointing at `supplier-keys.yaml`. A missing section or an unreadable file ("no key providers configured", "response signer not configured") means every relay is rejected as unsigned.

### Miner

- Reads the chain through the public Sauron RPC and gRPC endpoints (`query_node_grpc_url` as `host:443`, no scheme, TLS on).
- Pays for claims and proofs from the operator's balance. Keep a working balance on the operator at all times; the miner's balance monitor warns when it runs low. The app tops the operator up during provisioning.

### Check before you restart

Every configuration change is checked by the pinned image itself before anything restarts (`pocket-relay-miner miner validate` and `relayer validate`), and images are downloaded while the running stack keeps serving. If either check fails, nothing restarts. A relayer config the RelayMiner rejects would stop relays for every service at once, so a service added with a bad entry is taken back out and the previous config restored. The app does all of this; by hand, do it in the same order: pull, validate, then restart.

## 7. Service backends

The rules a backend must meet to be served at all:

- **Every response is a JSON object**, errors included. HTML or any other output rides inside a string field. Gateways grade a relay by its first byte, and a body that does not start with `{` or `[` is a failed relay that penalises the supplier. Full rules: `references/design-rules.md`.
- **Answer `GET /` and `HEAD /` with 2xx.** The RelayMiner pings the backend there.
- **Accept chunked request bodies.** Relay bodies arrive with `Transfer-Encoding: chunked` and no `Content-Length`; a backend that reads only `Content-Length` sees an empty body.
- **Answer within about 10 seconds.** Gateways commonly stop waiting between 10 and 30 s. Longer work returns a job handle at once and lets the client poll.
- **Return 4xx with a JSON body for bad input,** never 5xx. A 5xx is an unpaid failure.

How a backend should run on the server:

- **One container per service**, named `<service-id>-backend`, on the shared `pocket-supplier` network, listening on 8080. `expose` the port, never `ports`: nothing about a backend is published to the internet.
- **A memory limit** (`mem_limit`) sized for bursts, and `restart: unless-stopped`.
- **One backend serves both networks.** A service that keeps separate data per network listens on one port per network and says which in `deploy/relayer.json`, so Beta test traffic can never reach MainNet state.
- **Extra public paths** (for example a path the service's own copies use to talk to each other) are declared in `deploy/routes.json` and served by Caddy on the supplier's hostname. They can never point at a port a relayer calls, because that would serve relays without the relayer.

## 8. Operating the server

- **Updates to the stack go through validation,** as in section 6. With the app: Suppliers shows "stack update needed" when a stack is older than the app, and Update stack applies it while keeping the operator key, the services, and the stake.
- **Never roll the RelayMiner back past v0.1.0 while claims are waiting for proof.** The RelayMiner's own upgrade rules forbid it; wait until every claim made under the newer version is proved.
- **Never delete the Redis volume,** and never run `docker compose down -v` in a stack directory, for the same reason.
- **Bound the container logs.** Docker keeps container logs without limit by default. Set a size limit for the log driver (for example `max-size` 10m and `max-file` 3 in `/etc/docker/daemon.json`) so logs cannot fill the disk. The app does not set this yet.
- **Clean up images and build cache now and then.** Redeploys leave old backend images and build cache behind. Remove only what is unused; never the stacks' volumes.
- **Health and metrics stay on loopback.** Read them over SSH (for example an SSH tunnel to Prometheus metrics on 9090–9093), never by opening the ports.
- **Watch the operator balance and the first claim.** Claims and proofs are transactions: an operator that cannot pay the fee forfeits the session's earnings. After a new service is supplied, wait a session and confirm a claim appears; the settled history lives in the indexer, not the LCD.
- **Stake above the minimum, not at it.** The stake is what a missed proof is deducted from, and a supplier that falls below the minimum is unstaked. Fetch the live minimum and penalty and keep a margin.

## 9. Keys on the server

- **Each stack's operator key is created on the server and never leaves it.** It lives in the stack's `pocket-home/` keyring, with a backup in `operator-key.json` (mode 600). Back up that file somewhere safe off the server; losing it means creating a new operator and re-staking.
- **The RelayMiner reads the key from `supplier-keys.yaml`**, written from the keyring, owned by the container's user, mode 400. Never commit it, copy it, or print it.
- **Publish the operator's public key before staking.** A brand-new account has no public key on chain until it sends a transaction; gateways cannot verify the supplier's signed responses until it does. The app does this with a one-uPOKT transfer to itself.
- **The owner wallet never lives on the server.** It signs stakes from the owner's own machine; the operator key only signs relays, claims, and proofs.

## 10. Failures we met, and what fixed them

| Date | What happened | Cause | Fix now in place |
|---|---|---|---|
| 2026-09-14 | Relays served, every claim failed with "x-cosmos-block-height header length; got 0" | Legacy single-process `pocketd relayminer` against public gRPC endpoints that strip the header | HA RelayMiner only |
| 2026-09-14 | The Beta server was invisible on MainNet | One stack per server shared by both networks | One stack per network, each with its own hostname; one shared Caddy |
| 2026-09 | Relayer refused to start on a fresh server | It refuses an empty service list | Start Redis, miner, Caddy first; the relayer with the first service |
| 2026-09 | Backends received empty POST bodies through the relayer | Relay bodies are chunked with no Content-Length | Backends must decode chunked bodies |
| 2026-09 | Backend marked unhealthy though it served requests | The RelayMiner's ping needs `GET /` and `HEAD /` to answer 2xx | Backends answer both |
| 2026-09-27 | New stacks failed to start; existing ones would fail on their next download | The moving `:rc` tag was rebuilt from v0.1.0-era code that refuses Redis below 8.10 and any eviction policy | Pinned RelayMiner v0.1.0 and Redis 8.10.1 with `noeviction`; memory sized from the server; configs validated before restart |
| 2026-09-28 | Relayer restarted under a traffic burst on a 4 GB server | Optimistic validation holds bodies per service (at least 64 MiB each), past the relayer's memory limit | `default_validation_mode: eager` |
| 2026-09-28 | Found: a supplier server with no swap | A server that runs out of memory kills a process instead of slowing down | Swap file added; now part of preparing a server |

## 11. Who does what

Most of this document happens without you having to do it. Four steps need a person, because they involve your own accounts, your payment, or a key only you should hold. For each one, Claude can help guide you through it.

### The steps that need you

| Step | Why it needs you | Claude can help guide |
|---|---|---|
| **Rent the server** | The account and the payment are in your name. | Claude can help you pick a size from section 3 and walk you through the provider's sign-up. |
| **Set up SSH access** | The key is made on your PC, and the first login uses the password or console the provider gives you. | Claude can walk you through making the key and adding it to the server, one step at a time. Once this is done, Claude can reach the server to do the preparation below. |
| **Point your hostnames at the server** | The records live in your domain provider's account. | Claude can tell you exactly which record to add for each network and check when it is working. |
| **Keep a backup of each operator key** | A copy of a key off the server should be held by you alone. | Claude can show you where the file is and how to store it safely; the key itself stays with you. |

### What Claude Code can do for you

Once it can connect to the server, Claude Code can do the preparation in section 5 and tell you what it did: install Docker, set up the user the app connects as, add swap, turn on a firewall that keeps ports 80 and 443 open, and limit Docker's log sizes. It asks before it changes anything.

### What the app does

Everything after that is a button in the Pocket Service Manager:

- **Settings, Servers:** add the server and test the connection.
- **Provision:** set up the RelayMiner for the network the app is on, create its operator key on the server, fund it, get the certificate, and start it.
- **Deploy service:** put your service on the server and connect it.
- **Suppliers:** stake the supplier, and update the stack when a new version of the app needs it.

## Sources

- `pokt-network/pocket-relay-miner` v0.1.0 (release notes and upgrade rules: pinned tags, Redis 8.10 with `noeviction`, validate before restart, `GOMEMLIMIT` with container limits).
- `pokt-network/poktroll` main @ `fea9e14`, `pocketd` v0.1.35.
- `pokt-network/sage` @ `703d8d9` (response grading, hence the JSON envelope rule).
- The Pocket Service Manager's supplier templates and `supplier.sh` (stack layout 3, app 0.1.15).
- Live Beta TestNet and MainNet suppliers, 2026-09-14 to 2026-09-28.
