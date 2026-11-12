module.exports = async function (req, res, proceed) {
  if (req.me && req.me.isAdmin) { return proceed(); }
  return res.forbidden();
};
