# CI Workflow

> 12 nodes · cohesion 0.24

## Key Concepts

- **build-windows Job** (5 connections) — `.github/workflows/main.yml`
- **Full npm ci for native sqlite3 bindings** (4 connections) — `.github/workflows/ci.yml`
- **CI Unit Tests Job** (3 connections) — `.github/workflows/ci.yml`
- **CI Coverage Job** (3 connections) — `.github/workflows/ci.yml`
- **CI Build Matrix Job** (3 connections) — `.github/workflows/ci.yml`
- **Release Test Gate (lint + unit + e2e)** (3 connections) — `.github/workflows/main.yml`
- **build-mac Job** (3 connections) — `.github/workflows/main.yml`
- **Empty-Secret Warning For PRESENCE_URL and EVE_CLIENT_ID** (3 connections) — `.github/workflows/main.yml`
- **CI Pipeline (lint to build)** (2 connections) — `.github/workflows/ci.yml`
- **CI Lint Job** (2 connections) — `.github/workflows/ci.yml`
- **Always Declare shell: bash** (2 connections) — `.github/workflows/main.yml`
- **macOS Ad-hoc Signing (CSC_IDENTITY_AUTO_DISCOVERY false)** (1 connections) — `.github/workflows/main.yml`

## Relationships

- [Electron Main Process (Build and Release Workflow)](Electron_Main_Process_%28Build_and_Release_Workflow%29.md) (1 shared connections)
- [TODO](TODO.md) (1 shared connections)

## Source Files

- `.github/workflows/ci.yml`
- `.github/workflows/main.yml`

## Audit Trail

- EXTRACTED: 30 (88%)
- INFERRED: 4 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*