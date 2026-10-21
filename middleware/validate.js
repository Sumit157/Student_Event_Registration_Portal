'use strict';

/**
 * middleware/validate.js
 * Bridges express-validator into the project's error contract.
 *
 * Route files declare their chains; this helper executes them and, on the
 * first failure, throws a 400 ApiError carrying per-field messages so the
 * frontend can highlight the offending inputs.
 */

const { validationResult } = require('express-validator');
const { ApiError } = require('../utils/errors');

/**
 * Run the supplied validation chains in order.
 * @param {Array} chains express-validator validation chains
 */
function validate(chains) {
  return async function validationMiddleware(req, _res, next) {
    await Promise.all(chains.map((chain) => chain.run(req)));

    const result = validationResult(req);
    if (result.isEmpty()) return next();

    const details = result.array().map((issue) => ({
      field: issue.path || issue.param || 'unknown',
      message: issue.msg,
      value: undefined, // never echo submitted values back
    }));

    // Deduplicate by field, keeping the first message per field.
    const seen = new Set();
    const unique = details.filter((d) => (seen.has(d.field) ? false : (seen.add(d.field), true)));

    return next(ApiError.badRequest(
      unique.length === 1 ? unique[0].message : 'Please correct the highlighted fields.',
      'VALIDATION_FAILED',
      unique
    ));
  };
}

module.exports = { validate };
