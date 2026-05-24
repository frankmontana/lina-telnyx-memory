import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

// Telnyx delivers TWO incompatible webhook formats:
// 1) v2 call-control JSON: { data: { event_type, payload: { call_session_id, call_leg_id, to, ... } } }
// 2) TeXML status callback (form-encoded): { CallSid, CallStatus, From, To, CallDuration, ... }
// This normalizer collapses both into a single shape used downstream.
function normalizeEvent(body) {
  if (body?.data?.event_type) {
    const payload = body.data.payload || {};
    return {
      format: "v2",
      eventType: body.data.event_type,
      to: payload.to || null,
      callSessionId: payload.call_session_id || null,
      callLegId: payload.call_leg_id || null,
      callDurationSec: null,
    };
  }

  if (body?.CallStatus || body?.CallSid) {
    const durationStr = body.CallDuration ?? body.callDuration ?? null;
    const durationSec = durationStr != null ? parseInt(durationStr, 10) : null;
    return {
      format: "texml",
      eventType: String(body.CallStatus || "").toLowerCase(),
      to: body.To || null,
      callSessionId: null,
      // For TeXML AI Calls, CallSid is the unified identifier — same string
      // that cron-calls.js stored in call_attempts.call_leg_id from data.call_control_id.
      callLegId: body.CallSid || null,
      callDurationSec: Number.isFinite(durationSec) ? durationSec : null,
    };
  }

  return {
    format: "unknown",
    eventType: "",
    to: null,
    callSessionId: null,
    callLegId: null,
    callDurationSec: null,
  };
}

function isAnsweredEvent(eventType) {
  // Explicit answered/in-progress signals (rare for TeXML AI Calls in practice).
  return eventType.includes("answered") || eventType === "in-progress";
}

function isCompletedEvent(eventType) {
  return (
    eventType.includes("completed") ||
    eventType.includes("hangup") ||
    eventType.includes("ended")
  );
}

function isFailureEvent(eventType) {
  // Terminal events that mean the call didn't connect.
  return (
    eventType === "busy" ||
    eventType === "failed" ||
    eventType === "no-answer" ||
    eventType === "canceled"
  );
}

