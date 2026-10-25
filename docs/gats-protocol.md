Below is a complete reference of every message that can be **sent** or **received** by the Gats.io client, based on the deobfuscated game code the user provided. (Verbatim copy of the user-provided document; docs/protocol-notes.md is the condensed version.) All messages follow the same wire format:

- **Incoming**: multiple packets separated by `|`, each packet is a comma-separated list of fields.
- **Outgoing**: one packet per message, fields comma-separated, terminated with a NUL byte (`\0`).
- The **first field** (index `0`) is always the packet type code (a single character or short string).

---

## Incoming packets (server -> client)

| Code | Meaning | Fields (index: description) |
|------|---------|-----------------------------|
| `a` | Local player initialisation | 1: id, 2: class, 3: color, 4: x, 5: y, 6: radius, 7: playerAngle, 8: armorAmount, 9: currentBullets, 10: maxBullets, 11: armor, 12: hp, 13: camera width, 14: camera height, 15: hpMax, 16: mapWidth, 17: mapHeight, 18: username, 19: invincible, 20: isLeader, 21: isPremiumMember, 22: teamCode, 23: isolatedUsername |
| `b` | Player primary update (movement) | 1: id, 2: x, 3: y, 4: spdX, 5: spdY, 6: playerAngle |
| `c` | Player auxiliary update (includes chat) | 1: id, 2: currentBullets, 3: shooting, 4: reloading, 5: hp, 6: beingHit, 7: armorAmount, 8: radius, 9: ghillie, 10: maxBullets, 11: invincible, 12: dashing, 13: chatBoxOpen, 14: isLeader, 15: color, 16: **chatMessage** |
| `d` | Remote player initialisation | 1: id, 2: class, 3: color, 4: x, 5: y, 6: radius, 7: playerAngle, 8: armorAmount, 9: hp, 10: maxBullets, 11: username, 12: ghillie, 13: invincible, 14: isLeader, 15: isPremiumMember, 16: teamCode, 17: chatBoxOpen |
| `e` | Remove player | 1: id |
| `f` | First-person / local player update | 1: currentBullets, 2: score, 3: kills, 4: rechargeTimer, 5: maxBullets, 6: camera, 7: thermal, 8: numExplosivesLeft |
| `g` | Bullet creation | 1: id, 2: x, 3: y, 4: length, 5: width, 6: angle, 7: spdX, 8: spdY, 9: silenced, 10: isKnife, 11: isShrapnel, 12: ownerId, 13: teamCode |
| `h` | Bullet position update | 1: id, 2: x, 3: y |
| `i` | Remove bullet | 1: id |
| `j` | Map object creation | 1: id, 2: type, 3: x, 4: y, 5: angle, 6: parentId, 7: hp, 8: maxHp, 9: isPremium |
| `k` | Map object update | 1: id, 2: x, 3: y, 4: angle, 5: hp |
| `l` | Remove map object | 1: id |
| `m` | Explosive creation | 1: id, 2: type, 3: x, 4: y, 5: spdX, 6: spdY, 7: travelTime, 8: emitting, 9: emissionRadius, 10: ownerId, 11: teamCode |
| `n` | Explosive update | 1: id, 2: x, 3: y, 4: exploding, 5: emitting, 6: emissionRadius |
| `o` | Remove explosive | 1: id |
| `p` | Player level | 1: level |
| `q` | Hit marker | 1: x, 2: y |
| `r` | Notification | 1: type, 2: content |
| `s` | Despawn | (no fields) |
| `t` | Client inactive | (no fields) |
| `u` | (unused in decompress, but handled in compress) | - |
| `v` | Leaderboard | 1: currentPlayers, 2+: entries in format `userId.isMember.score.kills.teamCode` |
| `w` | Authentication success | 1: username, 2: rememberCookie, 3: isPremiumMember, 4: isolatedUsername |
| `x` | Login error | 1: error |
| `y` | Registration error | 1: username, 2: email, 3: password |
| `z` | Authentication status | 1: status |
| `sq` | Team score squares | 1: square1 team, 2: square2 team, 3: square3 team, 4: square4 team |
| `sz` | Map size update | 1: newSize |
| `sta` | Post-death statistics | 1: score, 2: kills, 3: time, 4: shotsFired, 5: shotsHit, 6: damageDealt, 7: damageReceived, 8: distanceCovered, 9: shooterUsername, 10: shooterIsPremiumMember, 11: shooterClass, 12: shooterArmor, 13: shooterColor, 14: shooterKills, 15: shooterScore, 16: shooterHp, 17: shooterArmorAmount, 18: shooterLevel1Powerup, 19: shooterLevel2Powerup, 20: shooterLevel3Powerup |
| `re` | Respawn available | (no fields) |
| `fr` | Force respawn | (no fields) - client responds with `q,<timestamp>` |
| `reco` | Reconnect | (no fields) - client resets and reconnects |
| `version` | Server version | 1: version string |
| `highScores` | High scores | 1: JSON string of high scores |
| `gameType` | Game type | 1: gameType (FFA, TDM, DOM) |

