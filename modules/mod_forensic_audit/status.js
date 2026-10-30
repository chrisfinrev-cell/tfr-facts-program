'use strict';

/**
 * Forensic compliance status payload for remediation dashboard.
 */

async function getForensicStatus(pool, userId) {
  const affiliateRes = await pool.query(
    `SELECT id, user_id, audit_cadence, last_audit_status, account_created_at
       FROM affiliates
      WHERE id = $1 OR user_id = $1
      ORDER BY id
      LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));

  const affiliate = affiliateRes.rows[0] || null;

  const reportRes = await pool.query(
    `SELECT id, audit_type, status, bucket_totals, flags, created_at
       FROM forensic_audit_reports
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [String(userId)]
  ).catch(() => ({ rows: [] }));

  const report = reportRes.rows[0] || null;

  let escrowedAmount = 0;
  const affId = affiliate ? affiliate.id : null;
  if (affId != null) {
    const esc = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM affiliate_commissions
        WHERE payout_status = 'ESCROWED'
          AND (affiliate_id = $1 OR user_id = $2)`,
      [affId, userId]
    ).catch(() => ({ rows: [{ total: 0 }] }));
    escrowedAmount = Number(esc.rows[0] && esc.rows[0].total) || 0;
  }

  const status =
    (affiliate && affiliate.last_audit_status) ||
    (report && report.status) ||
    'PENDING';

  return {
    status,
    auditCadence: (affiliate && affiliate.audit_cadence) || 'INITIAL',
    accountCreatedAt: affiliate && affiliate.account_created_at,
    escrowedAmount,
    flags: (report && report.flags) || [],
    bucketTotals: (report && report.bucket_totals) || {},
    lastReport: report
      ? {
          id: report.id,
          auditType: report.audit_type,
          status: report.status,
          createdAt: report.created_at
        }
      : null
  };
}

module.exports = { getForensicStatus };
