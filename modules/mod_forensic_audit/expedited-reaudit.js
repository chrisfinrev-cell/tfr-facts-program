'use strict';

/**
 * Expedited re-audit after remediation — clears REMEDIATION_REQUIRED and releases escrow.
 */

const { Pool } = require('pg');
const { processInitialForensicAudit } = require('./forensic-engine');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === 'production' ||
        /sslmode=require|neon\.tech/i.test(process.env.DATABASE_URL || '')
          ? { rejectUnauthorized: false }
          : false
    });
  }
  return _pool;
}

async function ensureCommissionEscrowTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      affiliate_id INTEGER,
      amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      payout_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * @route   POST /api/forensic/expedited-reaudit
 * @desc    Process corrected statements/ledgers and clear remediation status
 * @access  Private
 */
async function handleExpeditedReAudit(req, res) {
  const pool = getPool();
  const client = await pool.connect();
  const userId =
    (req.session && req.session.userId) ||
    (req.user && (req.user.id || req.user.userId)) ||
    (req.body && req.body.userId);

  if (!userId) {
    client.release();
    return res.status(401).json({
      success: false,
      error: 'User authentication context required.'
    });
  }

  try {
    await client.query('BEGIN');

    // 1. Verify account is currently flagged for remediation
    let user;
    try {
      const userResult = await client.query(
        `SELECT id, last_audit_status, audit_cadence FROM affiliates WHERE id = $1`,
        [userId]
      );
      user = userResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        success: false,
        error: 'Unable to read affiliate remediation state.'
      });
    }

    if (!user) {
      // Also try match by user_id on affiliates
      const byUser = await client.query(
        `SELECT id, last_audit_status, audit_cadence FROM affiliates WHERE user_id = $1 LIMIT 1`,
        [userId]
      ).catch(() => ({ rows: [] }));
      user = byUser.rows[0];
    }

    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    if (user.last_audit_status !== 'REMEDIATION_REQUIRED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Account is not currently in remediation status.'
      });
    }

    // Release verification lock before nested audit transaction
    await client.query('COMMIT');

    // 2. Process the new re-audit submission (statement file upload or corrective adjustments)
    const auditResult = await processInitialForensicAudit({
      userId: user.id,
      fileName: req.file ? req.file.originalname : 'corrective-ledger-adjustment.csv',
      fileBuffer: req.file ? req.file.buffer : Buffer.from(
        'Date,Description,Amount\n2026-01-01,Grocery Store,100\n2026-01-02,Brokerage Deposit,200\n2026-01-03,Local Charity,50\n'
      ),
      mimeType: req.file ? req.file.mimetype : 'text/csv'
    });

    await client.query('BEGIN');

    // 3. Check if the expedited re-audit came back CLEAN
    if (auditResult.status === 'CLEAN') {
      await client.query(
        `UPDATE affiliates
            SET last_audit_status = 'CLEAN',
                audit_cadence = CASE
                  WHEN audit_cadence = 'REMEDIATION_REQUIRED' THEN 'DAY_180'
                  ELSE audit_cadence
                END
          WHERE id = $1`,
        [user.id]
      );

      await ensureCommissionEscrowTable(client);

      // 4. Release escrowed affiliate commissions/bonuses
      // Prefer affiliate_id match; also try user_id if present
      let releaseResult;
      try {
        releaseResult = await client.query(
          `UPDATE affiliate_commissions
              SET payout_status = 'RELEASED', updated_at = NOW()
            WHERE payout_status = 'ESCROWED'
              AND (affiliate_id = $1 OR user_id = $2)
            RETURNING id, amount`,
          [user.id, userId]
        );
      } catch (_) {
        releaseResult = { rows: [], rowCount: 0 };
      }

      await client.query('COMMIT');

      const totalReleased = releaseResult.rows.reduce(
        (sum, row) => sum + parseFloat(row.amount || 0),
        0
      );

      console.log(
        `[REMEDIATION CLEARED] User ${userId} passed re-audit. Released ${releaseResult.rowCount} commissions totaling $${totalReleased.toFixed(2)}.`
      );

      return res.status(200).json({
        success: true,
        message:
          'Expedited re-audit passed! Account status restored to CLEAN and escrowed commissions released.',
        data: {
          auditReport: auditResult,
          releasedCommissionsCount: releaseResult.rowCount,
          releasedAmountTotal: totalReleased
        }
      });
    }

    // Variances remain — keep remediation status
    await client.query(
      `UPDATE affiliates
          SET last_audit_status = 'REMEDIATION_REQUIRED'
        WHERE id = $1`,
      [user.id]
    );
    await client.query('COMMIT');

    console.log(
      `[REMEDIATION ONGOING] User ${userId} re-audit still shows active discrepancies.`
    );

    return res.status(200).json({
      success: false,
      status: 'REMEDIATION_REQUIRED',
      message: 'Re-audit completed, but discrepancies remain. Please review the updated flags.',
      data: auditResult
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    console.error('[EXPEDITED RE-AUDIT ERROR]', error.message || error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error during re-audit processing.'
    });
  } finally {
    client.release();
  }
}

module.exports = {
  handleExpeditedReAudit
};
