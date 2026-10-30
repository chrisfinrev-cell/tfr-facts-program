/**
 * StatementUploader — vanilla mount for POST /api/forensic/upload-statement
 * Session-cookie auth (credentials: 'include'). No React build step.
 *
 * Usage (vanilla stand-in for React <StatementUploader />):
 *   mountStatementUploader(document.getElementById('statement-uploader'), {
 *     userId: 17,
 *     onAuditComplete: function (data) { console.log(data); }
 *   });
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'statement-uploader-css';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.su-card{padding:1.5rem;border:1px solid rgba(148,163,184,.35);border-radius:0.75rem;',
      'background:#0f172a;color:#fff;max-width:28rem;font-family:Georgia,"Times New Roman",serif;}',
      '.su-card h3{margin:0 0 .5rem;font-size:1.25rem;font-weight:600;}',
      '.su-card p.su-help{margin:0 0 1rem;font-size:.875rem;color:#94a3b8;line-height:1.4;}',
      '.su-card form{display:flex;flex-direction:column;gap:1rem;}',
      '.su-card input[type=file]{width:100%;font-size:.875rem;color:#cbd5e1;}',
      '.su-card .su-error{margin:0;color:#f87171;font-size:.75rem;font-family:ui-monospace,Consolas,monospace;}',
      '.su-card .su-ok{margin:0;color:#34d399;font-size:.75rem;}',
      '.su-card button{width:100%;padding:.5rem 1rem;border:0;border-radius:.375rem;',
      'background:#059669;color:#fff;font-weight:600;cursor:pointer;transition:opacity .15s;}',
      '.su-card button:hover:not(:disabled){background:#10b981;}',
      '.su-card button:disabled{opacity:.5;cursor:not-allowed;}'
    ].join('');
    document.head.appendChild(style);
  }

  function mountStatementUploader(container, options) {
    if (!container) return;
    options = options || {};
    ensureStyles();

    var file = null;
    var loading = false;

    container.innerHTML =
      '<div class="su-card">' +
      '  <h3>Forensic Baseline Audit Upload</h3>' +
      '  <p class="su-help">Upload your bank or credit card statements (CSV or PDF) to run your initial forensic analysis across your 6 FACTS buckets.</p>' +
      '  <form>' +
      '    <input type="file" accept=".csv,.pdf,.xlsx" />' +
      '    <p class="su-error" hidden></p>' +
      '    <p class="su-ok" hidden></p>' +
      '    <button type="submit" disabled>Analyze Statement</button>' +
      '  </form>' +
      '</div>';

    var form = container.querySelector('form');
    var input = container.querySelector('input[type=file]');
    var errEl = container.querySelector('.su-error');
    var okEl = container.querySelector('.su-ok');
    var btn = container.querySelector('button');

    function setError(msg) {
      errEl.hidden = !msg;
      errEl.textContent = msg || '';
      if (msg) okEl.hidden = true;
    }

    function setOk(msg) {
      okEl.hidden = !msg;
      okEl.textContent = msg || '';
    }

    function syncButton() {
      btn.disabled = loading || !file;
      btn.textContent = loading ? 'Running Forensic Audit...' : 'Analyze Statement';
    }

    input.addEventListener('change', function (e) {
      var selected = e.target.files && e.target.files[0];
      file = selected || null;
      setError(null);
      setOk(null);
      syncButton();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!file) {
        setError('Please select a CSV or PDF statement first.');
        return;
      }

      loading = true;
      setError(null);
      setOk(null);
      syncButton();

      var formData = new FormData();
      formData.append('statement', file);
      if (options.userId != null && options.userId !== '') {
        formData.append('userId', String(options.userId));
      }

      fetch('/api/forensic/upload-statement', {
        method: 'POST',
        credentials: 'include',
        // Do NOT set Content-Type manually when sending FormData
        body: formData
      })
        .then(function (res) {
          return res.json().then(function (result) {
            if (!res.ok) throw new Error(result.error || 'Failed to upload statement.');
            return result;
          });
        })
        .then(function (result) {
          setOk('Audit complete — ' + (result.data && result.data.totalAnalyzed != null
            ? result.data.totalAnalyzed + ' transactions classified.'
            : 'baseline ready.'));
          if (typeof options.onAuditComplete === 'function') {
            options.onAuditComplete(result.data || result);
          }
        })
        .catch(function (err) {
          setError(err.message || 'Upload failed.');
        })
        .finally(function () {
          loading = false;
          syncButton();
        });
    });

    syncButton();
  }

  global.mountStatementUploader = mountStatementUploader;
})(typeof window !== 'undefined' ? window : globalThis);
