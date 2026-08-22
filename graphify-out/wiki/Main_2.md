# Main

> 15 nodes · cohesion 0.15

## Key Concepts

- **build-windows Job** (5 connections) — `.github/workflows/main.yml`
- **update-docs Job** (4 connections) — `.github/workflows/update-docs.yml`
- **Build and Release Workflow** (3 connections) — `.github/workflows/main.yml`
- **build-mac Job** (3 connections) — `.github/workflows/main.yml`
- **Empty-Secret Warning For PRESENCE_URL and EVE_CLIENT_ID** (3 connections) — `.github/workflows/main.yml`
- **Release Notes Are The Changelog Section** (3 connections) — `CHANGELOG.md`
- **PRESENCE_URL Secret (unset disables the counter silently)** (3 connections) — `infra/presence-worker/README.md`
- **Extract Changelog Section For Tag** (2 connections) — `.github/workflows/main.yml`
- **Always Declare shell: bash** (2 connections) — `.github/workflows/main.yml`
- **Auto-update Docs Workflow** (2 connections) — `.github/workflows/update-docs.yml`
- **Fail-If-Any-Doc-Missing Gate** (2 connections) — `.github/workflows/update-docs.yml`
- **macOS Ad-hoc Signing (CSC_IDENTITY_AUTO_DISCOVERY false)** (1 connections) — `.github/workflows/main.yml`
- **Least-Privilege Workflow Permissions** (1 connections) — `.github/workflows/main.yml`
- **OpenAI-Compatible Docs Backend (GitHub Models Retired)** (1 connections) — `.github/workflows/update-docs.yml`
- **CRITICAL UPDATE Marker** (1 connections) — `CHANGELOG.md`

## Relationships

- [Ci](Ci.md) (2 shared connections)
- [UI](UI.md) (1 shared connections)
- [Readme](Readme.md) (1 shared connections)

## Source Files

- `.github/workflows/main.yml`
- `.github/workflows/update-docs.yml`
- `CHANGELOG.md`
- `infra/presence-worker/README.md`

## Audit Trail

- EXTRACTED: 32 (89%)
- INFERRED: 4 (11%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*