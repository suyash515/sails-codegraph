module.exports = {
  friendlyName: 'Format welcome message',
  sync: true,
  inputs: { name: { type: 'string', required: true } },
  fn: function (inputs) {
    return `Welcome, ${inputs.name}!`;
  }
};
