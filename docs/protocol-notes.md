# gats.io protocol notes (condensed from the user-supplied reference)
Incoming: packets separated by "|", fields by ",". Field 0 is the type.
- a (self init): 1 id, 18 username, 23 isolatedUsername (also class, color, x, y, radius, ...)
- b (move): 1 id, 2 x, 3 y, 4 spdX, 5 spdY, 6 angle
- c (aux/chat): 1 id, 2 currentBullets, 3 shooting, 4 reloading, 5 hp, 6 beingHit, 7 armor, 8 radius, 9 ghillie, 10 maxBullets, 11 invincible, 12 dashing, 13 chatBoxOpen, 14 isLeader, 15 color, 16 chatMessage (17 fields)
- d (remote player init): 1 id, 2 class, 3 color, 4 x, 5 y, 6 radius, 7 angle, 8 armor, 9 hp, 10 maxBullets, 11 username, 12 ghillie, 13 invincible, 14 isLeader, 15 isPremium, 16 teamCode, 17 chatBoxOpen
- e (remove player): 1 id;  s: despawn
Frames are delta-encoded: blank fields mean unchanged. Server only sends b/c for players in range.
Outgoing: one packet per message, NUL terminated. Chat: c,<text>.
Skeleton hook API (gclWsHook): onEveryFrame, addFrameTransformer, addPostDispatchHook, onBatchComplete, onSocketClose, dispatchRawToRealHandler.
