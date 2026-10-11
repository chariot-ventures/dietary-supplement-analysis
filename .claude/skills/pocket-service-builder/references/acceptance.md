# Acceptance rules for a submitted service

What a service must satisfy before it is listed on the agentic portal. `scripts/audit_services.py` checks every rule below on the live network and cites the rule code in each finding; the developer-facing version is the docs page *Submit a Service* (https://docs.pocket.network/services/submit/ once published; until then this reference is served at https://mcp.pocketmcp.network/audit/rules). The protocol itself is permissionless and enforces none of this. These are the portal's listing rules, and they exist so a service that is listed can actually be called through a gateway and paid for.

Three levels. **FAIL** blocks acceptance. **WARN** is reported, must be answered by the submitter, and does not block. **SKIP** means the rule could not be evaluated because an earlier rule failed.

| Code | Rule | Level | Why |
|---|---|---|---|
| A1 | The service ID is registered on the submitted network. | FAIL | Nothing else can be checked without the record. IDs are permanent, so a typo here is a new service. |
| A2 | The on-chain card is present, decodes as one UTF-8 JSON object, and passes the `pocket-service-card/v1` schema. Under 4 KiB. | FAIL on schema errors; WARN on convention gaps | The card is the only thing gateways, suppliers, and consumers read. A missing or invalid card means nobody can route, serve, or call the service. Convention gaps (`results`, `updated`, `specs[].api`, the JSON-object statement in the description) are warnings. |
| A3 | Every `apis[]` value is unique within the submission and not claimed by another card on the same network. | FAIL | `apis[]` is what a gateway keys on to group interchangeable services. A duplicate silently merges two services in every consumer's eyes. |
| A4 | At least one active supplier is staked for the service. If the submission names an operator, that operator is among them and is not unbonding. | FAIL | A registered service with no supplier serves nothing. |
| A5 | Every staked endpoint is an `https://` URL on a hostname, not a bare IP, and its `rpc_type` is one of the card's `rpc_types`. | FAIL | Gateways connect to the staked URL as given. Plain HTTP or an IP address is refused by the public gateway's TLS policy, and a mismatched `rpc_type` routes the wrong protocol at the backend. |
| A6 | The endpoint answers over TLS with a publicly trusted certificate. Any HTTP status counts; a RelayMiner answers 400 to an unsigned request. | FAIL | A staked URL that does not answer is a supplier that will be scored down from the first session. |
| A7 | At least one **settled** claim exists for the service on the submitted network, and one by the named operator if given. The audit reads settlement history from the indexer, because the LCD lists a claim only until it settles. | FAIL; on MainNet, WARN if the newest settlement is older than 7 days (not checked on Beta, where a tested service sees no further traffic) | The only on-chain proof that a relay went through the protocol, reached the backend, was signed, claimed, and paid. It is the submitter's job to produce it before submitting: stake an application for the service, send a relay with pocket-ap or the Service Manager's Test step, and wait for settlement. |
| A8 | Card and record content: the on-chain display name is human-readable, not a slug or a copy of the ID; an identity probe whose `expect` pins the response to this service ID; at least one functional probe beyond health and version; every `specs[].url` resolves; the spec is per service, not shared across a submission; the spec kind is machine-readable (`openapi`) before MainNet. | WARN | The portal shows the display name, and an `edit-service` batch can silently overwrite it with an internal slug (it happened to a 40-service batch on 2026-09-17). A probe that pins a different name than the service ID either fails on a correct backend or passes on the wrong one. Health-only probes prove the container is up, not that the service works. A shared README is not a contract. |
| A9 | `compute_units_per_relay` is priced with the live multiplier and granularity, reported in uPOKT per relay, and placed in the catalog; a price above the 95th percentile is flagged. The same price across a batch is normal: developers launch batches at one price. | WARN | An outlier price is not wrong, but the submitter should be able to say why. |

## What the audit cannot check

- Whether the backend follows the response rules in `design-rules.md` (JSON envelope, 4xx with a JSON body, no gzip). `scripts/lint_backend.py` checks a backend directly, but an auditor cannot reach the backend behind a relayer without staking an application. Require the submitter to run the linter and include its output in the submission.
- Whether the card's description is accurate. Read it.
- Whether the functional probe's expected value is meaningful. A probe that only echoes the service name proves the envelope, not the function. Read it.

## Running the audit

```bash
python scripts/audit_services.py --manifest submission.json --json audit.json
python scripts/audit_services.py <id> [<id> ...] --network beta --operator pokt1...
```

The manifest is `templates/submission.json`. Its `operator_address` is the supplier's operator; in the Pocket Service Manager (0.1.23 or newer) the user copies it with the Copy button next to the operator in My services (per network) or Suppliers. The report it writes is the record of what was accepted and when. Re-audit accepted services on a schedule with `--baseline <last report>`; the diff names every verdict change, card rewrite, price change, endpoint change, supplier change, and settlement count, and a regression makes the exit code non-zero. The same rules run on the remote MCP server as the `audit_services` tool, as a self-service page at https://mcp.pocketmcp.network/audit, and as JSON at `GET https://mcp.pocketmcp.network/api/audit?network=beta&ids=<id,id>&operator=<pokt1...>`; developers should run one of these before submitting.

## Recording a decision

Keep the submission manifest and the audit report together. When a submission is accepted, add its services to the accepted manifest that the scheduled re-audit reads; when one is withdrawn or delisted, remove it there. Never edit a past report.
