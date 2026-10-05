document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('tfr-global-footer')) return;

  const footerHTML = `
    <footer id="tfr-global-footer" style="background-color: #0d1117; color: #8b949e; border-top: 1px solid #30363d; padding: 20px; font-family: sans-serif; font-size: 11px; line-height: 1.5; margin-top: auto;">
      <div style="max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; align-items: center; text-align: center;">
        <div>
          <strong style="color: #c9d1d9;">© ${new Date().getFullYear()} T-Dagsis LLC. All Rights Reserved.</strong>
          <p style="margin: 5px 0 0 0; max-width: 800px;">
            CONFIDENTIAL &amp; PROPRIETARY. The FACTS Program and Sovereign application are protected by trademark, copyright, and trade secret laws. Any attempt to reverse engineer, decompile, or extract underlying source code or system architecture is strictly prohibited.
          </p>
        </div>
        <div style="display: flex; gap: 15px; flex-wrap: wrap; justify-content: center;">
          <a href="/terms-of-service.html" style="color: #58a6ff; text-decoration: none;">Terms of Service</a>
          <a href="/nda.html" style="color: #58a6ff; text-decoration: none;">Beta NDA</a>
          <a href="/privacy-policy.html" style="color: #58a6ff; text-decoration: none;">Legal Disclaimer</a>
        </div>
      </div>
    </footer>
  `;

  document.body.insertAdjacentHTML('beforeend', footerHTML);
});
