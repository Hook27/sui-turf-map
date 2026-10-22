"""
Offline stand-in for the Sui GraphQL endpoint, backed by tests/fixtures/world.json.

`FakeChain.post(url, body)` has the signature of sui_graphql._http_post and answers the
operations sui_graphql.py sends (dispatch on the operation name in the query), with the
same semantics as the real service: pages of at most 50 (the fake pages smaller on
purpose, to exercise cursors), `last`/`before` event paging that lists a page
oldest-first, null for a missing object, a 5000-byte payload limit, and an `errors`
entry inside a 200 response for a bad query.
"""

import base64, json, os, re

import sui_graphql as sg

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD_PATH = os.path.join(HERE, "fixtures", "world.json")


def load_world():
    with open(WORLD_PATH, encoding="utf-8") as fh:
        return json.load(fh)


class FakeChain:
    def __init__(self, world, field_page=25, event_page=20, fail=None):
        self.w = world
        self.field_page = field_page      # real max is 50; smaller forces multi-page walks
        self.event_page = event_page
        self.calls = []                   # (url, operation, variables)
        self.fail = fail or {}            # operation -> exception to raise instead of answering

    # ── transport ─────────────────────────────────────────────────────────────
    def post(self, url, body):
        if len(body) > 5000:
            return {"errors": [{"message": f"Query payload too large: {len(body)}B > 5000B"}]}
        req = json.loads(body)
        m = re.match(r"\s*query\s+(\w+)", req["query"])
        op = m.group(1) if m else "?"
        self.calls.append((url, op, req.get("variables") or {}))
        if op in self.fail:
            raise self.fail[op]
        handler = getattr(self, "op_" + op, None)
        if handler is None:
            return {"errors": [{"message": f"unknown operation {op}"}]}
        return {"data": handler(req.get("variables") or {})}

    def count(self, op):
        return sum(1 for _, o, _ in self.calls if o == op)

    # ── objects ───────────────────────────────────────────────────────────────
    def _node(self, addr, with_type=True):
        o = self.w["objects"].get(addr)
        if o is None:
            return None
        contents = {"json": o["json"]}
        if with_type:
            contents["type"] = {"repr": o["type"]}
        return {"address": addr, "asMoveObject": {"contents": contents}}

    def op_Obj(self, v):
        return {"object": self._node(v["a"])}

    def op_Multi(self, v):
        return {"multiGetObjects": [self._node(k["address"]) for k in v["k"]]}

    def op_MultiNT(self, v):
        return {"multiGetObjects": [self._node(k["address"], False) for k in v["k"]]}

    # ── dynamic fields ────────────────────────────────────────────────────────
    def op_Fields(self, v):
        entries = self.w["fields"].get(v["a"], [])
        start = int(v["c"]) if v.get("c") else 0
        chunk = entries[start:start + self.field_page]
        end = start + len(chunk)
        nodes = []
        for e in chunk:
            val = {"__typename": "MoveValue", "json": e["value"]}
            nodes.append({"name": {"type": {"repr": e["name_type"]}, "json": e["name"]}, "value": val})
        return {"address": {"dynamicFields": {
            "pageInfo": {"hasNextPage": end < len(entries), "endCursor": str(end)}, "nodes": nodes}}}

    def op_Res(self, v):
        ids = self.w["field_lookup"].get(v["p"], {})
        want = {"cash": v["c"]["bcs"], "weapon": v["w"]["bcs"]}
        # the names must be the BCS of "cash" / "weapon" — assert the request is well formed
        assert want["cash"] == base64.b64encode(sg.bcs_string("cash")).decode(), want
        assert want["weapon"] == base64.b64encode(sg.bcs_string("weapon")).decode(), want
        return {"address": {k: ({"address": ids[k]} if k in ids else None) for k in ("cash", "weapon")}}

    def op_Field(self, v):
        return {"address": {"dynamicField": None}}

    # ── events ────────────────────────────────────────────────────────────────
    def op_Ev(self, v):
        events = self.w["events"].get(v["t"], [])          # oldest first
        end = int(v["b"]) if v.get("b") else len(events)   # `before` cursor = index
        start = max(0, end - self.event_page)
        nodes = [{
            "timestamp": e["timestamp"], "transaction": {"digest": e["digest"]},
            "contents": {"type": {"repr": e["type"]}, "json": e["json"]},
        } for e in events[start:end]]
        return {"events": {"pageInfo": {"hasPreviousPage": start > 0, "startCursor": str(start)},
                           "nodes": nodes}}

    def op_Tx(self, v):
        evs = self.w["tx_events"].get(v["d"])
        if evs is None:
            return {"transaction": None}
        nodes = [{"contents": {"type": {"repr": e["type"]}, "json": e["parsedJson"]}} for e in evs]
        return {"transaction": {"digest": v["d"], "effects": {"timestamp": None, "events": {"nodes": nodes}}}}
