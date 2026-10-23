'use strict';

// The full program is the normal boot. Set SAFE_MODE=true only when a
// background call is hanging the page and boot should stop after sign-in
// and the core dashboard.
const SAFE_MODE = process.env.SAFE_MODE === 'true';

function safeModeMiddleware(req, res, next) {
  req.isSafeMode = SAFE_MODE;
  next();
}

module.exports = { SAFE_MODE, safeModeMiddleware };
