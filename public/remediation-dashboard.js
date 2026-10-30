/**
 * RemediationDashboard — vanilla mount (React stand-in)
 *   mountRemediationDashboard(el, { userId })
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'remediation-dashboard-css';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.rd{max-width:48rem;margin:0 auto;padding:1.5rem;background:#020617;color:#f1f5f9;',
      'border:1px solid #1e293b;border-radius:1rem;font-family:Georgia,"Times New Roman",serif;}',
      '.rd-head{display:flex;justify-content:space-between;align-items:center;gap:1rem;',
      'border-bottom:1px solid #1e293b;padding-bottom:1rem;margin-bottom:1.5rem;flex-wrap:wrap;}',
      '.rd h2{margin:0;font-size:1.5rem;}',
      '.rd .muted{margin:.25rem 0 0;font-size:.875rem;color:#94a3b8;}',
      '.rd-badge{padding:.35rem 1rem;border-radius:999px;font-size:.7rem;font-weight:700;',
      'letter-spacing:.06em;text-transform:uppercase;}',
      '.rd-badge-bad{background:rgba(245,158,11,.1);color:#fbbf24;border:1px solid rgba(245,158,11,.3);}',
      '.rd-badge-ok{background:rgba(16,185,129,.1);color:#34d399;border:1px solid rgba(16,185,129,.3);}',
      '.rd-escrow{padding:1rem;background:rgba(69,26,3,.2);border:1px solid rgba(245,158,11,.2);',
      'border-radius:.75rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem;}',
      '.rd-escrow h4{margin:0;color:#fcd34d;font-size:.875rem;}',
      '.rd-escrow .amt{font-family:ui-monospace,Consolas,monospace;font-size:1.125rem;color:#fbbf24;font-weight:700;}',
      '.rd-flag{padding:.75rem;background:rgba(69,10,10,.2);border:1px solid rgba(239,68,68,.3);',
      'border-radius:.5rem;margin:.5rem 0;display:flex;justify-content:space-between;gap:.75rem;font-size:.875rem;color:#fecaca;}',
      '.rd-sev{font-size:.7rem;font-family:ui-monospace,Consolas,monospace;background:rgba(127,29,29,.5);',
      'padding:.15rem .5rem;border-radius:.25rem;color:#fca5a5;white-space:nowrap;}',
      '.rd-box{padding:1.25rem;background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;margin-top:1rem;}',
      '.rd-box h3{margin:0 0 .5rem;font-size:1.125rem;}',
      '.rd-err{color:#f87171;font-size:.75rem;font-family:ui-monospace,Consolas,monospace;}',
      '.rd-ok{color:#34d399;font-size:.875rem;}',
      '.rd button{width:100%;margin-top:.75rem;padding:.55rem 1rem;border:0;border-radius:.375rem;',
      'background:#059669;color:#fff;font-weight:600;cursor:pointer;}',
      '.rd button:disabled{opacity:.5;cursor:not-allowed;}',
      '.rd input[type=file]{width:100%;color:#cbd5e1;font-size:.875rem;}'
    ].join('');
    document.head.appendChild(s);
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mountRemediationDashboard(container, options) {
    if (!container) return;
    options = options || {};
    ensureStyles();

    var userId = options.userId;
    var auditData = null;
    var selectedFile = null;
    var uploading = false;

    function render() {
      if (!auditData && !container._rdError) {
        container.innerHTML = '<div class="rd"><p class="muted">Loading FACTS compliance status...</p></div>';
        return;
      }
      if (container._rdError && !auditData) {
        container.innerHTML = '<div class="rd"><p class="rd-err">' + esc(container._rdError) + '</p></div>';
        return;
      }

      var isRemediation = auditData && auditData.status === 'REMEDIATION_REQUIRED';
      var badgeClass = isRemediation ? 'rd-badge-bad' : 'rd-badge-ok';
      var flagsHtml = '';
      if (isRemediation && auditData.flags && auditData.flags.length) {
        flagsHtml = '<h3 style="color:#f87171;margin:1rem 0 .5rem;">Active Discrepancy Flags</h3>';
        auditData.flags.forEach(function (flag) {
          flagsHtml +=
            '<div class="rd-flag"><span>' + esc(flag.message) + '</span>' +
            '<span class="rd-sev">Severity: ' + esc(flag.severity || 'WARNING') + '</span></div>';
        });
      }

      var escrowHtml = '';
      if (auditData.escrowedAmount > 0) {
        escrowHtml =
          '<div class="rd-escrow"><div><h4>Escrowed Affiliate Commissions</h4>' +
          '<p class="muted">Funds are temporarily held pending successful remediation clearance.</p></div>' +
          '<span class="amt">$' + Number(auditData.escrowedAmount).toFixed(2) + '</span></div>';
      }

      var uploadHtml = '';
      if (isRemediation) {
        uploadHtml =
          '<div class="rd-box">' +
          '<h3>Submit Corrective Statement for Expedited Re-Audit</h3>' +
          '<p class="muted">Upload your updated bank statement or corrective ledger file to resolve variances across Necessity, Reserve, Velocity, Growth, Lifestyle, and Legacy.</p>' +
          '<form id="rd-form">' +
          '<input type="file" accept=".csv,.pdf,.xlsx" />' +
          '<p class="rd-err" id="rd-err" hidden></p>' +
          '<p class="rd-ok" id="rd-msg" hidden></p>' +
          '<button type="submit"' + (uploading || !selectedFile ? ' disabled' : '') + '>' +
          (uploading ? 'Running Expedited Re-Audit...' : 'Submit for Re-Audit') +
          '</button></form></div>';
      } else {
        uploadHtml =
          '<div class="rd-box"><p class="rd-ok">Account is in good standing. No corrective upload required.</p>' +
          '<p class="muted">Cadence: ' + esc(auditData.auditCadence || '—') + '</p></div>';
      }

      container.innerHTML =
        '<div class="rd">' +
        '<div class="rd-head"><div>' +
        '<h2>FACTS Forensic Compliance Dashboard</h2>' +
        '<p class="muted">Monitoring your 6-bucket model integrity and audit milestones.</p>' +
        '</div><div class="rd-badge ' + badgeClass + '">' + esc(auditData.status || 'UNKNOWN') + '</div></div>' +
        escrowHtml + flagsHtml + uploadHtml +
        '</div>';

      var form = container.querySelector('#rd-form');
      if (!form) return;
      var input = form.querySelector('input[type=file]');
      var errEl = form.querySelector('#rd-err');
      var msgEl = form.querySelector('#rd-msg');
      var btn = form.querySelector('button');

      input.addEventListener('change', function (e) {
        selectedFile = (e.target.files && e.target.files[0]) || null;
        errEl.hidden = true;
        btn.disabled = uploading || !selectedFile;
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!selectedFile) {
          errEl.hidden = false;
          errEl.textContent = 'Please select a corrective statement or adjustment file first.';
          return;
        }
        uploading = true;
        btn.disabled = true;
        btn.textContent = 'Running Expedited Re-Audit...';
        errEl.hidden = true;
        msgEl.hidden = true;

        var fd = new FormData();
        fd.append('statement', selectedFile);
        if (userId != null) fd.append('userId', String(userId));

        fetch('/api/forensic/expedited-reaudit', {
          method: 'POST',
          credentials: 'include',
          body: fd
        })
          .then(function (res) {
            return res.json().then(function (result) {
              if (!res.ok) throw new Error(result.error || 'Re-audit submission failed.');
              return result;
            });
          })
          .then(function (result) {
            msgEl.hidden = false;
            msgEl.textContent = result.message || 'Re-audit complete.';
            if (result.data) {
              if (result.data.auditReport) {
                auditData = Object.assign({}, auditData, {
                  status: result.data.auditReport.status || (result.success ? 'CLEAN' : 'REMEDIATION_REQUIRED'),
                  flags: result.data.auditReport.flags || [],
                  bucketTotals: result.data.auditReport.bucketTotals || auditData.bucketTotals
                });
              } else if (result.data.status) {
                auditData = Object.assign({}, auditData, result.data);
              }
              if (result.success) auditData.escrowedAmount = 0;
            }
            selectedFile = null;
            uploading = false;
            render();
          })
          .catch(function (err) {
            uploading = false;
            errEl.hidden = false;
            errEl.textContent = err.message || 'Upload failed.';
            btn.disabled = !selectedFile;
            btn.textContent = 'Submit for Re-Audit';
          });
      });
    }

    container._rdError = null;
    render();

    var url = '/api/forensic/status' + (userId != null ? ('?userId=' + encodeURIComponent(userId)) : '');
    fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (result) {
          if (!res.ok) throw new Error(result.error || 'Failed to fetch audit status.');
          return result;
        });
      })
      .then(function (result) {
        auditData = result.data || {};
        render();
      })
      .catch(function (err) {
        container._rdError = err.message || 'Failed to load status.';
        render();
      });
  }

  global.mountRemediationDashboard = mountRemediationDashboard;
})(typeof window !== 'undefined' ? window : globalThis);
