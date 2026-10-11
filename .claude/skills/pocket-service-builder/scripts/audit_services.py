#!/usr/bin/env python3
"""Audit submitted services against the acceptance rules, on the live network.

Usage:
  python audit_services.py --manifest submission.json [--json report.json] [--baseline last.json]
  python audit_services.py <id> [<id> ...] --network beta [--operator pokt1...]
  python audit_services.py --manifest accepted.json --baseline services/audit/latest.json --json new.json

The manifest is templates/submission.json: the service IDs, the network, the
operator address that supplies them, and a contact. Every rule is listed with
its code in references/acceptance.md; each finding here cites one.

  A1  registered on the network
  A2  card present, decodes, passes the schema (convention gaps are warnings)
  A3  apis[] unique within the submission and unclaimed by other cards
  A4  an active supplier is staked for the service (the named operator, if given)
  A5  every staked endpoint is https on a hostname, rpc_type matches the card
  A6  the endpoint answers over TLS with a valid certificate (skip: --no-probe)
  A7  at least one settled claim for the service (from the indexer)
  A8  card and record content: identity probe, functional probe, spec URLs resolve, display name
  A9  price: compute units per relay priced with live params, placed in the catalog

PASS/WARN/FAIL per rule, one table for the batch, then the findings. Exit 1 if
any service FAILs, else 0. --json writes the machine-readable report; --baseline
diffs against an earlier report and flags regressions (a re-audit). Standard
library only; read-only; jsonschema is used when installed.
"""
import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from common import lcd_base, get, get_all_services, params, settled_claims, EXPLORER, die
import validate_card as vc

PASS, WARN, FAIL, SKIP = "PASS", "WARN", "FAIL", "SKIP"
RULES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]
STALE_DAYS = 7


# ---------- helpers ----------

def decode_card(svc):
    raw = (svc.get("metadata") or {}).get("card")
    if not raw:
        return None, None
    import base64
    try:
        b = base64.b64decode(raw)
        return b, json.loads(b.decode("utf-8"))
    except Exception as e:
        return None, e


