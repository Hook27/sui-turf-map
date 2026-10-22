"""
Sui GraphQL transport for fetch_data.py (stdlib only, no pip dependencies).

Replaces the JSON-RPC layer (sui_getObject, sui_multiGetObjects, suix_getDynamicFields,
suix_queryEvents, sui_getTransactionBlock), which Mysten removes from the full-node
software in mid-October 2026. Every public function returns plain Python data; the
objects' `json` is FLAT (no {type, fields} wrappers): a VecMap is {"contents": [{"key",
"value"}]}, a u64 is a string.

Endpoints, in order:
  1. Mysten's public GraphQL — keyless, CORS *, 50 per page, 5000-byte payload limit.
  2. Ankr premium GraphQL, derived from the SUI_RPC_URL secret (the key is the last path
     segment; same convention as the bot). SUI_GRAPHQL_URL overrides it. The URL carries
     the key, so only the HOST is ever logged.
SUI_GRAPHQL_KEYED_FIRST=1 puts the keyed endpoint first.

Tests replace `_http_post` (see tests/); nothing else touches the network.
"""

import base64, json, os, struct, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

MYSTEN_GRAPHQL = "https://graphql.mainnet.sui.io/graphql"
ANKR_GRAPHQL   = "https://rpc.ankr.com/premium-http/sui_graphql/"

PAGE_SIZE  = 50     # GraphQL refuses first/last > 50
MAX_IDS    = 50     # multiGetObjects: 60 ids = 5073 B > the 5000 B payload limit

STRING_TYPE = "0x1::string::String"


def build_endpoints(env=None):
    env = os.environ if env is None else env
    eps = [MYSTEN_GRAPHQL]
    keyed = (env.get("SUI_GRAPHQL_URL") or "").strip()
    if not keyed:
        rpc_url = (env.get("SUI_RPC_URL") or "").strip()
        if rpc_url:
            key = [p for p in rpc_url.split("?")[0].split("/") if p][-1]
            if "://" not in key and len(key) >= 8:
                keyed = ANKR_GRAPHQL + key
    if keyed:
        eps.insert(0 if env.get("SUI_GRAPHQL_KEYED_FIRST") == "1" else len(eps), keyed)
    return eps


ENDPOINTS = build_endpoints()

# ── Transport with endpoint "waiting room" (same idea as the old rpc()) ─────────
# A struggling endpoint gets a time-out measured in CALLS, not seconds; the penalty
# doubles on repetition and is cleared by the next success. Any transient failure (429,
# 5xx, a GraphQL `errors` entry such as Mysten's occasional "Failed to fetch object
# contents", a timeout) first gets ONE short wait and a retry on the same endpoint; only a
# repeat parks it. 401/403/404 mean "this endpoint will not serve us" and park at once.
# With a single endpoint there is nowhere to fail over to, so nothing is ever parked.
RATE_LIMIT_TRIES = 2
PARK_AT_ONCE = (401, 403, 404)
EP_PAUSE_BASE = 25
EP_PAUSE_MAX  = 400

rpc_index = 0
_call_no = 0
_ep_pause_until = {}
_ep_pause_len = {}
sleep = time.sleep      # tests replace this


def ep_host(i):
    # host only — the Ankr URL carries the key and must never reach a CI log
    return ENDPOINTS[i].split("/")[2]


def _ep_pause(i, why):
    if len(ENDPOINTS) < 2:
        print(f"  {ep_host(i)} {why} — enige endpoint, opnieuw proberen...")
        return
    d = min((_ep_pause_len.get(i, 0) * 2) or EP_PAUSE_BASE, EP_PAUSE_MAX)
    _ep_pause_len[i] = d
    _ep_pause_until[i] = _call_no + d
    print(f"  {ep_host(i)} {why} — {d} calls in de wachtkamer, volgend endpoint...")


def _ep_pick():
    for i in range(len(ENDPOINTS)):
        if _ep_pause_until.get(i, 0) <= _call_no:
            return i
    i = min(range(len(ENDPOINTS)), key=lambda k: _ep_pause_until.get(k, 0))
    print(f"  alle endpoints in de wachtkamer — toch maar {ep_host(i)} proberen...")
    sleep(2)
    return i


