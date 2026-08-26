# Intel Widget

> 10 nodes · cohesion 0.22

## Key Concepts

- **Early Warning Intel Widget Window** (5 connections) — `src/html/intel-widget.html`
- **render() — compact intel rows** (4 connections) — `src/html/intel-widget.html`
- **tick() — 2s intel poll loop** (3 connections) — `src/html/intel-widget.html`
- **headerHtml()** (2 connections) — `src/shared/intel-row.js`
- **#iwList contact list container** (2 connections) — `src/html/intel-widget.html`
- **#iwStatus watcher status line** (2 connections) — `src/html/intel-widget.html`
- **paintStatus() — watcher state line** (2 connections) — `src/html/intel-widget.html`
- **Dashboard Widget Pop-out Window** (2 connections) — `src/html/widget-window.html`
- **#pwContent pushed widget HTML** (2 connections) — `src/html/widget-window.html`
- **Beehive comms channel** (2 connections) — `yaml/gsf_sigs.yaml`

## Relationships

- [Intel Row](Intel_Row.md) (3 shared connections)
- [FC Intel](FC_Intel.md) (1 shared connections)
- [Dashboard Widgets](Dashboard_Widgets.md) (1 shared connections)
- [Gsf Sigs](Gsf_Sigs.md) (1 shared connections)

## Source Files

- `src/html/intel-widget.html`
- `src/html/widget-window.html`
- `src/shared/intel-row.js`
- `yaml/gsf_sigs.yaml`

## Audit Trail

- EXTRACTED: 20 (77%)
- INFERRED: 4 (15%)
- AMBIGUOUS: 2 (8%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*