// 'analyzed' is a TeXML AI Calls post-call event sent after Conversation Insights
// have been computed. Its presence (with non-empty insights) is a strong signal
// that a real conversation happened, even if no 'answered' / 'in-progress' event
// was ever delivered.
function isAnalyzedEvent(eventType) {
  return eventType === "analyzed";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { format, eventType, to, callSessionId, callLegId, callDurationSec } =
    normalizeEvent(req.body);

  // 1) trova il tentativo per call_session_id o call_leg_id
  let attempts = [];
  if (callSessionId || callLegId) {
    attempts = await sql`
      select a.*, c.id as contact_id, c.retry_once, c.retry_count_today, c.pending_retry_at
      from call_attempts a
      join scheduled_contacts c on c.id = a.contact_id
      where (${callSessionId}::text is not null and a.call_session_id = ${callSessionId})
         or (${callLegId}::text is not null and a.call_leg_id = ${callLegId})
      order by a.created_at desc
      limit 1
    `;
  }

  // 2) fallback: usa il numero chiamato e il tentativo attivo più recente
  if (attempts.length === 0 && to) {
    attempts = await sql`
      select a.*, c.id as contact_id, c.retry_once, c.retry_count_today, c.pending_retry_at
      from scheduled_contacts c
      join call_attempts a on a.id = c.active_attempt_id
      where c.phone_number = ${to}
      order by a.created_at desc
      limit 1
    `;
  }

  if (attempts.length === 0) {
    console.log("No matching attempt found", {
      format,
      eventType,
      to,
      callSessionId,
      callLegId,
    });
    return res.status(200).json({ ok: true, ignored: true });
  }

  const attempt = attempts[0];

  // Always sync ids. Only overwrite raw_last_webhook when this event is at least
  // as informative as the existing one — concretely, never let an 'analyzed'
  // payload (no CallDuration, no Direction info) clobber the richer 'completed'
  // payload that arrived just before it.
  const shouldOverwriteRaw = !isAnalyzedEvent(eventType);
  await sql`
    update call_attempts
    set
      call_session_id = coalesce(call_session_id, ${callSessionId}),
      call_leg_id = coalesce(call_leg_id, ${callLegId}),
      raw_last_webhook = case
        when ${shouldOverwriteRaw}::boolean then ${JSON.stringify(req.body)}::jsonb
        when raw_last_webhook is null then ${JSON.stringify(req.body)}::jsonb
        else raw_last_webhook
      end
    where id = ${attempt.id}
  `;

  // ---- Branch A: explicit answered/in-progress (mostly v2; rare for TeXML AI Calls)
  if (isAnsweredEvent(eventType)) {
    await sql`
      update call_attempts
      set
        status = 'answered',
        answered_at = coalesce(answered_at, now())
      where id = ${attempt.id}
    `;
    await sql`
      update scheduled_contacts
      set
        last_answered_at = now(),
        last_status = 'answered',
        updated_at = now()
      where id = ${attempt.contact_id}
    `;
    return res.status(200).json({ ok: true, state: "answered" });
  }

  // ---- Branch B: completed
  // For TeXML AI Calls, the 'completed' event is the FIRST signal that the call
  // was answered, because no 'in-progress' callback is delivered. So we use
  // CallDuration to decide answered vs no-answer:
  //   CallDuration > 0  -> the call was actually picked up; backfill answered_at.
  //   CallDuration = 0  -> rang out without pickup.
  if (isCompletedEvent(eventType)) {
    const fresh = (
      await sql`select * from call_attempts where id = ${attempt.id} limit 1`
    )[0];

    const hadAnswer = !!fresh.answered_at;
    const duration = callDurationSec ?? 0;
    const wasAnswered = hadAnswer || duration > 0;

    if (wasAnswered) {
      await sql`
        update call_attempts
        set
          status = 'completed',
          answered_at = coalesce(answered_at, now() - (${duration} || ' seconds')::interval),
          completed_at = now()
        where id = ${attempt.id}
      `;
      await sql`
        update scheduled_contacts
        set
          active_attempt_id = null,
          pending_retry_at = null,
          last_answered_at = coalesce(last_answered_at, now()),
          last_status = 'completed',
          updated_at = now()
        where id = ${attempt.contact_id}
      `;
      return res.status(200).json({ ok: true, state: "completed", duration });
    }

    // No answer / no pickup
    await sql`
      update call_attempts
      set
        status = 'no_answer',
        completed_at = now()
      where id = ${attempt.id}
    `;

    if (
      attempt.retry_once &&
      attempt.retry_count_today < 1 &&
      !attempt.pending_retry_at
    ) {
      await sql`
        update scheduled_contacts
        set
          pending_retry_at = now() + interval '15 minutes',
          retry_count_today = retry_count_today + 1,
          active_attempt_id = null,
          last_status = 'no_answer',
          updated_at = now()
        where id = ${attempt.contact_id}
      `;
      return res.status(200).json({ ok: true, state: "retry_scheduled" });
    }

    await sql`
      update scheduled_contacts
      set
        active_attempt_id = null,
        pending_retry_at = null,
        last_status = 'no_answer',
        updated_at = now()
      where id = ${attempt.contact_id}
    `;
    return res.status(200).json({ ok: true, state: "no_answer" });
  }

  // ---- Branch C: explicit failure terminal events (busy / failed / no-answer / canceled)
  if (isFailureEvent(eventType)) {
    await sql`
      update call_attempts
      set
        status = ${eventType === "failed" ? "failed" : "no_answer"},
        completed_at = coalesce(completed_at, now())
      where id = ${attempt.id}
    `;
    await sql`
      update scheduled_contacts
      set
        active_attempt_id = null,
        last_status = ${eventType === "failed" ? "failed" : "no_answer"},
        updated_at = now()
      where id = ${attempt.contact_id}
    `;
    return res.status(200).json({ ok: true, state: eventType });
  }

  // ---- Branch D: 'analyzed' (post-call AI insights done)
  // Only fired by TeXML AI Calls AFTER the conversation has ended and was
  // analyzed. Use it as a confirming signal: if we somehow still have status
  // != completed (because the 'completed' event lacked CallDuration, arrived
  // out-of-order, or was missed entirely), backfill answered_at and mark the
  // call completed.
  if (isAnalyzedEvent(eventType)) {
    const fresh = (
      await sql`select * from call_attempts where id = ${attempt.id} limit 1`
    )[0];

    if (fresh.status === "completed" && fresh.answered_at) {
      // Already correct, nothing to do.
      return res.status(200).json({ ok: true, state: "already_completed" });
    }

    await sql`
      update call_attempts
      set
        status = 'completed',
        answered_at = coalesce(answered_at, started_at, now()),
        completed_at = coalesce(completed_at, now())
      where id = ${attempt.id}
    `;
    await sql`
      update scheduled_contacts
      set
        active_attempt_id = null,
        pending_retry_at = null,
        last_answered_at = coalesce(last_answered_at, now()),
        last_status = 'completed',
        updated_at = now()
      where id = ${attempt.contact_id}
    `;
    return res.status(200).json({ ok: true, state: "completed_via_analyzed" });
  }

  // Other intermediate events (initiated, ringing, ...) don't change state.
  return res.status(200).json({ ok: true, ignored: true });
}