def _http_post(url, body):
    """POST a JSON body, return the parsed JSON response. The User-Agent is required:
    several providers 403 python-urllib's default."""
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "vwm-fetch/1.0 (+https://vwm.cryptofolio.nl)",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def gql(query, variables=None, retries=8):
    """Run one query, return its `data`. Fails over between endpoints; a response with
    an `errors` entry counts as a failed attempt (GraphQL reports errors inside a 200)."""
    global rpc_index, _call_no
    body = json.dumps({"query": query, "variables": variables or {}},
                      separators=(",", ":")).encode()
    last_err = None
    ep_tries = 0          # opeenvolgende mislukte pogingen op het endpoint waar we nu staan

    def transient(why):
        """True = wacht even en probeer hetzelfde endpoint nog eens; False = geparkeerd."""
        nonlocal ep_tries
        ep_tries += 1
        if ep_tries < RATE_LIMIT_TRIES:
            wait = 2 ** ep_tries
            print(f"  {why} on {ep_host(rpc_index)}, waiting {wait}s...")
            sleep(wait)
            return True
        _ep_pause(rpc_index, f"blijft falen ({why}) na {ep_tries} pogingen")
        ep_tries = 0
        return False

    for _ in range(retries):
        _call_no += 1
        rpc_index = _ep_pick()
        try:
            out = _http_post(ENDPOINTS[rpc_index], body)
            if not isinstance(out, dict) or out.get("errors") or "data" not in out:
                msg = ((out.get("errors") or [{}])[0].get("message", "no data")
                       if isinstance(out, dict) else "unexpected response")
                raise ValueError(str(msg)[:200])
            _ep_pause_len.pop(rpc_index, None)
            return out["data"]
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in PARK_AT_ONCE:
                _ep_pause(rpc_index, f"gaf HTTP {e.code}")
                ep_tries = 0
            else:
                transient("Rate limited (429)" if e.code == 429 else f"HTTP {e.code}")
        except Exception as e:
            last_err = e
            transient(f"{type(e).__name__}: {str(e)[:80]}")
    raise RuntimeError(f"graphql query failed after {retries} attempts") from last_err


# ── BCS keys for dynamic-field lookups (no library needed) ──────────────────────
def bcs_string(s):
    b = s.encode("utf-8")
    n, out = len(b), bytearray()
    while True:                       # ULEB128 length prefix
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            break
    return bytes(out) + b


def bcs_coordinates(x, y):
    """iturf::Coordinates { x: u64, x_neg: bool, y: u64, y_neg: bool }."""
    return (struct.pack("<Q", abs(int(x))) + bytes([1 if int(x) < 0 else 0]) +
            struct.pack("<Q", abs(int(y))) + bytes([1 if int(y) < 0 else 0]))


def _b64(b):
    return base64.b64encode(b).decode()


# ── Objects ─────────────────────────────────────────────────────────────────────
def _obj(node):
    """GraphQL object node -> {address, type, json} or None."""
    if not node:
        return None
    c = ((node.get("asMoveObject") or {}).get("contents")) or {}
    return {"address": node.get("address"),
            "type": ((c.get("type") or {}).get("repr")) or "",
            "json": c.get("json")}


_Q_OBJECT = ("query Obj($a:SuiAddress!){object(address:$a){address "
             "asMoveObject{contents{type{repr} json}}}}")

def get_object(address):
    return _obj(gql(_Q_OBJECT, {"a": address}).get("object"))


_Q_MULTI = ("query Multi($k:[ObjectKey!]!){multiGetObjects(keys:$k){address "
            "asMoveObject{contents{type{repr} json}}}}")
_Q_MULTI_NOTYPE = ("query MultiNT($k:[ObjectKey!]!){multiGetObjects(keys:$k){address "
                   "asMoveObject{contents{json}}}}")

def multi_get(ids, with_type=True):
    """Objects for `ids` (<= MAX_IDS), aligned to the input; a missing object is None."""
    ids = list(ids)
    if len(ids) > MAX_IDS:
        raise ValueError(f"multi_get: {len(ids)} ids > {MAX_IDS}")
    if not ids:
        return []
    data = gql(_Q_MULTI if with_type else _Q_MULTI_NOTYPE,
               {"k": [{"address": i} for i in ids]})
    res = data.get("multiGetObjects") or []
    if len(res) != len(ids):
        raise ValueError(f"multiGetObjects returned {len(res)} of {len(ids)}")
    return [_obj(n) for n in res]


# ── Dynamic fields ──────────────────────────────────────────────────────────────
_Q_FIELDS = ("query Fields($a:SuiAddress!,$c:String){address(address:$a){"
             "dynamicFields(first:50,after:$c){pageInfo{hasNextPage endCursor} "
             "nodes{name{type{repr} json} value{__typename ... on MoveValue{json} "
             "... on MoveObject{address}}}}}}")

def dynamic_fields_page(parent, cursor=None):
    """One page of a parent's dynamic fields: ([{name_type, name, value}], has_next, cursor).
    `value` is the field's json for a plain dynamic field (a Table/TableVec entry is the
    id string of what it points to) or the object id for a dynamic OBJECT field."""
    df = (gql(_Q_FIELDS, {"a": parent, "c": cursor}).get("address") or {}).get("dynamicFields")
    if df is None:
        raise ValueError(f"no dynamicFields for {parent}")
    items = []
    for n in df["nodes"]:
        v = n.get("value") or {}
        items.append({
            "name_type": ((n.get("name") or {}).get("type") or {}).get("repr"),
            "name": (n.get("name") or {}).get("json"),
            "value": v.get("json") if "json" in v else v.get("address"),
        })
    pi = df["pageInfo"]
    return items, bool(pi["hasNextPage"]), pi.get("endCursor")


