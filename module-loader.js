/**
 * Module Loader
 *
 * Auto-discovers and mounts modules from the modules/ directory.
 * Each module's index.js exports:
 * - routes: Express router
 * - healthCheck: async function returning { status, version, lastMigration }
 * - metadata: { name, version, requiredCoreVersion, defaultEnabled }
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  educationalMetaMiddleware,
  isHighRiskModule,
} = require('./modules/shared/edu-compliance');
const { requireAuth } = require('./routes/auth');

const FINANCIAL_API_MODULES = new Set([
  'engine',
  'lending',
  'mod_brokerage',
  'mod_rate_radar',
  'mod_shopping',
  'mod_coaching',
  'mod_sweep',
  'mod_plaid',
  'mod_rewards',
  'mod_lending_desk',
  'mod_legacy_lens',
  'mod_forensic_audit',
  'mod_gamification',
  'mod_ssc',
  'mod_income',
  'tfr_vault_services'
]);

function requireAuthFinancial(req, res, next) {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/')) {
    return next();
  }
  if (req.baseUrl === '/api/engine' && req.path === '/process' && req.method === 'POST') {
    return next();
  }
  if (req.baseUrl === '/api/mod_coaching' && req.path === '/readiness' && req.method === 'POST') {
    return next();
  }
  return requireAuth(req, res, next);
}

module.exports = class ModuleLoader {
  constructor(pool, coreAPI) {
    this.pool = pool;
    this.coreAPI = coreAPI;
    this.modules = new Map();
    this.healthChecks = new Map();
  }

  /**
   * Discover all modules in the modules/ directory
   */
  async discoverModules() {
    const modulesDir = path.join(__dirname, 'modules');
    const tfr = path.join(__dirname, 'tfr_vault_services');

    if (!fs.existsSync(modulesDir)) {
      console.log('[ModuleLoader] No modules/ directory found');
      return;
    }

    const dirs = fs.readdirSync(modulesDir).filter(name => {
      const fullPath = path.join(modulesDir, name);
      return fs.statSync(fullPath).isDirectory() && name !== 'shared';
    });

    // Also check tfr_vault_services at root level
    if (fs.existsSync(tfr) && fs.statSync(tfr).isDirectory()) {
      dirs.push(path.basename(tfr));
    }

    for (const dir of dirs) {
      const moduleDir = dir === 'tfr_vault_services' ? tfr : path.join(modulesDir, dir);
      const indexPath = path.join(moduleDir, 'index.js');

      if (fs.existsSync(indexPath)) {
        try {
          const moduleExports = require(indexPath);
          const moduleId = path.basename(moduleDir);

          this.modules.set(moduleId, {
            id: moduleId,
            dir: moduleDir,
            exports: moduleExports,
            metadata: moduleExports.metadata || {}
          });

          if (moduleExports.healthCheck) {
            this.healthChecks.set(moduleId, moduleExports.healthCheck);
          }

          console.log(`[ModuleLoader] Discovered module: ${moduleId}`);
        } catch (err) {
          console.error(`[ModuleLoader] Failed to load module ${dir}:`, err.message);
        }
      }
    }
  }

  /**
   * Routes mount only when a global flag is enabled, or when no flag
   * exists and metadata.defaultEnabled is true. Host-gate mountRoot
   * still runs so education/engine routing does not depend on flags.
   */
  async isApiEnabled(moduleId, metadata) {
    try {
      const flagResult = await this.pool.query(
        'SELECT status FROM core.module_flags WHERE module_id = $1 AND user_id IS NULL',
        [moduleId]
      );
      if (flagResult.rows[0]) {
        return flagResult.rows[0].status === 'enabled';
      }
    } catch (err) {
      console.warn(`[ModuleLoader] module_flags lookup failed for ${moduleId}: ${err.message}`);
    }
    return metadata && metadata.defaultEnabled === true;
  }

  /**
   * Mount discovered modules onto an Express app
   */
  async mountModules(app) {
    for (const [moduleId, module] of this.modules) {
      try {
        const apiEnabled = await this.isApiEnabled(moduleId, module.metadata);
        if (module.exports.routes) {
          if (!apiEnabled) {
            console.log(`[ModuleLoader] Skipped API mount for ${moduleId} (disabled)`);
          } else {
            const baseRoute = `/api/${moduleId}`;
            if (isHighRiskModule(moduleId)) {
              app.use(baseRoute, educationalMetaMiddleware);
            }
            if (FINANCIAL_API_MODULES.has(moduleId)) {
              app.use(baseRoute, requireAuthFinancial);
            }
            app.use(baseRoute, module.exports.routes);
            console.log(`[ModuleLoader] Mounted routes for ${moduleId} at ${baseRoute}`);
          }
        }
        if (typeof module.exports.mountRoot === 'function') {
          module.exports.mountRoot(app);
          console.log(`[ModuleLoader] Mounted root handlers for ${moduleId}`);
        }
        if (module.exports.aliasRouter && apiEnabled) {
          app.use('/api/plaid', educationalMetaMiddleware);
          app.use('/api/plaid', requireAuthFinancial, module.exports.aliasRouter);
          console.log(`[ModuleLoader] Mounted alias routes for ${moduleId} at /api/plaid`);
        }
      } catch (err) {
        console.error(`[ModuleLoader] Failed to mount routes for ${moduleId}:`, err.message);
      }
    }

    // Health endpoints
    app.get('/api/system/health/modules', (req, res) => this.handleModuleHealth(req, res));
    app.get('/api/system/modules', (req, res) => this.handleModuleList(req, res));
  }

  /**
   * Get health status for all modules
   */
  async handleModuleHealth(req, res) {
    const health = {
      timestamp: new Date().toISOString(),
      modules: {}
    };

    for (const [moduleId, healthCheck] of this.healthChecks) {
      try {
        const result = await healthCheck(this.pool);
        health.modules[moduleId] = result;
      } catch (err) {
        health.modules[moduleId] = {
          status: 'error',
          error: err.message
        };
      }
    }

    res.json(health);
  }

  /**
   * Get list of all registered modules
   */
  async handleModuleList(req, res) {
    const modules = [];

    for (const [moduleId, module] of this.modules) {
      // Get current flag status
      const flagResult = await this.pool.query(
        'SELECT status FROM core.module_flags WHERE module_id = $1 AND user_id IS NULL',
        [moduleId]
      );

      modules.push({
        id: moduleId,
        metadata: module.metadata,
        status: flagResult.rows[0]?.status || 'unknown'
      });
    }

    res.json(modules);
  }

  /**
   * Get enabled modules for a specific user (for client-side rendering)
   */
  async getEnabledModules(userId = null) {
    const modules = [];

    for (const [moduleId, module] of this.modules) {
      // Check user-specific flag first
      if (userId) {
        const userFlag = await this.pool.query(
          'SELECT status FROM core.module_flags WHERE module_id = $1 AND user_id = $2',
          [moduleId, userId]
        );
        if (userFlag.rows[0]?.status === 'enabled') {
          modules.push(moduleId);
          continue;
        }
      }

      // Fall back to global flag
      const globalFlag = await this.pool.query(
        'SELECT status FROM core.module_flags WHERE module_id = $1 AND user_id IS NULL',
        [moduleId]
      );

      if (globalFlag.rows[0]?.status === 'enabled') {
        modules.push(moduleId);
      }
    }

    return modules;
  }

  /**
   * Get all modules regardless of flag (for preview environment)
   */
  async getAllModules() {
    return Array.from(this.modules.keys());
  }

  /**
   * Get module by ID
   */
  getModule(moduleId) {
    return this.modules.get(moduleId);
  }
};
