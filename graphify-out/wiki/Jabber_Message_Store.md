# Jabber Message Store

> 26 nodes · cohesion 0.09

## Key Concepts

- **jabber_data_db.js** (24 connections) — `src/jabber_data_db.js`
- **jabber_rooms.test.js** (12 connections) — `test/jabber_rooms.test.js`
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
- **roomMsg()** (1 connections) — `test/jabber_rooms.test.js`
- **{ open }** (1 connections) — `src/jabber_data_db.js`
- **path** (1 connections) — `src/jabber_data_db.js`
- **sqlite3** (1 connections) — `src/jabber_data_db.js`
- **assert** (1 connections) — `test/jabber_rooms.test.js`
- **fs** (1 connections) — `test/jabber_rooms.test.js`
- **os** (1 connections) — `test/jabber_rooms.test.js`
- **path** (1 connections) — `test/jabber_rooms.test.js`
- *... and 1 more nodes in this community*

## Relationships

- [Demo Data Spec](Demo_Data_Spec.md) (3 shared connections)
- [Demo Calendar Feeds](Demo_Calendar_Feeds.md) (2 shared connections)
- [Fleet Ops Test](Fleet_Ops_Test.md) (2 shared connections)
- [Presence Worker Test](Presence_Worker_Test.md) (2 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [Demo Mode Test](Demo_Mode_Test.md) (1 shared connections)

## Source Files

- `src/jabber_data_db.js`
- `test/jabber_rooms.test.js`

## Audit Trail

- EXTRACTED: 29 (71%)
- INFERRED: 12 (29%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*