**Special incoming messages** (checked before splitting by comma):
- `+` - connection established; client replies with `q,<timestamp>` and `.`
- `.` - ping response; client replies with another `.`
- `version<space><version>` - server version check
- `highScores<space><json>` - high scores data
- `gameType<space><type>` - game type update

---

## Outgoing packets (client -> server)

| Message | Code | Fields (index: description) |
|---------|------|-----------------------------|
| Ping | `.` | (no fields) - sent as a single dot |
| Adblocker state | `x` | 1: state (`true`/`false`) |
| Return to selection | `r` | (no fields) |
| Selection | `0` | 1: class (0-5), 2: armor (0-3), 3: color (0-5) - prefixed with `0,` |
| Focus | `f` | (no fields) |
| Key press | `k` | 1: inputId, 2: state (0/1) |
| Mouse move | `m` | 1: mouseX, 2: mouseY, 3: mouseAngle |
| Upgrade | `u` | 1: upgrade code (0-19), 2: upgrade level (1-3) |
| Chat message | `c` | 1: message text |
| Login | `a,0` | 1: username/email, 2: password, 3: rememberMe (0/1) |
| Cookie login | `a,1` | 1: rememberCookie |
| Register | `a,2` | 1: username, 2: email, 3: password |
| Logout | `a,3` | (empty) |
| Timestamp | `q` | 1: current timestamp (ms) - sent on connect and on `fr` |

**Key-press input IDs** (for `k` packets):
- `0`: left (A / left arrow)
- `1`: right (D / right arrow)
- `2`: up (W / up arrow)
- `3`: down (S / down arrow)
- `4`: reload (R)
- `5`: powerup (Space)
- `6`: shoot (left mouse button)
- `7`: chat focus (Enter / Esc)

---

## Important notes

- **Incoming chat messages** are only present in `c` packets when the `chatMessage` field (index `16`) is non-empty. The server broadcasts these packets to all players **within range**.
- **Outgoing chat messages** can be sent as a minimal packet: `c,<message>\0`. The server fills in the other fields when broadcasting.
- **Player IDs** are always strings in the protocol; compare them as strings or convert to numbers consistently.
- **The `chatBoxOpen` flag** is at index `13` of incoming `c` packets; it toggles between `0` and `1` when a player opens/closes the chat box.
- **The `"a"` packet** (local player init) resets the client state; any pattern-detection state should be reset when this packet arrives.
- **Range limitation**: The server only sends `b` (movement) and `c` (auxiliary/chat) packets for players within a certain radius. Sending a chat message to a player outside that radius will not reach them, even though the server accepts the packet. Therefore, to reliably deliver a pattern, wait until you receive a `b` packet from a remote player (indicating they are nearby) before sending your chat message.
