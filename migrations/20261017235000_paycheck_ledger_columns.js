'use strict';

const { ensurePaycheckLedger } = require('../modules/engine/paycheck-ledger');

/**
 * Align mod_income.paycheck_entries with the paycheck form.
 * Adds missing payload columns in place. Does not drop existing tables.
 * schema.sql (SERIAL + paycheck_id) and the earlier UUID + entry_id migration
 * can both already exist; ensurePaycheckLedger only adds columns.
 */
module.exports = {
  name: 'paycheck_ledger_columns',
  up: async (client) => {
    await ensurePaycheckLedger(client);
  }
};
