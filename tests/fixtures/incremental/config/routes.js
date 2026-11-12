module.exports.routes = {
  'POST /api/payments': 'payment/create',
  ...require('./routes/reports')
};
