# Jabber Message Store

> 36 nodes · cohesion 0.06

## Key Concepts

- **jabber_data_db.js** (21 connections) — `src/jabber_data_db.js`
- **jabber_migration.test.js** (9 connections) — `test/jabber_migration.test.js`
- **jabber_rooms.test.js** (8 connections) — `test/jabber_rooms.test.js`
- **extractField()** (4 connections) — `src/jabber_data_db.js`
- **parseJabberMessage()** (4 connections) — `src/jabber_data_db.js`
- **stripInvisible()** (3 connections) — `src/jabber_data_db.js`
- **escapeRegex()** (2 connections) — `src/jabber_data_db.js`
- **insertJabberMessage()** (2 connections) — `src/jabber_data_db.js`
- **getLatestDirectorMessage()** (1 connections) — `src/jabber_data_db.js`
- **getMessageById()** (1 connections) — `src/jabber_data_db.js`
- **getMessagesBySignature()** (1 connections) — `src/jabber_data_db.js`
- **getRecentMessages()** (1 connections) — `src/jabber_data_db.js`
- **getRoomMessages()** (1 connections) — `src/jabber_data_db.js`
- **getRoomOldestArchiveId()** (1 connections) — `src/jabber_data_db.js`
- **getRoomUnread()** (1 connections) — `src/jabber_data_db.js`
- **initJabberDb()** (1 connections) — `src/jabber_data_db.js`
- **markRoomRead()** (1 connections) — `src/jabber_data_db.js`
- **{ open }** (1 connections) — `src/jabber_data_db.js`
- **path** (1 connections) — `src/jabber_data_db.js`
- **sqlite3** (1 connections) — `src/jabber_data_db.js`
- **wipeJabberDb()** (1 connections) — `src/jabber_data_db.js`
- **assert** (1 connections) — `test/jabber_migration.test.js`
- **db** (1 connections) — `test/jabber_migration.test.js`
- **fs** (1 connections) — `test/jabber_migration.test.js`
- **{ open }** (1 connections) — `test/jabber_migration.test.js`
- *... and 11 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)

## Source Files

- `src/jabber_data_db.js`
- `test/jabber_migration.test.js`
- `test/jabber_rooms.test.js`

## Audit Trail

- EXTRACTED: 57 (70%)
- INFERRED: 24 (30%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*