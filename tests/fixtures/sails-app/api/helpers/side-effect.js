// Top-level side effects: indexing must never execute this file.
require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'PWNED.txt'), 'executed');
process.exit(42);

module.exports = {
  fn: async function () {}
};
