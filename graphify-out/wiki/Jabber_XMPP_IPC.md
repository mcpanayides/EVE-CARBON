# Jabber XMPP IPC

> 32 nodes · cohesion 0.14

## Key Concepts

- **jabber_ipc.js** (40 connections) — `src/jabber_ipc.js`
- **registerJabberHandlers()** (27 connections) — `src/jabber_ipc.js`
- **parseMamResult()** (8 connections) — `src/jabber_ipc.js`
- **getXmppClient()** (6 connections) — `src/jabber_ipc.js`
- **startBeehiveRecheck()** (5 connections) — `src/jabber_ipc.js`
- **parseOccupantPresence()** (5 connections) — `src/jabber_ipc.js`
- **broadcastToRenderers()** (5 connections) — `src/jabber_ipc.js`
- **updateBeehiveStatus()** (4 connections) — `src/jabber_ipc.js`
- **joinBeehiveRoom()** (4 connections) — `src/jabber_ipc.js`
- **bareJid()** (4 connections) — `src/jabber_ipc.js`
- **nickOf()** (4 connections) — `src/jabber_ipc.js`
- **mamNamespaceFrom()** (4 connections) — `src/jabber_ipc.js`
- **delayStamp()** (4 connections) — `src/jabber_ipc.js`
- **isUnstyled()** (3 connections) — `src/jabber_ipc.js`
- **resetBeehiveStatus()** (3 connections) — `src/jabber_ipc.js`
- **stopBeehiveRecheck()** (3 connections) — `src/jabber_ipc.js`
- **sendRoomJoin()** (3 connections) — `src/jabber_ipc.js`
- **sendRoomLeave()** (3 connections) — `src/jabber_ipc.js`
- **occupantSort()** (3 connections) — `src/jabber_ipc.js`
- **occupantList()** (3 connections) — `src/jabber_ipc.js`
- **beehiveStatus** (2 connections) — `src/jabber_ipc.js`
- **parseBeehiveStatus()** (2 connections) — `src/jabber_ipc.js`
- **readRooms()** (2 connections) — `src/jabber_ipc.js`
- **writeRooms()** (2 connections) — `src/jabber_ipc.js`
- **MAM_NAMESPACES** (2 connections) — `src/jabber_ipc.js`
- *... and 7 more nodes in this community*

## Relationships

- [Jabber Disco Test](Jabber_Disco_Test.md) (10 shared connections)
- [Ping Classify](Ping_Classify.md) (3 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Jabber Chat Rooms](Jabber_Chat_Rooms.md) (2 shared connections)
- [Message Styling Test](Message_Styling_Test.md) (2 shared connections)
- [Message Styling](Message_Styling.md) (1 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (1 shared connections)
- [Chart Umd (registerCharacterHandlers)](Chart_Umd_%28registerCharacterHandlers%29.md) (1 shared connections)

## Source Files

- `src/jabber_ipc.js`

## Audit Trail

- EXTRACTED: 137 (87%)
- INFERRED: 21 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*