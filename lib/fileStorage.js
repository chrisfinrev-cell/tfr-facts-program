'use strict';

// File uploads to Vercel Blob. Requires BLOB_READ_WRITE_TOKEN
// (created automatically when a Blob store is connected to the Vercel project).

function storageConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Uploads a file and returns its public URL, or null when storage is not set up or the upload fails.
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} contentType
 * @param {{folder?: string}} [options]
 */
async function uploadFile(buffer, filename, contentType, options = {}) {
  if (!storageConfigured() || !buffer) return null;
  try {
    const { put } = require('@vercel/blob');
    const safeName = String(filename || 'upload').replace(/[^\w.\-]+/g, '_');
    const pathname = options.folder ? `${options.folder}/${safeName}` : safeName;
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: contentType || 'application/octet-stream',
      addRandomSuffix: true
    });
    return blob.url;
  } catch (err) {
    console.error('[fileStorage] upload failed:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { uploadFile, storageConfigured };
