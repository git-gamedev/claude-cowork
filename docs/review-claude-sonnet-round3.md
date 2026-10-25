# Critic round 3: review of the persisted Gate (190b48d) by claude-sonnet

Method: read src/gats-community/src/gate.js and the worker.js login/register/rename changes; modelled the Gate semantics in node. Not run on real Durable Objects.

## Findings
1. **Check-then-fail race lets bursts bypass the limit (medium).** login() calls /check, verifies the password, then /fail (worker.js login). Each Gate call is serialised, but the sequence is not atomic, so N parallel requests all pass /check before the first /fail lands. Reproduced in a model: scratch/claude-sonnet/toctou-gate.mjs. 200 parallel guesses -> 200 password verifications against limit 10. The salt is the login name, so an attacker can precompute keys offline and fire bursts. Fix: reserve first. Call /hit (atomic increment, 429 at limit) BEFORE verifying; on success call /refund (n-1) or /ok. Same model: reserve-first holds the limit exactly (10).
2. **Account-wide lock is a griefing handle (medium).** Key ll:<login> (10 fails / 15 min) is shared across all IPs, so anyone can lock any account out by failing 10 times, repeatedly. Fix: add a per-(ip,login) key with a low limit (about 6) and raise the account-wide limit to about 40, so one stranger cannot lock a victim and a botnet still gets throttled.
3. **Gate objects for unknown logins (low, agrees with researcher-1).** ll:<random name> creates a Gate DO and a storage write per invented name. Count unknown logins only on the IP key. Enumeration is already possible via register name_taken, so nothing is lost.
4. **Global daily register cap is itself a DoS target (low).** 300/day shared by everyone; one botnet can use it up and block real sign-ups until 00:00 UTC. Acceptable trade against the D1 write quota; make MAX_REG_PER_DAY a documented knob and say so in INSTRUCTIONS.
5. **/ok uses deleteAll() but the alarm stays armed (low).** As far as I know deleteAll() does not cancel alarms, so one extra harmless wake later. Add deleteAlarm() if cheap.
6. **Cost note.** A failed login is now 4 Gate requests (2 check + 2 fail), a success 2-3. Fine, but combine check+reserve (finding 1) and it drops to 2 for both.

## Verified OK
ipKey /64 normalisation and ::ffff: mapping, failure-only counting, persistence design (one record per window, no writes once locked, alarm cleanup), fail-open choice.
