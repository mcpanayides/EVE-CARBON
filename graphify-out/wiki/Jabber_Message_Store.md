# Jabber Message Store

> 19 nodes · cohesion 0.13

## Key Concepts

- **jabber_data_db.js** (24 connections) — `src/jabber_data_db.js`
- **parseJabberMessage()** (5 connections) — `src/jabber_data_db.js`
- **extractField()** (4 connections) — `src/jabber_data_db.js`
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
- **wipeJabberDb()** (1 connections) — `src/jabber_data_db.js`
- **{ open }** (1 connections) — `src/jabber_data_db.js`
- **path** (1 connections) — `src/jabber_data_db.js`
- **sqlite3** (1 connections) — `src/jabber_data_db.js`

## Relationships

- [Demo Calendar Feeds](Demo_Calendar_Feeds.md) (2 shared connections)
- [Asset Valuation Test](Asset_Valuation_Test.md) (2 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [PI Tally Test](PI_Tally_Test.md) (1 shared connections)
- [Demo Mode Test](Demo_Mode_Test.md) (1 shared connections)

## Source Files

- `src/jabber_data_db.js`

## Audit Trail

- EXTRACTED: 18 (60%)
- INFERRED: 12 (40%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*