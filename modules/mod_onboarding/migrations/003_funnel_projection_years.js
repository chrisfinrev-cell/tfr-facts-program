'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'mod_onboarding', name: 'funnel_sessions' },
    {
      projection_years: { type: 'smallint', default: 30 },
    }
  );
};

exports.down = (pgm) => {
  pgm.dropColumns(
    { schema: 'mod_onboarding', name: 'funnel_sessions' },
    ['projection_years']
  );
};
