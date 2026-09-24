const express = require('express');
const { handleWebhook } = require('../controllers/sumsubController');
module.exports = { router: express.Router(), webhook: handleWebhook };
