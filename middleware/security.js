'use strict';

/**
 * Production security middleware — Helmet headers + express-rate-limit.
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://js.stripe.com',
        'https://cdn.tailwindcss.com',
        'https://cdnjs.cloudflare.com',
        'https://fonts.googleapis.com'
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
        'https://cdnjs.cloudflare.com'
      ],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: [
        "'self'",
        'https://api.stripe.com',
        'https://api.openai.com',
        'https://api.coinbase.com',
        'https://sandbox.plaid.com',
        'https://production.plaid.com'
      ],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  // Keep camera/mic/geo/payment locked down (matches prior Permissions-Policy)
  permissionsPolicy: {
    features: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: []
    }
  }
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait before retrying.',
    retryAfter: 60
  },
  skip: (req) => {
    // Stripe webhook is signature-verified separately
    const p = req.path || '';
    return p === '/stripe-webhook' || p.endsWith('/stripe-webhook');
  }
});

const sensitiveRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many attempts on a sensitive endpoint. Please wait before retrying.',
    retryAfter: 900
  }
});

module.exports = {
  securityHeaders,
  globalLimiter,
  sensitiveRouteLimiter
};
