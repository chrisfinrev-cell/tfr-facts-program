import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

type NdaUserRecord = {
  id: string;
  fullName: string;
  email: string;
  ndaSigned: boolean;
  ndaSignedAt: Date | string | null;
  ndaSignedIp: string | null;
  ndaUserAgent: string | null;
  ndaVersion: string | null;
  ndaTypedSignature: string | null;
};

async function findUnique(args: {
  where: { id: string };
  select?: Record<string, boolean>;
}): Promise<NdaUserRecord | null> {
  const rawId = String(args.where.id || '').trim();
  if (!rawId) return null;
  const numericId = Number.parseInt(rawId, 10);

  const params = [rawId, Number.isFinite(numericId) ? numericId : null];
  let result;
  try {
    result = await pool.query(
    `SELECT
        u.id::text AS id,
        COALESCE(u.name, p.display_name, split_part(u.email, '@', 1), '') AS "fullName",
        u.email,
        (u.nda_accepted_at IS NOT NULL OR na.id IS NOT NULL) AS "ndaSigned",
        COALESCE(u.nda_accepted_at, na.accepted_at) AS "ndaSignedAt",
        COALESCE(u.nda_signed_ip, na.ip_address) AS "ndaSignedIp",
        COALESCE(u.nda_user_agent, '') AS "ndaUserAgent",
        COALESCE(u.nda_version, na.nda_version, 'v1.0-BETA') AS "ndaVersion",
        COALESCE(u.nda_typed_signature, u.name, p.display_name, '') AS "ndaTypedSignature"
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT id, accepted_at, ip_address, nda_version
       FROM nda_acceptances
       WHERE user_id = u.id
       ORDER BY accepted_at DESC NULLS LAST
       LIMIT 1
     ) na ON true
     WHERE u.id::text = $1
        OR ($2::int IS NOT NULL AND u.id = $2)
     LIMIT 1`,
      params
    );
  } catch {
    result = await pool.query(
      `SELECT
          u.id::text AS id,
          COALESCE(u.name, split_part(u.email, '@', 1), '') AS "fullName",
          u.email,
          (u.nda_accepted_at IS NOT NULL OR na.id IS NOT NULL) AS "ndaSigned",
          COALESCE(u.nda_accepted_at, na.accepted_at) AS "ndaSignedAt",
          COALESCE(na.ip_address, '0.0.0.0') AS "ndaSignedIp",
          'UNKNOWN' AS "ndaUserAgent",
          COALESCE(u.nda_version, na.nda_version, 'v1.0-BETA') AS "ndaVersion",
          COALESCE(u.name, '') AS "ndaTypedSignature"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT id, accepted_at, ip_address, nda_version
         FROM nda_acceptances
         WHERE user_id = u.id
         ORDER BY accepted_at DESC NULLS LAST
         LIMIT 1
       ) na ON true
       WHERE u.id::text = $1
          OR ($2::int IS NOT NULL AND u.id = $2)
       LIMIT 1`,
      params
    );
  }

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    ndaSigned: Boolean(row.ndaSigned),
    ndaSignedAt: row.ndaSignedAt,
    ndaSignedIp: row.ndaSignedIp,
    ndaUserAgent: row.ndaUserAgent,
    ndaVersion: row.ndaVersion,
    ndaTypedSignature: row.ndaTypedSignature
  };
}

export const db = {
  user: {
    findUnique
  }
};
