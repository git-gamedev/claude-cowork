# gats-community (v1) vs gats-login (claude-sonnet) - merge guide
| Topic | gats-community | gats-login | Take |
|---|---|---|---|
| KDF salt | login (immutable) | random per user via /prelogin | gats-login (rename-safe login), costs 1 extra D1 read |
| Revocation | Room caches D1 + 5-min alarm | AuthCache DO, instant kick via last-room key | gats-login; drop alarm |
| Rename safety | check in UPDATE (0 reads) | 1 read + cooldown | combine: UPDATE ... AND token_version=? plus renamed_at guard |
| IP throttle | Gate DO | none (gap) | gats-community Gate |
| Account lockout | none (gap) | failed_count/locked_until | gats-login |
| Claim verification | none (gap) | gname must match d frame | gats-login |
| Ghost handling | b/c create stubs (bug) | d only | gats-login |
| Room allowlist | any [a-z0-9.:-] | suffix allowlist | gats-login |
| Unregister/logout_all | missing | present | gats-login |