def _name_arg(type_tag, bcs):
    return {"type": type_tag, "bcs": _b64(bcs)}

_Q_FIELD = ("query Field($p:SuiAddress!,$n:DynamicFieldName!){address(address:$p){"
            "dynamicField(name:$n){address value{... on MoveValue{json}}}}}")

def dynamic_field(parent, type_tag, bcs):
    """The dynamic field named (type_tag, bcs bytes) under `parent`, or None when it
    does not exist -> {"address": <Field object id>, "value": <json>}."""
    f = (gql(_Q_FIELD, {"p": parent, "n": _name_arg(type_tag, bcs)}).get("address") or {}).get("dynamicField")
    if not f:
        return None
    return {"address": f.get("address"), "value": (f.get("value") or {}).get("json")}


_Q_RES = ("query Res($p:SuiAddress!,$c:DynamicFieldName!,$w:DynamicFieldName!){address(address:$p){"
          "cash:dynamicField(name:$c){address} weapon:dynamicField(name:$w){address}}}")

def resource_field_ids(profile_id):
    """{"cash": id, "weapon": id} for a player (a missing field is left out)."""
    d = (gql(_Q_RES, {"p": profile_id,
                      "c": _name_arg(STRING_TYPE, bcs_string("cash")),
                      "w": _name_arg(STRING_TYPE, bcs_string("weapon"))}).get("address") or {})
    return {k: d[k]["address"] for k in ("cash", "weapon") if d.get(k) and d[k].get("address")}


# ── Events (shaped like the old suix_queryEvents rows) ──────────────────────────
def iso_to_ms(ts):
    if not ts:
        return None
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _old_event(node):
    ms = iso_to_ms(node.get("timestamp"))
    c = node.get("contents") or {}
    return {
        "id": {"txDigest": (node.get("transaction") or {}).get("digest", "")},
        "type": ((c.get("type") or {}).get("repr")) or "",
        "parsedJson": c.get("json") or {},
        "timestampMs": str(ms) if ms is not None else None,
    }

_Q_EVENTS = ("query Ev($t:String!,$b:String){events(last:50,before:$b,filter:{type:$t}){"
             "pageInfo{hasPreviousPage startCursor} nodes{timestamp transaction{digest} "
             "contents{type{repr} json}}}}")

def query_events(event_type, cursor=None):
    """One page of events of `event_type`, NEWEST FIRST, in the shape the old
    suix_queryEvents returned: {"data": [...], "hasNextPage": bool, "nextCursor": str}.
    Pass the previous nextCursor to continue backwards in time."""
    ev = gql(_Q_EVENTS, {"t": event_type, "b": cursor}).get("events")
    if ev is None:
        raise ValueError(f"no events result for {event_type}")
    nodes = list(reversed(ev["nodes"]))     # GraphQL lists a `last` page oldest-first
    pi = ev["pageInfo"]
    return {"data": [_old_event(n) for n in nodes],
            "hasNextPage": bool(pi.get("hasPreviousPage")),
            "nextCursor": pi.get("startCursor")}


_Q_TX = ("query Tx($d:String!){transaction(digest:$d){digest effects{timestamp "
         "events{nodes{contents{type{repr} json}}}}}}")

def tx_events(digest):
    """Events of one transaction as [{"type", "parsedJson"}] (old getTransactionBlock shape).
    Raises when the transaction is unknown, so callers keep their 'keep on error' paths."""
    tx = gql(_Q_TX, {"d": digest}).get("transaction")
    if not tx:
        raise ValueError(f"transaction {digest} not found")
    evs = (((tx.get("effects") or {}).get("events")) or {}).get("nodes") or []
    return [{"type": ((e.get("contents") or {}).get("type") or {}).get("repr", ""),
             "parsedJson": (e.get("contents") or {}).get("json") or {}} for e in evs]


# ── Flat-json helpers shared by the parsers ─────────────────────────────────────
def vecmap(raw):
    """Flat VecMap {"contents": [{"key","value"}]} -> {key: int}."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for e in raw.get("contents") or []:
        if isinstance(e, dict) and e.get("key"):
            v = e.get("value")
            out[e["key"]] = int(v) if v is not None else 0
    return out


def resource_amount(field_json):
    """Raw (2^64-scaled) amount from a Field object's json: {"value": {"amount": ...}}."""
    v = (field_json or {}).get("value")
    return int(v.get("amount", 0) or 0) if isinstance(v, dict) else 0
