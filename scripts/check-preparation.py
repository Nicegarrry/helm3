#!/usr/bin/env python3
"""Validate preparation artifacts without installing or running product code."""
import hashlib
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[1]
source = root / "docs/design-source.md"
assert hashlib.sha256(source.read_bytes()).hexdigest() == "d203c57e88842b1413f9f8c20c10ac09c38da83a5e04eb70a12511f09bbcf337", "Human design changed without an explicit amendment"
sections = re.findall(r"^(\d+)\. ", source.read_text(), re.M)
assert set(map(str, range(1, 40))).issubset(sections), "Missing original design section"
tickets = json.loads((root / "docs/ticket-drafts.json").read_text())
by_key = {t["key"]: t for t in tickets}
assert len(by_key) == len(tickets), "Duplicate ticket key"
assert {"MAP", "APPROVAL", "HANDOFF"}.issubset(by_key), "Missing approval/handoff/outcome"
visited, active = set(), set()
def visit(key):
    assert key in by_key, f"Unknown dependency {key}"
    assert key not in active, f"Dependency cycle at {key}"
    if key in visited:
        return
    active.add(key)
    for dependency in by_key[key]["blocked_by"]:
        visit(dependency)
    active.remove(key)
    visited.add(key)
for ticket in tickets:
    assert all(ticket.get(k) for k in ("key", "title", "body", "area", "phase")), "Incomplete ticket"
    assert isinstance(ticket["blocked_by"], list)
    visit(ticket["key"])
for file in root.rglob("*.md"):
    if any(part in {".git", "node_modules", ".firecrawl", ".codebase-memory"} for part in file.parts):
        continue
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", file.read_text()):
        if "://" in target or target.startswith(("#", "mailto:")):
            continue
        target = target.split("#")[0].strip("<>")
        assert (file.parent / target).exists(), f"Broken local link in {file.relative_to(root)}: {target}"
print(f"Preparation valid: original source preserved; {len(tickets)} Map tickets; acyclic dependencies; local document links resolve.")
