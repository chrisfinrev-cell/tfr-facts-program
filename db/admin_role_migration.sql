-- 1. Add admin status column
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) DEFAULT 'member';

-- 2. Grant admin rights to the founder account
UPDATE users
   SET is_admin = TRUE,
       is_creator = TRUE,
       role = 'ADMIN'
 WHERE LOWER(email) = LOWER('chris.finrev@gmail.com');

-- 3. Admin can invite testers but cannot hold income-program house positions
DELETE FROM affiliate_houses
 WHERE user_id IN (SELECT id FROM users WHERE is_admin = TRUE);

-- 4. Admin-determined income-program eligibility (default: eligible)
ALTER TABLE users ADD COLUMN IF NOT EXISTS income_programs_blocked BOOLEAN DEFAULT FALSE;
