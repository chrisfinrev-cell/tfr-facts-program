-- 1. Add admin status column
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- 2. Grant superadmin rights to the founder account
UPDATE users SET is_admin = TRUE WHERE LOWER(email) = LOWER('chris.finrev@gmail.com');

-- 3. Admin can invite testers but cannot hold income-program house positions
DELETE FROM affiliate_houses
 WHERE user_id IN (SELECT id FROM users WHERE is_admin = TRUE);

-- 4. Admin-determined income-program eligibility (default: eligible)
ALTER TABLE users ADD COLUMN IF NOT EXISTS income_programs_blocked BOOLEAN DEFAULT FALSE;
