'use strict';

/**
 * Draft centralized error logger / optional Sentry hook.
 * Mount AFTER routes: app.use(require('./middleware/requestErrorLogger'));
 */

function requestErrorLogger(err, req, res, next) {
  const payload = {
    ts: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl || req.url,
    userId: req.session && req.session.userId ? req.session.userId : null,
    message: err && err.message ? err.message : String(err),
    stack: process.env.LOG_LEVEL === 'debug' && err && err.stack ? err.stack : undefined
  };

  console.error('[requestErrorLogger]', JSON.stringify(payload));

  // Optional: wire Sentry when SENTRY_DSN is set
  // if (process.env.SENTRY_DSN && global.Sentry) global.Sentry.captureException(err);

  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status >= 500 ? 'SERVER_ERROR' : err.code || 'REQUEST_ERROR',
    message: status >= 500 ? 'An unexpected error occurred.' : err.message
  });
}

module.exports = requestErrorLogger;
