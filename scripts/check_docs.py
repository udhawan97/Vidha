#!/usr/bin/env python3
"""Validate the documentation-only Vidha foundation without third-party tools."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent.parent
REQUIRED = (
    "README.md",
    "LICENSE",
    "AGENTS.md",
    "CONTEXT.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ".github/ISSUE_TEMPLATE/question.yml",
    ".github/ISSUE_TEMPLATE/security_contact.yml",
    ".github/workflows/docs.yml",
    "docs/product/PRODUCT_BRIEF.md",
    "docs/architecture/ARCHITECTURE.md",
    "docs/security/THREAT_MODEL.md",
    "docs/release/V1_RELEASE_GATES.md",
    "docs/public-surface/FACT_SHEET.md",
    "docs/public-surface/COVERAGE_LEDGER.md",
    "docs/research/GITHUB_COMPETITIVE_LANDSCAPE.md",
    "docs/FABLE_BUILD_PROMPT.md",
)
LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.MULTILINE)


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def github_heading_anchors(text: str) -> set[str]:
    """Return the GitHub-style anchors used by this repository's simple headings."""
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for heading in HEADING.findall(text):
        normalized = re.sub(r"<[^>]+>", "", heading)
        normalized = re.sub(r"[`*_~]", "", normalized).strip().lower()
        normalized = re.sub(r"[^\w\- ]", "", normalized, flags=re.UNICODE)
        normalized = re.sub(r"\s+", "-", normalized)
        duplicate = counts.get(normalized, 0)
        counts[normalized] = duplicate + 1
        anchors.add(normalized if duplicate == 0 else f"{normalized}-{duplicate}")
    return anchors


def main() -> int:
    errors: list[str] = []

    for relative in REQUIRED:
        if not (ROOT / relative).is_file():
            fail(f"missing required file: {relative}", errors)

    markdown_files = sorted(ROOT.rglob("*.md"))
    for path in markdown_files:
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        if not text.endswith("\n"):
            fail(f"missing final newline: {relative}", errors)
        if "/Users/" in text or "file://" in text:
            fail(f"private absolute path in Markdown: {relative}", errors)

        for raw_target in LINK.findall(text):
            target = raw_target.strip().split()[0].strip("<>")
            if not target or target.startswith(("http://", "https://", "mailto:")):
                continue
            file_target, _, raw_fragment = target.partition("#")
            file_target = unquote(file_target)
            resolved = (path if not file_target else path.parent / file_target).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                fail(f"link escapes repository in {relative}: {target}", errors)
                continue
            if not resolved.exists():
                fail(f"broken local link in {relative}: {target}", errors)
                continue
            fragment = unquote(raw_fragment).lower()
            if fragment and resolved.is_file() and resolved.suffix.lower() == ".md":
                anchors = github_heading_anchors(resolved.read_text(encoding="utf-8"))
                if fragment not in anchors:
                    fail(f"broken local anchor in {relative}: {target}", errors)

    adr_numbers: dict[str, Path] = {}
    for path in sorted((ROOT / "docs" / "adr").glob("[0-9][0-9][0-9][0-9]-*.md")):
        number = path.name[:4]
        if number in adr_numbers:
            fail(
                f"duplicate ADR number {number}: "
                f"{adr_numbers[number].relative_to(ROOT)} and {path.relative_to(ROOT)}",
                errors,
            )
        adr_numbers[number] = path

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"Documentation checks passed for {len(markdown_files)} Markdown files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
