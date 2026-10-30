'use strict';

/**
 * Evaluates user account age and triggers forensic audits based on clean milestones.
 */

const CADENCE = Object.freeze({
  INITIAL: 'INITIAL',
  DAY_90: 'DAY_90',
  DAY_180: 'DAY_180',
  ANNUAL: 'ANNUAL',
  REMEDIATION_REQUIRED: 'REMEDIATION_REQUIRED'
});

function checkAndTriggerMilestoneAudit(userAccount) {
  const createdAt = userAccount.createdAt || userAccount.created_at;
  const accountAgeDays = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  const lastAudit = userAccount.lastForensicAudit || userAccount.last_forensic_audit || null;

  let triggerAudit = false;
  let nextCadence = userAccount.auditCadence || userAccount.audit_cadence || CADENCE.INITIAL;

  if (accountAgeDays >= 90 && accountAgeDays < 180 && nextCadence === CADENCE.INITIAL) {
    triggerAudit = true;
    nextCadence = CADENCE.DAY_90;
  } else if (accountAgeDays >= 180 && nextCadence === CADENCE.DAY_90) {
    triggerAudit = true;
    // Check if the Day 90 audit came back clean
    if (lastAudit && lastAudit.status === 'CLEAN') {
      nextCadence = CADENCE.DAY_180;
    } else {
      nextCadence = CADENCE.REMEDIATION_REQUIRED;
    }
  } else if (accountAgeDays >= 365 && nextCadence === CADENCE.DAY_180) {
    triggerAudit = true;
    // If Day 180 was clean, shift to annual audits
    if (lastAudit && lastAudit.status === 'CLEAN') {
      nextCadence = CADENCE.ANNUAL;
    }
  } else if (
    nextCadence === CADENCE.ANNUAL &&
    lastAudit &&
    typeof lastAudit.dayMark === 'number' &&
    accountAgeDays - lastAudit.dayMark >= 365
  ) {
    if (lastAudit.status === 'CLEAN') {
      triggerAudit = true;
    }
  }

  return {
    userId: userAccount.id,
    accountAgeDays,
    triggerAudit,
    newCadenceState: nextCadence
  };
}

module.exports = {
  CADENCE,
  checkAndTriggerMilestoneAudit
};
