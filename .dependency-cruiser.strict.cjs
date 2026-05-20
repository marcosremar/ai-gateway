const base = require('./.dependency-cruiser.cjs');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  ...base,
  forbidden: [
    ...base.forbidden,
    {
      name: 'no-circular-dependencies',
      severity: 'warn',
      comment: 'Cycles make AI-generated changes harder to localize. Ratchet this to error after current debt is cleaned.',
      from: {},
      to: { circular: true },
    },
  ],
};
