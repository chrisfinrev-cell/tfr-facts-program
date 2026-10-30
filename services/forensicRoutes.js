'use strict';

/**
 * Thin router matching the remediationController mount pattern.
 * Prefer module-loader mount at /api/forensic (mod_forensic_audit).
 */
const express = require('express');
const multer = require('multer');
const { handleExpeditedReAudit } = require('../controllers/remediationController');

const router = express.Router();

const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_FILE_TYPE: Only CSV, PDF, and XLSX statements are supported.'));
  }
});

// Route for submitting corrective statements for re-audit
router.post('/expedited-reaudit', upload.single('statement'), handleExpeditedReAudit);

module.exports = router;
