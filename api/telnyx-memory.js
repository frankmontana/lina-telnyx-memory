import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

function buildGreeting({ firstName, seenCount }) {
  if (!seenCount || seenCount <= 1) {
    return "Ciao, sono Lina, piacere di conoscerla. Come preferisce che la chiami?";
  }

  if (firstName) {
    return `Ciao ${firstName}, che piacere risentirti. Come stai oggi?`;
  }

  return "Ciao, che piacere risentirti. Come stai oggi?";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body?.data?.payload || {};
    const phone = (payload.telnyx_end_user_target || "").trim();

    if (!phone) {
      return res.status(200).json({});
    }

    let profile = null;

    const existing = await sql`
      select phone_number, first_name, seen_count
      from caller_profiles
      where phone_number = ${phone}
      limit 1
    `;

    if (existing.length === 0) {
      const inserted = await sql`
        insert into caller_profiles (
          phone_number,
          first_name,
          seen_count,
          first_seen_at,
          last_seen_at,
          updated_at
        )
        values (
          ${phone},
          null,
          1,
          now(),
          now(),
          now()
        )
        returning phone_number, first_name, seen_count
      `;
      profile = inserted[0];
    } else {
      const updated = await sql`
        update caller_profiles
        set
          seen_count = seen_count + 1,
          last_seen_at = now(),
          updated_at = now()
        where phone_number = ${phone}
        returning phone_number, first_name, seen_count
      `;
      profile = updated[0];
    }

    const openingGreeting = buildGreeting({
      firstName: profile.first_name,
      seenCount: profile.seen_count,
    });

    return res.status(200).json({
      dynamic_variables: {
        opening_greeting: openingGreeting,
        first_name: profile.first_name || ""
      },
      memory: {
        conversation_query: `metadata->telnyx_end_user_target=eq.${phone}&limit=4&order=last_message_at.desc`,
        insight_query: "insight_ids=ccc1288d-e335-4d94-aa9c-acb91ff0a2cd"
      },
      conversation: {
        metadata: {
          telnyx_end_user_target: phone
        }
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      dynamic_variables: {
        opening_greeting: "Ciao, sono Lina, piacere di conoscerla. Come preferisce che la chiami?"
      }
    });
  }
}