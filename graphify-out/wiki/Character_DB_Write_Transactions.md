# Character DB Write Transactions

> 12 nodes · cohesion 0.17

## Key Concepts

- **withTx()** (14 connections) — `src/character_info_db.js`
- **replaceAssets()** (2 connections) — `src/character_info_db.js`
- **replaceBlueprints()** (2 connections) — `src/character_info_db.js`
- **wipeAllAssets()** (2 connections) — `src/character_info_db.js`
- **replaceWalletJournal()** (2 connections) — `src/character_info_db.js`
- **replaceWalletTransactions()** (2 connections) — `src/character_info_db.js`
- **upsertMiningLedger()** (2 connections) — `src/character_info_db.js`
- **replaceLoyaltyPoints()** (2 connections) — `src/character_info_db.js`
- **replaceStandings()** (2 connections) — `src/character_info_db.js`
- **replaceSkills()** (2 connections) — `src/character_info_db.js`
- **upsertNpcStations()** (2 connections) — `src/character_info_db.js`
- **putCachedNames()** (2 connections) — `src/character_info_db.js`

## Relationships

- [Character Database](Character_Database.md) (12 shared connections)
- [Character Database (initCharacterDb)](Character_Database_%28initCharacterDb%29.md) (1 shared connections)
- [Character Database (upsertCharacterInfo)](Character_Database_%28upsertCharacterInfo%29.md) (1 shared connections)

## Source Files

- `src/character_info_db.js`

## Audit Trail

- EXTRACTED: 25 (69%)
- INFERRED: 11 (31%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*