def is_ip(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def probe(url, timeout=12):
    """GET the endpoint root. Any HTTP status counts as answering: a RelayMiner
    answers 400 to an unsigned request. Returns (status_or_None, detail)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "pocket-service-audit"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, "answered"
    except urllib.error.HTTPError as e:
        return e.code, "answered"
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY" in str(reason):
            return None, f"TLS certificate rejected: {reason}"
        return None, f"unreachable: {reason}"
    except (TimeoutError, socket.timeout):
        return None, "unreachable: timed out"
    except (ssl.SSLError, OSError) as e:
        return None, f"unreachable: {e}"


def head_ok(url, timeout=15):
    """Does a spec URL resolve? Returns (True, status) or (False, detail)."""
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "pocket-service-audit"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return True, r.status
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 405):
                continue
            return False, f"HTTP {e.code}"
        except Exception as e:
            return False, str(e)
    return False, "no response"


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=timezone.utc) if "+" not in s else datetime.fromisoformat(s)
    except ValueError:
        return None


class Result:
    def __init__(self, sid):
        self.sid = sid
        self.rules = {r: PASS for r in RULES}
        self.findings = []  # (rule, level, message)
        self.facts = {}

    def add(self, rule, level, msg):
        self.findings.append((rule, level, msg))
        order = {PASS: 0, SKIP: 0, WARN: 1, FAIL: 2}
        if order[level] > order[self.rules[rule]]:
            self.rules[rule] = level

    def skip(self, rule, msg):
        self.rules[rule] = SKIP
        self.findings.append((rule, SKIP, msg))

    @property
    def verdict(self):
        if FAIL in self.rules.values():
            return FAIL
        if WARN in self.rules.values():
            return WARN
        return PASS


# ---------- the audit ----------

def audit(manifest, no_probe=False):
    net = manifest["network"]
    other = "main" if net == "beta" else "beta"
    entries = manifest["services"]
    default_op = manifest.get("operator_address")

    catalog = {s["id"]: s for s in get_all_services(net)}
    other_ids = {s["id"] for s in get_all_services(other)}
    shared = params(net, "shared")
    mult = int(shared.get("compute_units_to_tokens_multiplier", 0))
    gran = int(shared.get("compute_unit_cost_granularity", 1)) or 1
    upokt_per_cu = mult / gran

    # apis[] claimed by every card on the network, for A3.
    claimed = {}
    for s in catalog.values():
        _, card = decode_card(s)
        if isinstance(card, dict):
            for a in card.get("apis") or []:
                claimed.setdefault(a, set()).add(s["id"])
    submitted_ids = {e["id"] for e in entries}

    # Cross-submission facts for A3 (apis duplicated inside the batch), A8 (a
    # spec URL shared by the whole batch).
    batch_apis, batch_specs = {}, {}
    for e in entries:
        s = catalog.get(e["id"])
        if not s:
            continue
        _, card = decode_card(s)
        if isinstance(card, dict):
            for a in card.get("apis") or []:
                batch_apis.setdefault(a, []).append(e["id"])
            for sp in card.get("specs") or []:
                if isinstance(sp, dict) and sp.get("url"):
                    batch_specs.setdefault(sp["url"], []).append(e["id"])
    all_cupr = sorted(int(s["compute_units_per_relay"]) for s in catalog.values())

    results = []
    spec_cache = {}
    for e in entries:
        sid = e["id"]
        op = e.get("operator_address") or default_op
        r = Result(sid)
        results.append(r)
        r.facts["operator_expected"] = op
        r.facts["registered_on_other_network"] = sid in other_ids

        # A1 registered
        svc = catalog.get(sid)
        if not svc:
            r.add("A1", FAIL, f"not registered on {net}; see {EXPLORER[net]}/services")
            for rule in RULES[1:]:
                r.skip(rule, "no service record")
            continue
        r.facts.update(owner=svc["owner_address"], name=svc.get("name"), cupr=int(svc["compute_units_per_relay"]))

        # A2 card present and valid
        raw, card = decode_card(svc)
        if raw is None and card is None:
            r.add("A2", FAIL, "no card on chain; register it with add-service --card-file or publish it with update-service")
            card = None
        elif raw is None:
            r.add("A2", FAIL, f"card bytes do not decode as a JSON object: {card}")
            card = None
        else:
            r.facts["card_sha256"] = hashlib.sha256(raw).hexdigest()
            r.facts["card_bytes"] = len(raw)
            if len(raw) > vc.MAX_HARD:
                r.add("A2", FAIL, "card is over the 256 KiB chain limit")
            elif len(raw) > vc.MAX_TARGET:
                r.add("A2", WARN, f"card is {len(raw)} bytes, over the 4 KiB target; move large content out of the card")
            errs = vc.schema_check(card)
            if errs is None:
                errs = vc.structural_check(card)
            else:
                errs += [x for x in vc.structural_check(card) if "'required' key" in x]
            for x in errs:
                r.add("A2", FAIL, f"schema: {x}")
            for w in vc.conventions(card):
                r.add("A2", WARN, w)
            if not re.search(r"json", card.get("description") or "", re.I):
                r.add("A2", WARN, "description does not say that every response is a JSON object")

        card = card if isinstance(card, dict) else {}
        card_rpc = {t.get("type") for t in card.get("rpc_types") or [] if isinstance(t, dict)}

        # A3 apis unique
        for a in card.get("apis") or []:
            others = claimed.get(a, set()) - {sid}
            if others:
                r.add("A3", FAIL, f"apis '{a}' is already claimed by {', '.join(sorted(others))} on {net}")
            dup = [x for x in batch_apis.get(a, []) if x != sid]
            if dup:
                r.add("A3", FAIL, f"apis '{a}' is also used by {', '.join(dup)} in this submission")
        if not card.get("apis"):
            r.add("A3", WARN, "card has no apis[]; nothing for gateways or consumers to key on")

        # A4 active supplier, A5 endpoint shape, A6 endpoint answers
        d, err = get(f"{lcd_base(net)}/pokt-network/poktroll/supplier/supplier?service_id={urllib.parse.quote(sid)}&pagination.limit=500", 60)
        sups = (d or {}).get("supplier", []) if not err else []
        if err:
            r.add("A4", FAIL, f"could not list suppliers: {err}")
        active = []
        for s in sups:
            unb = s.get("unstake_session_end_height")
            if unb and str(unb) != "0":
                r.add("A4", WARN, f"supplier {s['operator_address']} is unbonding (end height {unb})")
                continue
            active.append(s)
        r.facts["suppliers"] = sorted(s["operator_address"] for s in active)
        if not active:
            r.add("A4", FAIL, "no active supplier is staked for this service")
            r.skip("A5", "no supplier")
            r.skip("A6", "no supplier")
        else:
            if op and op not in r.facts["suppliers"]:
                r.add("A4", FAIL, f"the submitted operator {op} is not staked for this service; staked: {', '.join(r.facts['suppliers'])}")
            endpoints = []
            for s in active:
                for cfg in s.get("services", []):
                    if cfg.get("service_id") != sid:
                        continue
                    for ep in cfg.get("endpoints", []):
                        endpoints.append((s["operator_address"], ep.get("url", ""), ep.get("rpc_type")))
            r.facts["endpoints"] = sorted({(u, t) for _, u, t in endpoints})
            probed = set()
            for who, url, rpc in endpoints:
                u = urllib.parse.urlsplit(url)
                short = f"{url} ({rpc}) by {who[-8:]}"
                if u.scheme != "https":
                    r.add("A5", FAIL, f"{short}: not https; the relayer must sit behind a TLS proxy and the https URL is what gets staked")
                elif not u.hostname or is_ip(u.hostname):
                    r.add("A5", FAIL, f"{short}: bare IP address; stake a hostname with a publicly trusted certificate")
                if card_rpc and rpc not in card_rpc:
                    r.add("A5", FAIL, f"{short}: rpc_type {rpc} is not one of the card's rpc_types {sorted(card_rpc)}")
                if no_probe:
                    r.skip("A6", "probe skipped (--no-probe)")
                elif url not in probed:
                    probed.add(url)
                    status, detail = probe(url)
                    if status is None:
                        r.add("A6", FAIL, f"{url}: {detail}")
                    else:
                        r.facts.setdefault("probe", {})[url] = status
                        if u.scheme != "https":
                            r.add("A6", WARN, f"{url}: answers (HTTP {status}) but without TLS; see A5")

        # A7 settled claims
        total, nodes = settled_claims(net, service_id=sid, first=5)
        if total is None:
            r.add("A7", WARN, f"indexer unavailable, cannot read settlement history: {nodes}")
        else:
            r.facts["settled_claims"] = total
            if total == 0:
                r.add("A7", FAIL, "no settled claim for this service; serve at least one relay through the protocol and let it settle before submitting")
            else:
                newest = nodes[0] if nodes else {}
                ts = (newest.get("block") or {}).get("timestamp")
                r.facts["last_settled"] = ts
                r.facts["last_settled_by"] = newest.get("supplierId")
                r.facts["relays_in_last_claim"] = int(newest.get("numRelays") or 0)
                by_ops = {n.get("supplierId") for n in nodes}
                if op and op not in by_ops:
                    tot_op, _ = settled_claims(net, service_id=sid, supplier=op, first=1)
                    if tot_op == 0:
                        r.add("A7", FAIL, f"{total} settled claims exist but none by the submitted operator {op}")
                # Freshness only on MainNet: a Beta service has no traffic once its
                # developer has tested it, so an old settlement there says nothing.
                t = parse_ts(ts)
                if net == "main" and t and (datetime.now(timezone.utc) - t).days > STALE_DAYS:
                    r.add("A7", WARN, f"newest settlement was {ts}, more than {STALE_DAYS} days ago; the service may no longer be served")

        # A8 card and record content
        name = (svc.get("name") or "").strip()
        if not name or name == sid or re.fullmatch(r"[a-z0-9]+([-_][a-z0-9]+)*", name):
            r.add("A8", WARN, f"display name {name!r} looks like a slug; the portal shows this field, so set a human-readable name with edit-service")
        if card:
            hcs = [h for h in (card.get("serving") or {}).get("healthcheck") or [] if isinstance(h, dict)]
            ident = any(re.search(re.escape(sid), json.dumps(h.get("expect") or {})) for h in hcs)
            if not ident:
                r.add("A8", WARN, "no identity probe: a healthcheck whose expect pins the response to this service id")
            func = any((h.get("request") or {}).get("method", "GET").upper() != "GET"
                       or not re.search(r"health|version|ready|ping", (h.get("request") or {}).get("path", ""), re.I)
                       for h in hcs)
            if not func:
                r.add("A8", WARN, "no functional probe: every healthcheck is a health or version GET, so nothing exercises the service")
            specs = [sp for sp in card.get("specs") or [] if isinstance(sp, dict)]
            if not specs:
                r.add("A8", WARN, "no specs[]; consumers have no contract to read")
            for sp in specs:
                url = sp.get("url")
                if not url:
                    continue
                if len(batch_specs.get(url, [])) > 1 and len(entries) > 1:
                    r.add("A8", WARN, f"spec URL is shared with {len(batch_specs[url]) - 1} other service(s) in this submission; each service needs its own contract")
                if sp.get("kind") not in ("openapi", "grpc", "graphql", "asyncapi", "jsonschema"):
                    r.add("A8", WARN, f"spec kind is '{sp.get('kind')}'; a machine-readable contract (openapi) is expected before MainNet")
                if no_probe:
                    continue
                if url not in spec_cache:
                    spec_cache[url] = head_ok(url)
                ok, detail = spec_cache[url]
                if not ok:
                    r.add("A8", WARN, f"spec URL does not resolve: {url} ({detail})")
        else:
            r.skip("A8", "no card")

        # A9 price
        cupr = int(svc["compute_units_per_relay"])
        upokt = cupr * upokt_per_cu
        r.facts["upokt_per_relay"] = round(upokt, 4)
        below = sum(1 for c in all_cupr if c < cupr)
        pct = round(100 * below / len(all_cupr)) if all_cupr else None
        r.facts["price_percentile_in_catalog"] = pct
        if pct is not None and pct >= 95:
            r.add("A9", WARN, f"{cupr} compute units ({upokt:.2f} uPOKT per relay) is above {pct}% of the catalog on {net}")

    return results, {
        "network": net, "upokt_per_compute_unit": upokt_per_cu,
        "catalog_size": len(catalog), "audited_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# ---------- reporting ----------

def to_report(results, meta, manifest):
    return {
        "schema": "pocket-service-audit/v1",
        **meta,
        "manifest": {k: manifest.get(k) for k in ("schema", "submitted", "submitter", "network", "operator_address")},
        "summary": {v: sum(1 for r in results if r.verdict == v) for v in (PASS, WARN, FAIL)},
        "services": [{
            "id": r.sid, "verdict": r.verdict, "rules": r.rules,
            "findings": [{"rule": a, "level": b, "message": c} for a, b, c in r.findings],
            "facts": {k: (list(map(list, v)) if k == "endpoints" else v) for k, v in r.facts.items()},
        } for r in results],
    }


def diff_baseline(report, baseline):
    """Compare with an earlier report. Returns (lines, regressions)."""
    old = {s["id"]: s for s in baseline.get("services", [])}
    lines, regressions = [], 0
    watched = ("card_sha256", "cupr", "endpoints", "suppliers", "settled_claims", "owner")
    for s in report["services"]:
        o = old.get(s["id"])
        if not o:
            lines.append(f"  {s['id']}: new since baseline ({s['verdict']})")
            continue
        if o["verdict"] != s["verdict"]:
            worse = {PASS: 0, WARN: 1, FAIL: 2}[s["verdict"]] > {PASS: 0, WARN: 1, FAIL: 2}[o["verdict"]]
            regressions += worse
            lines.append(f"  {s['id']}: verdict {o['verdict']} -> {s['verdict']}{'  REGRESSION' if worse else ''}")
        for k in watched:
            a, b = o.get("facts", {}).get(k), s.get("facts", {}).get(k)
            if a != b:
                if k == "settled_claims" and isinstance(a, int) and isinstance(b, int) and b > a:
                    lines.append(f"  {s['id']}: settled claims {a} -> {b}")
                else:
                    lines.append(f"  {s['id']}: {k} changed: {a} -> {b}")
    for sid in old:
        if sid not in {s["id"] for s in report["services"]}:
            lines.append(f"  {sid}: in baseline but not in this manifest")
    return lines, regressions


def print_table(results, meta):
    print(f"network {meta['network']}, audited {meta['audited_at']}, catalog {meta['catalog_size']} services, "
          f"1 compute unit = {meta['upokt_per_compute_unit']:.6f} uPOKT (live)\n")
    w = max(len(r.sid) for r in results) if results else 10
    mark = {PASS: ".", WARN: "w", FAIL: "F", SKIP: "-"}
    print(f"{'service':<{w}}  " + " ".join(f"{x:>2}" for x in RULES) + "  verdict  claims  uPOKT/relay  endpoint")
    for r in results:
        row = " ".join(f"{mark[r.rules[x]]:>2}" for x in RULES)
        ep = ", ".join(u for u, _ in r.facts.get("endpoints", [])) or "-"
        print(f"{r.sid:<{w}}  {row}  {r.verdict:<7}  {str(r.facts.get('settled_claims', '-')):>6}  "
              f"{str(r.facts.get('upokt_per_relay', '-')):>11}  {ep}")
    print("\n. pass   w warn   F fail   - skipped")


def print_findings(results):
    """Findings shared by every service print once; the rest print per service."""
    per = [{(a, b, c) for a, b, c in r.findings if b in (FAIL, WARN)} for r in results]
    common = set.intersection(*per) if len(per) > 1 else set()
    if common:
        print(f"\nfindings shared by all {len(results)} services:")
        for a, b, c in sorted(common):
            print(f"  {b:<4} {a}  {c}")
    for r, items in zip(results, per):
        rest = sorted(items - common)
        if not rest:
            continue
        print(f"\n{r.sid}  [{r.verdict}]")
        for a, b, c in rest:
            print(f"  {b:<4} {a}  {c}")


def load_manifest(args):
    if args.manifest:
        with open(args.manifest, encoding="utf-8") as f:
            m = json.load(f)
        if m.get("schema") != "pocket-service-submission/v1":
            die("manifest schema must be pocket-service-submission/v1 (see templates/submission.json)")
        m["network"] = args.network or m.get("network") or "beta"
        if args.operator:
            m["operator_address"] = args.operator
        m["services"] = [{"id": s} if isinstance(s, str) else s for s in m.get("services", [])]
        if not m["services"]:
            die("manifest lists no services")
        return m
    if not args.ids:
        die("pass --manifest <file> or one or more service IDs")
    return {"schema": "pocket-service-submission/v1", "network": args.network or "beta",
            "operator_address": args.operator, "services": [{"id": s} for s in args.ids]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="service IDs, when not using --manifest")
    ap.add_argument("--manifest", help="submission manifest (templates/submission.json)")
    ap.add_argument("--network", choices=["beta", "main"], help="overrides the manifest's network")
    ap.add_argument("--operator", help="operator address expected to supply every service")
    ap.add_argument("--json", dest="json_out", help="write the full report here")
    ap.add_argument("--baseline", help="an earlier --json report to diff against")
    ap.add_argument("--no-probe", action="store_true", help="skip the live endpoint and spec URL probes")
    args = ap.parse_args()

    manifest = load_manifest(args)
    results, meta = audit(manifest, no_probe=args.no_probe)
    report = to_report(results, meta, manifest)

    print_table(results, meta)
    print_findings(results)
    s = report["summary"]
    print(f"\nsummary: {s[PASS]} pass, {s[WARN]} warn, {s[FAIL]} fail of {len(results)}")

    regressions = 0
    if args.baseline:
        with open(args.baseline, encoding="utf-8") as f:
            base = json.load(f)
        lines, regressions = diff_baseline(report, base)
        print(f"\nchanges since baseline ({base.get('audited_at', '?')}):")
        print("\n".join(lines) if lines else "  none")
        report["baseline"] = {"audited_at": base.get("audited_at"), "changes": lines, "regressions": regressions}

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(report, f, indent=1)
            f.write("\n")
        print(f"\nreport written to {args.json_out}")

    print("\nRules are explained in references/acceptance.md. Values were fetched live; re-run before relying on them.")
    sys.exit(1 if s[FAIL] or regressions else 0)


if __name__ == "__main__":
    main()
