import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

function getLocalParts(timeZone) {
  const now = new Date();

  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now); // HH:MM

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  })
    .format(now)
    .toLowerCase(); // mon, tue...

  return { now, date, time, weekday };
}

const SCHEDULE_WINDOW_MINUTES = 15;

function timeToMinutes(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time || "");
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function isWithinScheduleWindow(currentTime, preferredTime) {
  const currentMinutes = timeToMinutes(currentTime);
  const preferredMinutes = timeToMinutes(preferredTime);

  if (currentMinutes == null || preferredMinutes == null) return false;

  const diff = currentMinutes - preferredMinutes;
  return diff >= 0 && diff < SCHEDULE_WINDOW_MINUTES;
}

function buildOpeningGreeting(contact, triggerType) {
  if (triggerType === "retry") {
    if (contact.first_name) {
      return `Ciao ${contact.first_name}, riprovo a chiamarla adesso. Come sta?`;
    }
    return "Ciao, riprovo a chiamarla adesso. Come sta?";
  }

  if (contact.first_name) {
    return `Ciao ${contact.first_name}, che piacere sentirla. Come sta oggi?`;
  }

  return "Ciao, che piacere sentirla. Come sta oggi?";
}

async function createAttempt(contact, triggerType) {
  const rows = await sql`
    insert into call_attempts (contact_id, trigger_type, status, scheduled_for, started_at)
    values (${contact.id}, ${triggerType}, 'queued', now(), now())
    returning id
  `;
  return rows[0];
}

async function markContactAttemptStarted(contactId, attemptId, triggerType, localDate) {
  if (triggerType === "retry") {
    await sql`
      update scheduled_contacts
      set
        active_attempt_id = ${attemptId},
        last_attempted_at = now(),
        pending_retry_at = null,
        updated_at = now()
      where id = ${contactId}
    `;
    return;
  }

  await sql`
    update scheduled_contacts
    set
      active_attempt_id = ${attemptId},
      last_attempted_at = now(),
      last_call_local_date = ${localDate},
      retry_count_today = 0,
      updated_at = now()
    where id = ${contactId}
  `;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "Cron secret not configured" });
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const contacts = await sql`
    select *
    from scheduled_contacts
    where enabled = true
    order by created_at asc
  `;

  const due = [];

  for (const contact of contacts) {
    const timeZone = contact.timezone || "Europe/Rome";
    const { now, date, time, weekday } = getLocalParts(timeZone);
    const weekdays = Array.isArray(contact.weekdays) ? contact.weekdays : [];

    const isRetryDue =
      contact.pending_retry_at && new Date(contact.pending_retry_at) <= now;

    const isScheduledDue =
      !contact.pending_retry_at &&
      isWithinScheduleWindow(time, contact.preferred_time) &&
      weekdays.includes(weekday) &&
      contact.last_call_local_date !== date;

    if (isRetryDue || isScheduledDue) {
      due.push({
        contact,
        localDate: date,
        triggerType: isRetryDue ? "retry" : "scheduled",
      });
    }
  }

  const results = [];

  for (const item of due) {
    const { contact, localDate, triggerType } = item;
    const attempt = await createAttempt(contact, triggerType);

    await markContactAttemptStarted(contact.id, attempt.id, triggerType, localDate);

    const payload = {
      From: process.env.TELNYX_FROM_NUMBER,
      To: contact.phone_number,
      AIAssistantId: process.env.TELNYX_AI_ASSISTANT_ID,
      AIAssistantDynamicVariables: {
        first_name: contact.first_name || "",
        opening_greeting: buildOpeningGreeting(contact, triggerType),
        call_reason: triggerType === "retry" ? "retry_check_in" : "scheduled_check_in",
      },
    };

    try {
      const r = await fetch(
        `https://api.telnyx.com/v2/texml/ai_calls/${process.env.TELNYX_TEXML_APP_ID}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await r.json();
      const callControlId = data?.data?.call_control_id ?? null;
      const callSessionId = data?.data?.call_session_id ?? null;

      await sql`
        update call_attempts
        set
          status = ${r.ok ? "initiated" : "failed"},
          raw_start_response = ${JSON.stringify(data)}::jsonb,
          call_session_id = ${callSessionId},
          call_leg_id = ${callControlId}
        where id = ${attempt.id}
      `;

      if (!r.ok) {
        await sql`
          update scheduled_contacts
          set
            active_attempt_id = null,
            last_status = 'failed_to_start',
            updated_at = now()
          where id = ${contact.id}
        `;
      }

      results.push({
        phone_number: contact.phone_number,
        triggerType,
        ok: r.ok,
      });
    } catch (err) {
      await sql`
        update call_attempts
        set status = 'failed'
        where id = ${attempt.id}
      `;

      await sql`
        update scheduled_contacts
        set
          active_attempt_id = null,
          last_status = 'failed_to_start',
          updated_at = now()
        where id = ${contact.id}
      `;

      results.push({
        phone_number: contact.phone_number,
        triggerType,
        ok: false,
        error: String(err),
      });
    }
  }

  return res.status(200).json({
    checked: contacts.length,
    due: due.length,
    results,
  });
}