'use strict';

// Safe mode is on until SAFE_MODE=false. Boot loads auth and the core
// dashboard only. Other modules stay quiet until a tab asks for them.
const SAFE_MODE = process.env.SAFE_MODE !== 'false';

function safeModeMiddleware(req, res, next) {
  req.isSafeMode = SAFE_MODE;
  next();
}

module.exports = { SAFE_MODE, safeModeMiddleware };
