'use strict';

const { promoteFounderAdmin } = require('../lib/promoteFounderAdmin');

module.exports = {
  name: 'founder_admin_role',
  up: async (client) => {
    await promoteFounderAdmin(client);
  }
};
