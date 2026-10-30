/**
 * PM2 production process file
 * Usage (Windows PowerShell):
 *   $env:DOTENV_CONFIG_PATH='.env.production'
 *   node -r dotenv/config node_modules/pm2/bin/pm2 start ecosystem.config.js --env production
 *
 * Do not pass dotenv_config_path=... as a trailing pm2 arg — pm2 treats it as a script path.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '.env.production') });

module.exports = {
  apps: [
    {
      name: 'facts-api-server',
      script: 'server.js',
      instances: 2, // Scaled down to free host memory
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'sovereign-lens-cron',
      script: 'jobs/sovereign-lens-nightly.js',
      cron_restart: '1 0 * * *',
      autorestart: false,
      env_production: {
        NODE_ENV: 'production'
      }
    },
    {
      // Long-running node-cron worker (daily 08:00 local) — avoids double-send with cron_restart
      name: 'audit-milestone-worker',
      script: 'workers/auditCronWorker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
