"""Regenerate/check the document bundle using only the Python standard library."""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MERGED = ROOT / "合并版规范.md"
MANIFEST = ROOT / "MANIFEST-v1.1.json"


def relative(path):
    return path.relative_to(ROOT).as_posix()


def bundle_files():
    return sorted(
        (p for p in ROOT.rglob("*") if p.is_file()
         and "__pycache__" not in p.parts and p != MANIFEST),
        key=relative,
    )


def documents():
    def order(path):
        name = relative(path)
        group = (0 if name == "README.md" else
                 1 if re.match(r"\d\d-", name) else
                 2 if name.startswith("engineering/") else 3)
        return group, name
    return sorted((p for p in bundle_files()
                   if p.suffix == ".md" and p != MERGED), key=order)


def merged_text():
    docs = documents()
    artifacts = [p for p in bundle_files()
                 if relative(p).startswith(("contracts/", "examples/"))
                 or relative(p) == "engineering/MODULE-MATRIX.csv"]
    sources = docs + artifacts
    sections = [
        "# SemiconFab Next — v1.1 完整架构与工程规范（合并版）",
        "> 自动生成；逐文件规范为编辑源。包含全部规范、审阅记录及参考工件；"
        "不代表应用已实现或通过工业认证。\n> 更新：2026-10-23；"
        "运行 `python tools/maintain_docs.py --write` 同步。",
        "## 目录",
        "\n".join(f"- [{relative(p)}](#bundle-{i:03d})"
                  for i, p in enumerate(sources, 1)),
    ]
    languages = {".proto": "protobuf", ".json": "json", ".sql": "sql",
                 ".ts": "typescript", ".csv": "csv"}
    for i, path in enumerate(sources, 1):
        content = path.read_text(encoding="utf-8").rstrip()
        if path.suffix != ".md":
            fence = "`" * max(3, max((len(m.group()) for m in
                                     re.finditer(r"`+", content)), default=0) + 1)
            content = f"{fence}{languages.get(path.suffix, 'text')}\n{content}\n{fence}"
        else:
            # Keep local links valid when a nested source is moved to bundle root.
            def rebase(match):
                target = match.group(2)
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    return match.group(0)
                resolved = (path.parent / unquote(parsed.path)).resolve()
                try:
                    rebased = resolved.relative_to(ROOT).as_posix()
                except ValueError:
                    return match.group(0)
                suffix = ("?" + parsed.query if parsed.query else "")
                suffix += "#" + parsed.fragment if parsed.fragment else ""
                return match.group(1) + rebased + suffix + ")"
            content = re.sub(r"(\[[^\]\n]+\]\()([^\s)]+)\)", rebase, content)
        sections.append(f'---\n\n<a id="bundle-{i:03d}"></a>\n\n'
                        f'<!-- Source: {relative(path)} -->\n\n'
                        f'# 文件：`{relative(path)}`\n\n{content}')
    return "\n\n".join(sections) + "\n"


def manifest_data():
    files = bundle_files()
    return {
        "name": "SemiconFab Next Engineering Specifications",
        "version": "1.1",
        "revision": "2026-10-23-review.1",
        "baseline_date": "2026-10-23",
        "file_count_without_manifest": len(files),
        "module_count": len(list((ROOT / "engineering/modules").glob("M*.md"))),
        "purpose": "Design and reference artifacts; not executable application or industrial certification.",
        "historical_manifests": ["BASELINE-MANIFEST-v1.0.json"],
        "generated_by": "tools/maintain_docs.py",
        "files": [{"path": relative(p), "bytes": p.stat().st_size,
                   "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                  for p in files],
    }


def check():
    errors = []
    for path in ROOT.rglob("*.json"):
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            errors.append(f"{relative(path)}: {exc}")
    if not MERGED.exists() or MERGED.read_bytes() != merged_text().encode("utf-8"):
        errors.append("合并版规范.md is out of date")
    try:
        if json.loads(MANIFEST.read_text(encoding="utf-8")) != manifest_data():
            errors.append("MANIFEST-v1.1.json does not match current files")
    except (OSError, ValueError) as exc:
        errors.append(f"MANIFEST-v1.1.json: {exc}")

    modules = list((ROOT / "engineering/modules").glob("M*.md"))
    expected = {f"M{i:02d}" for i in range(1, 19)}
    with (ROOT / "engineering/MODULE-MATRIX.csv").open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))
    if (len(modules) != 18 or {p.name[:3] for p in modules} != expected
            or len(rows) != 18 or {r["id"] for r in rows} != expected):
        errors.append("module documents and MODULE-MATRIX.csv must contain M01 through M18 exactly once")

    definitions = (ROOT / "12-VERIFICATION-ACCEPTANCE.md").read_text(encoding="utf-8")
    definitions += (ROOT / "06-SHARED-RESOURCE-MODES.md").read_text(encoding="utf-8")
    case_ids = set(re.findall(r"\| ((?:TEST-P0|SHARED)-\d{3}) \|", definitions))
    requirements = set(re.findall(r"\| (REQ-\d{3}) \|",
        (ROOT / "01-SCOPE-REQUIREMENTS.md").read_text(encoding="utf-8")))
    matrix = (ROOT / "14-TRACEABILITY-REGISTER.md").read_text(encoding="utf-8")
    if requirements != set(re.findall(r"\| (REQ-\d{3}) ", matrix)):
        errors.append("requirement traceability matrix is incomplete")
    links = 0
    for path in documents() + [MERGED]:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for case in re.findall(r"\b(?:TEST-P0|SHARED)-\d{3}\b", text):
            if case not in case_ids:
                errors.append(f"{relative(path)}: undefined acceptance case {case}")
        for target in re.findall(r"\[[^\]\n]+\]\(([^\s)]+)\)", text):
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            links += 1
            if not (path.parent / unquote(parsed.path)).exists():
                errors.append(f"{relative(path)}: missing link target {target}")
    if errors:
        print("\n".join("FAIL: " + error for error in errors))
        return 1
    print(f"PASS: {len(documents())} source Markdown files, 18 modules, "
          f"{len(requirements)} requirements, {len(case_ids)} acceptance case IDs, "
          f"{links} local links; merged content and "
          f"{len(bundle_files())} manifest entries match.")
    print("Scope: document integrity only; no application, database or GPU runtime verification.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="regenerate merge/manifest, then check")
    mode.add_argument("--check", action="store_true", help="read-only verification (default)")
    args = parser.parse_args()
    if args.write:
        MERGED.write_bytes(merged_text().encode("utf-8"))
        MANIFEST.write_bytes((json.dumps(manifest_data(), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return check()


if __name__ == "__main__":
    sys.exit(main())
