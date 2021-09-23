'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.BigNumber = void 0;
const bignumber_js_1 = require('bignumber.js');
Object.defineProperty(exports, 'BigNumber', {
    enumerable: true,
    get: function() {
        return bignumber_js_1.BigNumber;
    },
});
bignumber_js_1.BigNumber.config({
    EXPONENTIAL_AT: [-100, 100],
    ROUNDING_MODE: 1,
    DECIMAL_PLACES: 18,
});
