# Message delivery during compaction

Smart Compact offers an optional extension-to-extension queue. It does not
patch Pi or intercept arbitrary `sendMessage` / `sendUserMessage` calls.
Senders must opt in; installing Smart Compact alone does not protect older
AGM or process adapters.

The queue covers manual `/smart-compact` preparation, approval and native
application, plus native compactions observed through `session_before_compact`.
Proactive native apply requests are also held before Pi starts its initial
abort/idle wait. It does not block speculative background preparation or
`smart_compact` tool staging. A UI picker before preparation is not a compaction lock.

## Delivery contract

Before sending, emit a **synchronous** request on `pi.events`:

```ts
const request = {
  version: 1,
  sessionId: ctx.sessionManager.getSessionId(),
  deliver: sendDirectly,
  deferred: false,
};
pi.events.emit("smart-compact:defer-delivery", request);
if (!request.deferred) sendDirectly();
```

`sendDirectly` performs the original delivery, including its original attention
policy. It must **not** emit another defer request. Without a matching active
gate, `deferred` stays false and ordinary delivery is unchanged. An accepting
gate sets it to true before `emit` returns and owns delivery order.

Sender requirements:

- Deduplicate pending source IDs. Acceptance into this volatile queue is not a
  persistence acknowledgement; broker-backed mail must remain unacknowledged
  until the sender observes the normal durable handoff.
- Bind callbacks to the originating session generation and ignore callbacks
  after replacement/disposal, even if the new session has the same ID.
- Query current host state when delivering, not the state at receipt. Preserve
  quiet/context-only delivery and coalesce idle wakes. If using an asynchronous
  user-message wake, allow steering in case another sender already started a run.
  Passive (`triggerTurn: false`) messages may enter history after an already
  started request; they remain available to the next request without forcing a
  new turn. Callback order is not a guarantee of same-request model visibility.
- A successful callback is removed once. A synchronous throw retains only that
  callback for the next natural run, with a visible warning; healthy callbacks
  continue in arrival order. New senders are not blocked by failed callbacks.
  A failed callback can therefore arrive later than newer notifications. Senders
  that partially delivered must handle that case themselves to avoid duplicates.

## Safe release

`session_compact` is a commit notification, **not** proof that Pi has left its
compacting state. After all foreground/native scopes finish, the gate checks
`ctx.isIdle()` with a short timer. For automatic compaction inside an active
run, the next `before_agent_start` or `turn_start` boundary can release it too.
Older supported Pi hosts still report idle inside `before_agent_start`; the
queue then waits for `turn_start` so a waking sender cannot start a second
prompt during preparation. `agent_end` is not used. Native application callbacks keep the manual scope
held until the host's operation has actually returned.

Healthy callbacks run FIFO. A reentrant compaction stops draining until its own
safe boundary. Ordinary failures release once the host is ready. User/native
aborts retain notifications without automatically restarting the agent; the next
natural run or successful compaction retry releases them. Failed deliveries are
not retried again at every tool-loop turn.

If the automatic request's watchdog expires, it arms recovery for that request's
delivery scope. Recovery waits for actual host idle; it neither cancels a busy
compaction nor releases another request's scope. Late completion remains valid.

## Visible queue state

The TUI footer shows the count and whether notifications are waiting for
compaction, cancellation recovery or failed-delivery retry. Cancellation also
shows how to resume: send a message or retry compaction. The first queued
notification displays a one-time reminder that the queue is in memory and that
reload/exit can lose process notifications. These are UI-only messages, not
extra prompts sent to the model. The status clears when the queue is drained or
the extension shuts down.

## Lifetime and limitations

The queue is in memory and belongs to one extension session. Shutdown, reload
or replacement discards callbacks rather than delivering into another session.
AGM can redeliver its still-unacknowledged broker mail; process notifications do
not acquire disk durability from this protocol. A process crash can lose queued
callbacks. Non-participating senders can still interrupt preparation.
