# Ci

> 7 nodes · cohesion 0.43

## Key Concepts

- **Full npm ci for native sqlite3 bindings** (4 connections) — `.github/workflows/ci.yml`
- **CI Build Matrix Job** (3 connections) — `.github/workflows/ci.yml`
- **CI Coverage Job** (3 connections) — `.github/workflows/ci.yml`
- **CI Unit Tests Job** (3 connections) — `.github/workflows/ci.yml`
- **Release Test Gate (lint + unit + e2e)** (3 connections) — `.github/workflows/main.yml`
- **CI Pipeline (lint to build)** (2 connections) — `.github/workflows/ci.yml`
- **CI Lint Job** (2 connections) — `.github/workflows/ci.yml`

## Relationships

- [Main](Main.md) (2 shared connections)

## Source Files

- `.github/workflows/ci.yml`
- `.github/workflows/main.yml`

## Audit Trail

- EXTRACTED: 17 (85%)
- INFERRED: 3 (15%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*