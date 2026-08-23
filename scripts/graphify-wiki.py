#!/usr/bin/env python3
"""Relabel graphify's communities and regenerate the committed wiki.

Run AFTER `graphify update .`. That command re-clusters, which reassigns every
community's integer id -- so the labels saved in .graphify_labels.json no longer
describe the same node sets and graphify silently falls back to naming each
community after its hub node. That fallback yields `main.js`, `assets.js`, and
for the minified Gridstack bundle, `x`, `s`, `_`, `v`. This script rebuilds the
names from things that survive renumbering, then applies them everywhere.

    python scripts/graphify-wiki.py            # regenerate
    python scripts/graphify-wiki.py --check    # regenerate, fail if it changed
    python scripts/graphify-wiki.py --lint     # check the committed wiki only

--check regenerates and exits 1 if the result differs from what is on disk; the
pre-push hook uses it to stop a push whose wiki is stale.

--lint inspects only the committed markdown -- no graph, no graphify install,
stdlib only -- so CI can run it on a bare checkout. CI cannot regenerate: a
fresh clone has no graphify-out/graph.json and no semantic cache, so it would
rebuild code-only and silently drop the ~230 doc/design/image nodes.

Deliberately does NOT re-cluster: `cluster-only` would renumber the communities
again and orphan the labels this script just wrote.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path("graphify-out")
WIKI = OUT / "wiki"

# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

# A distinctive member symbol names its whole community. Needed where one source
# file splits across several communities (fitting.js splits 6 ways, package.json 4,
# gridstack-all.js 4), which the dominant-file rule alone cannot tell apart.
# Every marker is asserted present and unique below, so a rename in the source
# fails the build loudly instead of silently degrading a name.
MARKER = {
    ".registerEngine()": "Gridstack Core & Initialisation",
    ".isIntercepted()": "Gridstack Geometry & Collision",
    ".simulateMouseEvent()": "Gridstack Touch & Drag-Drop",
    ".triggerEvent()": "Gridstack Events & Handlers",
    "_regionExits": "Galaxy Map State",
    "_layoutWormholeBlock()": "Galaxy Map Layout & Drawing",
    "_secColorModern()": "Map Colours & Modern Drawing",
    "_fitTraitRecords()": "Fitting Skills & Trait Engine",
    "_fitApplySnapshot()": "Fitting Browser & Persistence",
    "_fitDroneActiveBw()": "Fitting Drones & Stats Display",
    "_fitPlaceSubsystem()": "Fitting Slots & Module Placement",
    "_fitFighterTubeCaps()": "Fitting Fighters & Canvas Rings",
    "_healFailedDashboardWidgets()": "Dashboard Auto-Sync & Live Widgets",
    "_loadDashLayout()": "Dashboard Grid Layout & Popouts",
    "_esiGateWait()": "Main Process ESI & Cache Layer",
    "moonOreRows()": "Moon & Ore Calculators",
    "_bpPerfectRank()": "Blueprint Economics & Sorting",
    "_indSaveStructures()": "Industry Settings & Structures",
    "loadBlueprintLibrary()": "Blueprint Library UI",
    "withTx()": "Character DB Write Transactions",
    "The Accent-Is-A-Role Rule": "DESIGN Palette & Preboot Rules",
    "@xmpp/client": "NPM Runtime Dependencies",
    "@electron/rebuild": "NPM Dev Dependencies",
    "extraResources": "Electron Builder Config",
    "allowScripts": "Package Manifest",
}

# Keyed on the community's DOMINANT SOURCE FILE, never on its id.
#
# Files that ALSO appear in MARKER above are still listed here on purpose. A
# re-cluster changes how many communities a big file splits into, so there are
# usually more siblings than markers; without a file-level entry those unmarked
# siblings fall through to titleise() and land on "Gridstack All" or "Map".
# The entry gives them a real base name, and dedup appends their hub symbol.
NAME = {
    # src/index.html would titleise to "Index" -- see RESERVED below.
    "index": "App Shell Markup",
    "gridstack-all": "Gridstack Vendor Library",
    "map": "Galaxy Map",
    "package": "Package Manifest",
    "alliancetournament": "Alliance Tournament",
    "lpstore": "LP Store",
    "ics_parse": "ICS Calendar Parsing",
    "ci": "CI Workflow",
    "main": "Electron Main Process",
    "assets": "Assets Table & Virtualisation",
    "skills": "Skills & Training Queue",
    "jabber": "Jabber Chat Client",
    "ui": "UI Shell & Theming",
    "jump-planner": "Jump Route Planner",
    "fleet_aar": "Fleet After-Action Report",
    "calendar": "Calendar & Events",
    "sde_fetch": "SDE Fetch & Build",
    "build-sde-from-jsonl": "SDE Build Pipeline",
    "mail": "EVE Mail",
    "blueprints": "Blueprint Library",
    "fc": "Fleet Commander Core",
    "intel_parser": "Intel Channel Parser",
    "jabber_ipc": "Jabber XMPP IPC",
    "jabber_rooms": "Jabber Chat Rooms",
    "jabber_data_db": "Jabber Message Store",
    "dashboard": "Dashboard Widgets",
    "character_info_db": "Character Database",
    "fitting": "Fitting Simulator",
    "fitting_sim.test": "Fitting Simulator Tests",
    "request_broker": "HTTP Request Broker",
    "demo_fixtures": "Demo Mode Fixtures",
    "salvage": "Salvage Calculator",
    "locator": "Station & Structure Locator",
    "asset_index": "Asset Index Schema",
    "asset_valuation": "Asset Valuation",
    "killboard": "Killboard",
    "mining": "Mining Ledger",
    "trading": "Market Trading",
    "file_log": "File Logging",
    "planetary-interaction": "Planetary Interaction",
    "materials": "Materials & Reprocessing",
    "cost-index": "Industry Cost Index",
    "characters": "Character Sheets",
    "region_layout": "Region Layout Engine",
    "galaxy_layout": "Galaxy Layout Engine",
    "fleet_ops": "Fleet Op Records",
    "fleet_teams": "Battle Report Sides",
    "esi": "ESI Client",
    "preload": "Preload Bridge",
    "utils": "Shared UI Utilities",
    "pageLoader": "Page Loader",
    "updater_ipc": "Auto Updater",
    "accounts_ipc": "Account & Auth IPC",
    "industry": "Industry Jobs",
    "reactions": "Reaction Chains",
    "contracts": "Contracts",
    "wallet": "Wallet & Journal",
    "market": "Market Orders",
    "notifications": "Notifications",
    "settings": "Settings",
    "theme": "Theme Engine",
}

# The wiki writes one file per community, so a community named "Index" produces
# Index.md -- the SAME FILE as the wiki's own index.md entry point on Windows and
# macOS. One clobbers the other, and every "back to index" link 404s on GitHub,
# where paths ARE case-sensitive. Never allow it.
RESERVED = {"index"}

SMALL = {"js", "ipc", "db", "sde", "pi", "fc", "ui", "esi", "lp", "fw", "aar",
         "api", "id", "url", "css", "http"}


def titleise(stem: str) -> str:
    words = [w.upper() if w.lower() in SMALL else (w[:1].upper() + w[1:])
             for w in re.split(r"[-_.]+", stem) if w]
    return " ".join(words)[:44] or "Misc"


def build_labels(nodes_by_cid: dict[str, list[dict]], key_set) -> dict[str, str]:
    sizes = {cid: len(ns) for cid, ns in nodes_by_cid.items()}
    files: dict[str, Counter] = {}
    marks: dict[str, set] = {}
    for cid, ns in nodes_by_cid.items():
        for n in ns:
            lab = n.get("label")
            if lab in MARKER:
                marks.setdefault(lab, set()).add(cid)
            src = n.get("source_file") or ""
            if src:
                files.setdefault(cid, Counter())[Path(src).stem] += 1

    ambiguous = {k: sorted(v) for k, v in marks.items() if len(v) != 1}
    if ambiguous:
        die(f"marker(s) not unique to one community: {ambiguous}")
    absent = sorted(set(MARKER) - set(marks))
    if absent:
        die(f"marker(s) no longer in the graph (renamed or deleted?): {absent}\n"
            f"       Update MARKER in {__file__} to match the current source.")
    by_marker = {next(iter(v)): MARKER[k] for k, v in marks.items()}

    labels: dict[str, str] = {}
    for cid in key_set:
        if cid in by_marker:
            labels[cid] = by_marker[cid]
            continue
        counts = files.get(cid)
        stem = counts.most_common(1)[0][0] if counts else ""
        if stem in NAME:
            labels[cid] = NAME[stem]
        elif stem and stem.lower() not in RESERVED:
            labels[cid] = titleise(stem)
        else:
            labels[cid] = f"Community {cid}"

    # Distinct names, compared case-INSENSITIVELY: Todo.md and TODO.md are also
    # the same file on Windows and macOS.
    groups: dict[str, list[str]] = defaultdict(list)
    for cid, nm in labels.items():
        groups[nm.lower()].append(cid)
    for ids in groups.values():
        if len(ids) < 2:
            continue
        ids.sort(key=lambda c: -sizes.get(c, 0))
        base = labels[ids[0]]
        for cid in ids[1:]:
            hub = max(nodes_by_cid[cid], key=lambda n: n.get("degree", 0))
            tag = re.sub(r"[.](js|ts|py|md)$", "", str(hub.get("label") or cid))
            # Strip parens/hash so the suffix cannot leave the label unbalanced.
            tag = re.sub(r"[()#:]", " ", tag)
            tag = re.sub(r"[ .]+", " ", tag).strip()[:30].strip()
            labels[cid] = f"{base} ({tag})" if tag else f"{base} [{cid}]"
    return labels


# ---------------------------------------------------------------------------
# Apply + verify
# ---------------------------------------------------------------------------

def die(msg: str) -> None:
    print(f"graphify-wiki: {msg}", file=sys.stderr)
    sys.exit(1)


def reexec_into_graphify_python() -> None:
    """Re-run under the interpreter that actually has graphify installed.

    graphify is typically installed as a uv/pipx tool, so it lives in its own
    venv and is NOT importable from a bare `python`. graphify records the right
    interpreter in graphify-out/.graphify_python; without this, `npm run
    graphify:sync` dies on ModuleNotFoundError depending on how it was invoked.
    """
    try:
        import graphify  # noqa: F401
        return
    except ImportError:
        pass

    marker = OUT / ".graphify_python"
    if not marker.exists():
        die("graphify is not importable and graphify-out/.graphify_python is "
            "missing.\n       Install it with: uv tool install graphifyy")
    interpreter = marker.read_text(encoding="utf-8").strip()
    if not interpreter or not Path(interpreter).exists():
        die(f"recorded interpreter does not exist: {interpreter!r}\n"
            "       Re-run `graphify update .` to refresh it.")

    import subprocess
    # Guard against a loop if that interpreter also lacks graphify.
    env = dict(os.environ, GRAPHIFY_WIKI_REEXEC="1")
    if os.environ.get("GRAPHIFY_WIKI_REEXEC"):
        die(f"{interpreter} cannot import graphify either -- reinstall graphifyy.")
    sys.exit(subprocess.call([interpreter, str(Path(__file__).resolve()), *sys.argv[1:]],
                             env=env))


def _git_wiki_files() -> set[str] | None:
    """The wiki filenames git has, or None if git is unavailable.

    Git's view is the one that ships, and on Windows it can disagree with the
    working tree. core.ignorecase=true means git does not notice a PURE CASE
    rename, so when a community is relabelled TODO where it used to be Todo,
    the file on disk becomes TODO.md while the index still says Todo.md.
    Every local check passes -- Windows resolves either -- and then CI checks
    out Todo.md on Linux and three links to TODO.md 404. Look at git, not glob.
    """
    import subprocess
    try:
        out = subprocess.run(["git", "ls-files", "-z", "--", str(WIKI)],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return {Path(p).name for p in out.stdout.split("\0") if p.strip()} or None


def repair_git_case() -> None:
    """Re-point the index at the on-disk spelling after a pure case rename."""
    tracked = _git_wiki_files()
    if not tracked:
        return
    disk = {p.name for p in WIKI.glob("*.md")}
    by_lower = {n.lower(): n for n in disk}
    import subprocess
    for name in sorted(tracked - disk):
        real = by_lower.get(name.lower())
        if not real:
            continue  # genuinely gone; a normal `git add -A` records the delete
        subprocess.run(["git", "mv", "--force", str(WIKI / name), str(WIKI / real)],
                       capture_output=True, text=True)
        print(f"graphify-wiki: repaired tracked filename case {name} -> {real}")


def lint_wiki(use_git: bool = True) -> list[str]:
    """Checks that need only the committed markdown -- no graph, stdlib only.

    This is what CI runs. It catches the failure that actually bit us: a
    community named "Index" produces Index.md, which IS wiki/index.md on
    Windows and macOS, so one clobbers the other and every "back to index"
    link 404s on GitHub, where paths are case-sensitive.
    """
    problems = []
    if not WIKI.exists():
        return [f"{WIKI}/ does not exist"]

    disk = {p.name for p in WIKI.glob("*.md")}
    if not disk:
        return [f"{WIKI}/ contains no markdown"]

    # Which spelling ships? For a committed wiki (CI, a bare checkout) that is
    # git's. Straight after regeneration it is the working tree's: the new
    # articles are not tracked yet, so resolving links against git would call
    # every one of them missing. The case-drift check below runs either way,
    # and regeneration repairs drift before it can reach git.
    tracked = _git_wiki_files() if use_git else None
    files = tracked or disk
    if tracked:
        lower = {t.lower() for t in tracked}
        drift = sorted(n for n in disk - tracked if n.lower() in lower)
        if drift:
            problems.append(
                f"git tracks a different case than the file on disk for {drift} "
                "-- a pure case rename git missed; run: npm run graphify:sync")

    if "index.md" not in files:
        problems.append("wiki/index.md is missing (a community article clobbered it?)")
    case_clash = [k for k, c in Counter(f.lower() for f in files).items() if c > 1]
    if case_clash:
        problems.append(f"wiki filenames collide case-insensitively: {case_clash}")

    broken = []
    for p in sorted(WIKI.glob("*.md")):
        for m in re.finditer(r"]\(([^)]+)\)", p.read_text(encoding="utf-8")):
            target = m.group(1)
            if target.startswith(("http://", "https://", "#")):
                continue
            name = urllib.parse.unquote(target.split("#")[0])
            if name and name not in files:
                broken.append(f"{p.name} -> {target}")
    if broken:
        problems.append(f"{len(broken)} broken internal link(s), e.g. {broken[:3]}")
    return problems


def verify(labels: dict[str, str], graph_nodes: list[dict]) -> None:
    """Fail loudly rather than commit a broken wiki."""
    # use_git=False: this runs immediately after regeneration, when the new
    # articles exist on disk but are not yet tracked.
    problems = list(lint_wiki(use_git=False))

    lower = Counter(v.lower() for v in labels.values())
    dupes = [k for k, c in lower.items() if c > 1]
    if dupes:
        problems.append(f"labels collide case-insensitively: {dupes[:5]}")
    reserved = [v for v in labels.values() if v.lower() in RESERVED]
    if reserved:
        problems.append(f"label uses a reserved wiki filename: {reserved}")

    stale = sum(1 for n in graph_nodes
                if n.get("community") is not None
                and n.get("community_name") != labels[str(n["community"])])
    if stale:
        problems.append(f"{stale} node(s) in graph.json carry a stale community_name")

    if problems:
        die("verification failed:\n       - " + "\n       - ".join(problems))
    print(f"graphify-wiki: verified {len(list(WIKI.glob('*.md')))} files, "
          f"{len(labels)} communities, 0 broken links")


def main() -> None:
    if "--lint" in sys.argv:
        problems = lint_wiki()
        if problems:
            die("wiki lint failed:\n       - " + "\n       - ".join(problems)
                + "\n       Regenerate with: npm run graphify:sync")
        n = len(list(WIKI.glob("*.md")))
        print(f"graphify-wiki: wiki lint passed ({n} files, links all resolve)")
        return

    check_only = "--check" in sys.argv
    if not (OUT / "graph.json").exists():
        die("graphify-out/graph.json not found -- run `graphify update .` first.")

    reexec_into_graphify_python()

    # Re-extract BEFORE relabelling. Relabelling a stale graph produces a wiki
    # that describes the previous revision, and the next `graphify update .`
    # then yields a different one -- the two fight each other forever.
    if "--no-update" not in sys.argv:
        import subprocess
        # AST-only, no LLM, no API cost; leaves outputs untouched when the
        # code-graph topology has not changed.
        r = subprocess.run([sys.executable, "-m", "graphify", "update", "."],
                           capture_output=True, text=True)
        if r.returncode != 0:
            die("`graphify update .` failed:\n" + (r.stderr or r.stdout).strip())

    from networkx.readwrite import json_graph as jg
    from graphify.analyze import god_nodes, suggest_questions, surprising_connections
    from graphify.cluster import score_all
    from graphify.report import generate

    raw = json.loads((OUT / "graph.json").read_text(encoding="utf-8"))
    G = jg.node_link_graph(raw, edges="links")

    nodes_by_cid: dict[str, list[dict]] = defaultdict(list)
    for n in raw["nodes"]:
        if n.get("community") is not None:
            nodes_by_cid[str(n["community"])].append(n)
    if not nodes_by_cid:
        die("graph.json has no community assignments -- run `graphify update .` first.")

    labels = build_labels(nodes_by_cid, sorted(nodes_by_cid, key=int))

    if check_only:
        before = snapshot()
        apply_all(raw, G, labels, jg, score_all, god_nodes,
                  surprising_connections, suggest_questions, generate)
        verify(labels, raw["nodes"])
        if snapshot() != before:
            die("wiki is out of date -- run `python scripts/graphify-wiki.py`.")
        print("graphify-wiki: wiki is up to date")
        return

    apply_all(raw, G, labels, jg, score_all, god_nodes,
              surprising_connections, suggest_questions, generate)
    verify(labels, raw["nodes"])


def snapshot() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in WIKI.glob("*.md")} \
        if WIKI.exists() else {}


def apply_all(raw, G, labels, jg, score_all, god_nodes,
              surprising_connections, suggest_questions, generate) -> None:
    int_labels = {int(k): v for k, v in labels.items()}

    # Communities come from the graph's own node attributes, NOT a fresh cluster()
    # call. Largest-first, because the report renders navigation in dict order.
    unsorted: dict[int, list[str]] = defaultdict(list)
    for nid, d in G.nodes(data=True):
        if d.get("community") is not None:
            unsorted[int(d["community"])].append(str(nid))
    communities = dict(sorted(unsorted.items(), key=lambda kv: -len(kv[1])))

    # community_name is what `graphify query` prints for every node.
    for n in raw["nodes"]:
        if n.get("community") is not None:
            n["community_name"] = int_labels[int(n["community"])]
    (OUT / "graph.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    (OUT / ".graphify_labels.json").write_text(
        json.dumps(labels, indent=1, ensure_ascii=False), encoding="utf-8")

    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, int_labels)

    # Carry the corpus figures over from the report being replaced: this pass
    # relabels, it does not re-detect, so fresh counts would be invented.
    detection = {"warning": "relabel pass -- file stats not available"}
    report_path = OUT / "GRAPH_REPORT.md"
    if report_path.exists():
        m = re.search(r"- ([\d,]+) files .* ~([\d,]+) words",
                      report_path.read_text(encoding="utf-8"))
        if m:
            detection = {"total_files": int(m.group(1).replace(",", "")),
                         "total_words": int(m.group(2).replace(",", ""))}

    report_path.write_text(
        generate(G, communities, cohesion, int_labels, gods, surprises, detection,
                 {"input": 0, "output": 0}, "EVE-Carbon",
                 suggested_questions=questions, min_community_size=3,
                 built_at_commit=raw.get("built_at_commit")),
        encoding="utf-8")
    (OUT / ".graphify_analysis.json").write_text(json.dumps({
        "communities": {str(k): v for k, v in communities.items()},
        "cohesion": {str(k): v for k, v in cohesion.items()},
        "gods": gods, "surprises": surprises, "questions": questions,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    # Export into a temp dir first: `export wiki` clears its target, so a failure
    # partway through would leave the committed wiki half-deleted.
    from graphify.wiki import to_wiki
    with tempfile.TemporaryDirectory() as tmp:
        staged = Path(tmp) / "wiki"
        n = to_wiki(G, communities, str(staged), community_labels=int_labels,
                    cohesion=cohesion, god_nodes_data=gods)
        if WIKI.exists():
            shutil.rmtree(WIKI)
        shutil.copytree(staged, WIKI)
    # A relabel can change only a filename's case (Todo -> TODO). Windows git
    # will not notice on its own, and the stale index entry is what CI gets.
    repair_git_case()
    print(f"graphify-wiki: {n} articles written to {WIKI}/")


if __name__ == "__main__":
    main()
