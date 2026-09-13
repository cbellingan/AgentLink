var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/qrcode/lib/can-promise.js
var require_can_promise = __commonJS({
  "node_modules/qrcode/lib/can-promise.js"(exports, module) {
    module.exports = function() {
      return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
    };
  }
});

// node_modules/qrcode/lib/core/utils.js
var require_utils = __commonJS({
  "node_modules/qrcode/lib/core/utils.js"(exports) {
    var toSJISFunction;
    var CODEWORDS_COUNT = [
      0,
      // Not used
      26,
      44,
      70,
      100,
      134,
      172,
      196,
      242,
      292,
      346,
      404,
      466,
      532,
      581,
      655,
      733,
      815,
      901,
      991,
      1085,
      1156,
      1258,
      1364,
      1474,
      1588,
      1706,
      1828,
      1921,
      2051,
      2185,
      2323,
      2465,
      2611,
      2761,
      2876,
      3034,
      3196,
      3362,
      3532,
      3706
    ];
    exports.getSymbolSize = function getSymbolSize(version) {
      if (!version) throw new Error('"version" cannot be null or undefined');
      if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
      return version * 4 + 17;
    };
    exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
      return CODEWORDS_COUNT[version];
    };
    exports.getBCHDigit = function(data) {
      let digit = 0;
      while (data !== 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    };
    exports.setToSJISFunction = function setToSJISFunction(f) {
      if (typeof f !== "function") {
        throw new Error('"toSJISFunc" is not a valid function.');
      }
      toSJISFunction = f;
    };
    exports.isKanjiModeEnabled = function() {
      return typeof toSJISFunction !== "undefined";
    };
    exports.toSJIS = function toSJIS(kanji) {
      return toSJISFunction(kanji);
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-level.js
var require_error_correction_level = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
    exports.L = { bit: 1 };
    exports.M = { bit: 0 };
    exports.Q = { bit: 3 };
    exports.H = { bit: 2 };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "l":
        case "low":
          return exports.L;
        case "m":
        case "medium":
          return exports.M;
        case "q":
        case "quartile":
          return exports.Q;
        case "h":
        case "high":
          return exports.H;
        default:
          throw new Error("Unknown EC Level: " + string);
      }
    }
    exports.isValid = function isValid(level) {
      return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
    };
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/bit-buffer.js
var require_bit_buffer = __commonJS({
  "node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
      getLengthInBits: function() {
        return this.length;
      },
      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
    };
    module.exports = BitBuffer;
  }
});

// node_modules/qrcode/lib/core/bit-matrix.js
var require_bit_matrix = __commonJS({
  "node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
    function BitMatrix(size) {
      if (!size || size < 1) {
        throw new Error("BitMatrix size must be defined and greater than 0");
      }
      this.size = size;
      this.data = new Uint8Array(size * size);
      this.reservedBit = new Uint8Array(size * size);
    }
    BitMatrix.prototype.set = function(row, col, value, reserved) {
      const index = row * this.size + col;
      this.data[index] = value;
      if (reserved) this.reservedBit[index] = true;
    };
    BitMatrix.prototype.get = function(row, col) {
      return this.data[row * this.size + col];
    };
    BitMatrix.prototype.xor = function(row, col, value) {
      this.data[row * this.size + col] ^= value;
    };
    BitMatrix.prototype.isReserved = function(row, col) {
      return this.reservedBit[row * this.size + col];
    };
    module.exports = BitMatrix;
  }
});

// node_modules/qrcode/lib/core/alignment-pattern.js
var require_alignment_pattern = __commonJS({
  "node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    exports.getRowColCoords = function getRowColCoords(version) {
      if (version === 1) return [];
      const posCount = Math.floor(version / 7) + 2;
      const size = getSymbolSize(version);
      const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
      const positions = [size - 7];
      for (let i = 1; i < posCount - 1; i++) {
        positions[i] = positions[i - 1] - intervals;
      }
      positions.push(6);
      return positions.reverse();
    };
    exports.getPositions = function getPositions(version) {
      const coords = [];
      const pos = exports.getRowColCoords(version);
      const posLength = pos.length;
      for (let i = 0; i < posLength; i++) {
        for (let j = 0; j < posLength; j++) {
          if (i === 0 && j === 0 || // top-left
          i === 0 && j === posLength - 1 || // bottom-left
          i === posLength - 1 && j === 0) {
            continue;
          }
          coords.push([pos[i], pos[j]]);
        }
      }
      return coords;
    };
  }
});

// node_modules/qrcode/lib/core/finder-pattern.js
var require_finder_pattern = __commonJS({
  "node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    var FINDER_PATTERN_SIZE = 7;
    exports.getPositions = function getPositions(version) {
      const size = getSymbolSize(version);
      return [
        // top-left
        [0, 0],
        // top-right
        [size - FINDER_PATTERN_SIZE, 0],
        // bottom-left
        [0, size - FINDER_PATTERN_SIZE]
      ];
    };
  }
});

// node_modules/qrcode/lib/core/mask-pattern.js
var require_mask_pattern = __commonJS({
  "node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
    exports.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    var PenaltyScores = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    exports.isValid = function isValid(mask) {
      return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
    };
    exports.from = function from(value) {
      return exports.isValid(value) ? parseInt(value, 10) : void 0;
    };
    exports.getPenaltyN1 = function getPenaltyN1(data) {
      const size = data.size;
      let points = 0;
      let sameCountCol = 0;
      let sameCountRow = 0;
      let lastCol = null;
      let lastRow = null;
      for (let row = 0; row < size; row++) {
        sameCountCol = sameCountRow = 0;
        lastCol = lastRow = null;
        for (let col = 0; col < size; col++) {
          let module2 = data.get(row, col);
          if (module2 === lastCol) {
            sameCountCol++;
          } else {
            if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
            lastCol = module2;
            sameCountCol = 1;
          }
          module2 = data.get(col, row);
          if (module2 === lastRow) {
            sameCountRow++;
          } else {
            if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
            lastRow = module2;
            sameCountRow = 1;
          }
        }
        if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
        if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
      }
      return points;
    };
    exports.getPenaltyN2 = function getPenaltyN2(data) {
      const size = data.size;
      let points = 0;
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
          if (last === 4 || last === 0) points++;
        }
      }
      return points * PenaltyScores.N2;
    };
    exports.getPenaltyN3 = function getPenaltyN3(data) {
      const size = data.size;
      let points = 0;
      let bitsCol = 0;
      let bitsRow = 0;
      for (let row = 0; row < size; row++) {
        bitsCol = bitsRow = 0;
        for (let col = 0; col < size; col++) {
          bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
          if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
          bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
          if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
        }
      }
      return points * PenaltyScores.N3;
    };
    exports.getPenaltyN4 = function getPenaltyN4(data) {
      let darkCount = 0;
      const modulesCount = data.data.length;
      for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
      const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
      return k * PenaltyScores.N4;
    };
    function getMaskAt(maskPattern, i, j) {
      switch (maskPattern) {
        case exports.Patterns.PATTERN000:
          return (i + j) % 2 === 0;
        case exports.Patterns.PATTERN001:
          return i % 2 === 0;
        case exports.Patterns.PATTERN010:
          return j % 3 === 0;
        case exports.Patterns.PATTERN011:
          return (i + j) % 3 === 0;
        case exports.Patterns.PATTERN100:
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case exports.Patterns.PATTERN101:
          return i * j % 2 + i * j % 3 === 0;
        case exports.Patterns.PATTERN110:
          return (i * j % 2 + i * j % 3) % 2 === 0;
        case exports.Patterns.PATTERN111:
          return (i * j % 3 + (i + j) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + maskPattern);
      }
    }
    exports.applyMask = function applyMask(pattern, data) {
      const size = data.size;
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (data.isReserved(row, col)) continue;
          data.xor(row, col, getMaskAt(pattern, row, col));
        }
      }
    };
    exports.getBestMask = function getBestMask(data, setupFormatFunc) {
      const numPatterns = Object.keys(exports.Patterns).length;
      let bestPattern = 0;
      let lowerPenalty = Infinity;
      for (let p = 0; p < numPatterns; p++) {
        setupFormatFunc(p);
        exports.applyMask(p, data);
        const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
        exports.applyMask(p, data);
        if (penalty < lowerPenalty) {
          lowerPenalty = penalty;
          bestPattern = p;
        }
      }
      return bestPattern;
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-code.js
var require_error_correction_code = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
    var ECLevel = require_error_correction_level();
    var EC_BLOCKS_TABLE = [
      // L  M  Q  H
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      1,
      2,
      2,
      4,
      1,
      2,
      4,
      4,
      2,
      4,
      4,
      4,
      2,
      4,
      6,
      5,
      2,
      4,
      6,
      6,
      2,
      5,
      8,
      8,
      4,
      5,
      8,
      8,
      4,
      5,
      8,
      11,
      4,
      8,
      10,
      11,
      4,
      9,
      12,
      16,
      4,
      9,
      16,
      16,
      6,
      10,
      12,
      18,
      6,
      10,
      17,
      16,
      6,
      11,
      16,
      19,
      6,
      13,
      18,
      21,
      7,
      14,
      21,
      25,
      8,
      16,
      20,
      25,
      8,
      17,
      23,
      25,
      9,
      17,
      23,
      34,
      9,
      18,
      25,
      30,
      10,
      20,
      27,
      32,
      12,
      21,
      29,
      35,
      12,
      23,
      34,
      37,
      12,
      25,
      34,
      40,
      13,
      26,
      35,
      42,
      14,
      28,
      38,
      45,
      15,
      29,
      40,
      48,
      16,
      31,
      43,
      51,
      17,
      33,
      45,
      54,
      18,
      35,
      48,
      57,
      19,
      37,
      51,
      60,
      19,
      38,
      53,
      63,
      20,
      40,
      56,
      66,
      21,
      43,
      59,
      70,
      22,
      45,
      62,
      74,
      24,
      47,
      65,
      77,
      25,
      49,
      68,
      81
    ];
    var EC_CODEWORDS_TABLE = [
      // L  M  Q  H
      7,
      10,
      13,
      17,
      10,
      16,
      22,
      28,
      15,
      26,
      36,
      44,
      20,
      36,
      52,
      64,
      26,
      48,
      72,
      88,
      36,
      64,
      96,
      112,
      40,
      72,
      108,
      130,
      48,
      88,
      132,
      156,
      60,
      110,
      160,
      192,
      72,
      130,
      192,
      224,
      80,
      150,
      224,
      264,
      96,
      176,
      260,
      308,
      104,
      198,
      288,
      352,
      120,
      216,
      320,
      384,
      132,
      240,
      360,
      432,
      144,
      280,
      408,
      480,
      168,
      308,
      448,
      532,
      180,
      338,
      504,
      588,
      196,
      364,
      546,
      650,
      224,
      416,
      600,
      700,
      224,
      442,
      644,
      750,
      252,
      476,
      690,
      816,
      270,
      504,
      750,
      900,
      300,
      560,
      810,
      960,
      312,
      588,
      870,
      1050,
      336,
      644,
      952,
      1110,
      360,
      700,
      1020,
      1200,
      390,
      728,
      1050,
      1260,
      420,
      784,
      1140,
      1350,
      450,
      812,
      1200,
      1440,
      480,
      868,
      1290,
      1530,
      510,
      924,
      1350,
      1620,
      540,
      980,
      1440,
      1710,
      570,
      1036,
      1530,
      1800,
      570,
      1064,
      1590,
      1890,
      600,
      1120,
      1680,
      1980,
      630,
      1204,
      1770,
      2100,
      660,
      1260,
      1860,
      2220,
      720,
      1316,
      1950,
      2310,
      750,
      1372,
      2040,
      2430
    ];
    exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
  }
});

// node_modules/qrcode/lib/core/galois-field.js
var require_galois_field = __commonJS({
  "node_modules/qrcode/lib/core/galois-field.js"(exports) {
    var EXP_TABLE = new Uint8Array(512);
    var LOG_TABLE = new Uint8Array(256);
    (function initTables() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 256) {
          x ^= 285;
        }
      }
      for (let i = 255; i < 512; i++) {
        EXP_TABLE[i] = EXP_TABLE[i - 255];
      }
    })();
    exports.log = function log(n) {
      if (n < 1) throw new Error("log(" + n + ")");
      return LOG_TABLE[n];
    };
    exports.exp = function exp(n) {
      return EXP_TABLE[n];
    };
    exports.mul = function mul(x, y) {
      if (x === 0 || y === 0) return 0;
      return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
    };
  }
});

// node_modules/qrcode/lib/core/polynomial.js
var require_polynomial = __commonJS({
  "node_modules/qrcode/lib/core/polynomial.js"(exports) {
    var GF = require_galois_field();
    exports.mul = function mul(p1, p2) {
      const coeff = new Uint8Array(p1.length + p2.length - 1);
      for (let i = 0; i < p1.length; i++) {
        for (let j = 0; j < p2.length; j++) {
          coeff[i + j] ^= GF.mul(p1[i], p2[j]);
        }
      }
      return coeff;
    };
    exports.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0) offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
  }
});

// node_modules/qrcode/lib/core/reed-solomon-encoder.js
var require_reed_solomon_encoder = __commonJS({
  "node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
    var Polynomial = require_polynomial();
    function ReedSolomonEncoder(degree) {
      this.genPoly = void 0;
      this.degree = degree;
      if (this.degree) this.initialize(this.degree);
    }
    ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
      this.degree = degree;
      this.genPoly = Polynomial.generateECPolynomial(this.degree);
    };
    ReedSolomonEncoder.prototype.encode = function encode(data) {
      if (!this.genPoly) {
        throw new Error("Encoder not initialized");
      }
      const paddedData = new Uint8Array(data.length + this.degree);
      paddedData.set(data);
      const remainder = Polynomial.mod(paddedData, this.genPoly);
      const start = this.degree - remainder.length;
      if (start > 0) {
        const buff = new Uint8Array(this.degree);
        buff.set(remainder, start);
        return buff;
      }
      return remainder;
    };
    module.exports = ReedSolomonEncoder;
  }
});

// node_modules/qrcode/lib/core/version-check.js
var require_version_check = __commonJS({
  "node_modules/qrcode/lib/core/version-check.js"(exports) {
    exports.isValid = function isValid(version) {
      return !isNaN(version) && version >= 1 && version <= 40;
    };
  }
});

// node_modules/qrcode/lib/core/regex.js
var require_regex = __commonJS({
  "node_modules/qrcode/lib/core/regex.js"(exports) {
    var numeric = "[0-9]+";
    var alphanumeric = "[A-Z $%*+\\-./:]+";
    var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
    kanji = kanji.replace(/u/g, "\\u");
    var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
    exports.KANJI = new RegExp(kanji, "g");
    exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
    exports.BYTE = new RegExp(byte, "g");
    exports.NUMERIC = new RegExp(numeric, "g");
    exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
    var TEST_KANJI = new RegExp("^" + kanji + "$");
    var TEST_NUMERIC = new RegExp("^" + numeric + "$");
    var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
    exports.testKanji = function testKanji(str) {
      return TEST_KANJI.test(str);
    };
    exports.testNumeric = function testNumeric(str) {
      return TEST_NUMERIC.test(str);
    };
    exports.testAlphanumeric = function testAlphanumeric(str) {
      return TEST_ALPHANUMERIC.test(str);
    };
  }
});

// node_modules/qrcode/lib/core/mode.js
var require_mode = __commonJS({
  "node_modules/qrcode/lib/core/mode.js"(exports) {
    var VersionCheck = require_version_check();
    var Regex = require_regex();
    exports.NUMERIC = {
      id: "Numeric",
      bit: 1 << 0,
      ccBits: [10, 12, 14]
    };
    exports.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 1 << 1,
      ccBits: [9, 11, 13]
    };
    exports.BYTE = {
      id: "Byte",
      bit: 1 << 2,
      ccBits: [8, 16, 16]
    };
    exports.KANJI = {
      id: "Kanji",
      bit: 1 << 3,
      ccBits: [8, 10, 12]
    };
    exports.MIXED = {
      bit: -1
    };
    exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
      if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid version: " + version);
      }
      if (version >= 1 && version < 10) return mode.ccBits[0];
      else if (version < 27) return mode.ccBits[1];
      return mode.ccBits[2];
    };
    exports.getBestModeForData = function getBestModeForData(dataStr) {
      if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
      else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
      else if (Regex.testKanji(dataStr)) return exports.KANJI;
      else return exports.BYTE;
    };
    exports.toString = function toString(mode) {
      if (mode && mode.id) return mode.id;
      throw new Error("Invalid mode");
    };
    exports.isValid = function isValid(mode) {
      return mode && mode.bit && mode.ccBits;
    };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "numeric":
          return exports.NUMERIC;
        case "alphanumeric":
          return exports.ALPHANUMERIC;
        case "kanji":
          return exports.KANJI;
        case "byte":
          return exports.BYTE;
        default:
          throw new Error("Unknown mode: " + string);
      }
    }
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/version.js
var require_version = __commonJS({
  "node_modules/qrcode/lib/core/version.js"(exports) {
    var Utils = require_utils();
    var ECCode = require_error_correction_code();
    var ECLevel = require_error_correction_level();
    var Mode = require_mode();
    var VersionCheck = require_version_check();
    var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    var G18_BCH = Utils.getBCHDigit(G18);
    function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    function getReservedBitsCount(mode, version) {
      return Mode.getCharCountIndicator(mode, version) + 4;
    }
    function getTotalBitsFromDataArray(segments, version) {
      let totalBits = 0;
      segments.forEach(function(data) {
        const reservedBits = getReservedBitsCount(data.mode, version);
        totalBits += reservedBits + data.getBitsLength();
      });
      return totalBits;
    }
    function getBestVersionForMixedData(segments, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        const length = getTotalBitsFromDataArray(segments, currentVersion);
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    exports.from = function from(value, defaultValue) {
      if (VersionCheck.isValid(value)) {
        return parseInt(value, 10);
      }
      return defaultValue;
    };
    exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid QR Code version");
      }
      if (typeof mode === "undefined") mode = Mode.BYTE;
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (mode === Mode.MIXED) return dataTotalCodewordsBits;
      const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
      switch (mode) {
        case Mode.NUMERIC:
          return Math.floor(usableBits / 10 * 3);
        case Mode.ALPHANUMERIC:
          return Math.floor(usableBits / 11 * 2);
        case Mode.KANJI:
          return Math.floor(usableBits / 13);
        case Mode.BYTE:
        default:
          return Math.floor(usableBits / 8);
      }
    };
    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
      let seg;
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getBestVersionForMixedData(data, ecl);
        }
        if (data.length === 0) {
          return 1;
        }
        seg = data[0];
      } else {
        seg = data;
      }
      return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
    };
    exports.getEncodedBits = function getEncodedBits(version) {
      if (!VersionCheck.isValid(version) || version < 7) {
        throw new Error("Invalid QR Code version");
      }
      let d = version << 12;
      while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
        d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
      }
      return version << 12 | d;
    };
  }
});

// node_modules/qrcode/lib/core/format-info.js
var require_format_info = __commonJS({
  "node_modules/qrcode/lib/core/format-info.js"(exports) {
    var Utils = require_utils();
    var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    var G15_BCH = Utils.getBCHDigit(G15);
    exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
      const data = errorCorrectionLevel.bit << 3 | mask;
      let d = data << 10;
      while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
        d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
      }
      return (data << 10 | d) ^ G15_MASK;
    };
  }
});

// node_modules/qrcode/lib/core/numeric-data.js
var require_numeric_data = __commonJS({
  "node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
    var Mode = require_mode();
    function NumericData(data) {
      this.mode = Mode.NUMERIC;
      this.data = data.toString();
    }
    NumericData.getBitsLength = function getBitsLength(length) {
      return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
    };
    NumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    NumericData.prototype.getBitsLength = function getBitsLength() {
      return NumericData.getBitsLength(this.data.length);
    };
    NumericData.prototype.write = function write(bitBuffer) {
      let i, group, value;
      for (i = 0; i + 3 <= this.data.length; i += 3) {
        group = this.data.substr(i, 3);
        value = parseInt(group, 10);
        bitBuffer.put(value, 10);
      }
      const remainingNum = this.data.length - i;
      if (remainingNum > 0) {
        group = this.data.substr(i);
        value = parseInt(group, 10);
        bitBuffer.put(value, remainingNum * 3 + 1);
      }
    };
    module.exports = NumericData;
  }
});

// node_modules/qrcode/lib/core/alphanumeric-data.js
var require_alphanumeric_data = __commonJS({
  "node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
    var Mode = require_mode();
    var ALPHA_NUM_CHARS = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
      " ",
      "$",
      "%",
      "*",
      "+",
      "-",
      ".",
      "/",
      ":"
    ];
    function AlphanumericData(data) {
      this.mode = Mode.ALPHANUMERIC;
      this.data = data;
    }
    AlphanumericData.getBitsLength = function getBitsLength(length) {
      return 11 * Math.floor(length / 2) + 6 * (length % 2);
    };
    AlphanumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    AlphanumericData.prototype.getBitsLength = function getBitsLength() {
      return AlphanumericData.getBitsLength(this.data.length);
    };
    AlphanumericData.prototype.write = function write(bitBuffer) {
      let i;
      for (i = 0; i + 2 <= this.data.length; i += 2) {
        let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
        value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
        bitBuffer.put(value, 11);
      }
      if (this.data.length % 2) {
        bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
      }
    };
    module.exports = AlphanumericData;
  }
});

// node_modules/qrcode/lib/core/byte-data.js
var require_byte_data = __commonJS({
  "node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
    var Mode = require_mode();
    function ByteData(data) {
      this.mode = Mode.BYTE;
      if (typeof data === "string") {
        this.data = new TextEncoder().encode(data);
      } else {
        this.data = new Uint8Array(data);
      }
    }
    ByteData.getBitsLength = function getBitsLength(length) {
      return length * 8;
    };
    ByteData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    ByteData.prototype.getBitsLength = function getBitsLength() {
      return ByteData.getBitsLength(this.data.length);
    };
    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
    module.exports = ByteData;
  }
});

// node_modules/qrcode/lib/core/kanji-data.js
var require_kanji_data = __commonJS({
  "node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
    var Mode = require_mode();
    var Utils = require_utils();
    function KanjiData(data) {
      this.mode = Mode.KANJI;
      this.data = data;
    }
    KanjiData.getBitsLength = function getBitsLength(length) {
      return length * 13;
    };
    KanjiData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    KanjiData.prototype.getBitsLength = function getBitsLength() {
      return KanjiData.getBitsLength(this.data.length);
    };
    KanjiData.prototype.write = function(bitBuffer) {
      let i;
      for (i = 0; i < this.data.length; i++) {
        let value = Utils.toSJIS(this.data[i]);
        if (value >= 33088 && value <= 40956) {
          value -= 33088;
        } else if (value >= 57408 && value <= 60351) {
          value -= 49472;
        } else {
          throw new Error(
            "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
          );
        }
        value = (value >>> 8 & 255) * 192 + (value & 255);
        bitBuffer.put(value, 13);
      }
    };
    module.exports = KanjiData;
  }
});

// node_modules/dijkstrajs/dijkstra.js
var require_dijkstra = __commonJS({
  "node_modules/dijkstrajs/dijkstra.js"(exports, module) {
    "use strict";
    var dijkstra = {
      single_source_shortest_paths: function(graph, s, d) {
        var predecessors = {};
        var costs = {};
        costs[s] = 0;
        var open = dijkstra.PriorityQueue.make();
        open.push(s, 0);
        var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
        while (!open.empty()) {
          closest = open.pop();
          u = closest.value;
          cost_of_s_to_u = closest.cost;
          adjacent_nodes = graph[u] || {};
          for (v in adjacent_nodes) {
            if (adjacent_nodes.hasOwnProperty(v)) {
              cost_of_e = adjacent_nodes[v];
              cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
              cost_of_s_to_v = costs[v];
              first_visit = typeof costs[v] === "undefined";
              if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                costs[v] = cost_of_s_to_u_plus_cost_of_e;
                open.push(v, cost_of_s_to_u_plus_cost_of_e);
                predecessors[v] = u;
              }
            }
          }
        }
        if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
          var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
          throw new Error(msg);
        }
        return predecessors;
      },
      extract_shortest_path_from_predecessor_list: function(predecessors, d) {
        var nodes = [];
        var u = d;
        var predecessor;
        while (u) {
          nodes.push(u);
          predecessor = predecessors[u];
          u = predecessors[u];
        }
        nodes.reverse();
        return nodes;
      },
      find_path: function(graph, s, d) {
        var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
        return dijkstra.extract_shortest_path_from_predecessor_list(
          predecessors,
          d
        );
      },
      /**
       * A very naive priority queue implementation.
       */
      PriorityQueue: {
        make: function(opts) {
          var T = dijkstra.PriorityQueue, t = {}, key;
          opts = opts || {};
          for (key in T) {
            if (T.hasOwnProperty(key)) {
              t[key] = T[key];
            }
          }
          t.queue = [];
          t.sorter = opts.sorter || T.default_sorter;
          return t;
        },
        default_sorter: function(a, b) {
          return a.cost - b.cost;
        },
        /**
         * Add a new item to the queue and ensure the highest priority element
         * is at the front of the queue.
         */
        push: function(value, cost) {
          var item = { value, cost };
          this.queue.push(item);
          this.queue.sort(this.sorter);
        },
        /**
         * Return the highest priority element in the queue.
         */
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    if (typeof module !== "undefined") {
      module.exports = dijkstra;
    }
  }
});

// node_modules/qrcode/lib/core/segments.js
var require_segments = __commonJS({
  "node_modules/qrcode/lib/core/segments.js"(exports) {
    var Mode = require_mode();
    var NumericData = require_numeric_data();
    var AlphanumericData = require_alphanumeric_data();
    var ByteData = require_byte_data();
    var KanjiData = require_kanji_data();
    var Regex = require_regex();
    var Utils = require_utils();
    var dijkstra = require_dijkstra();
    function getStringByteLength(str) {
      return unescape(encodeURIComponent(str)).length;
    }
    function getSegments(regex, mode, str) {
      const segments = [];
      let result;
      while ((result = regex.exec(str)) !== null) {
        segments.push({
          data: result[0],
          index: result.index,
          mode,
          length: result[0].length
        });
      }
      return segments;
    }
    function getSegmentsFromString(dataStr) {
      const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
      const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
      let byteSegs;
      let kanjiSegs;
      if (Utils.isKanjiModeEnabled()) {
        byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
        kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
      } else {
        byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
        kanjiSegs = [];
      }
      const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
      return segs.sort(function(s1, s2) {
        return s1.index - s2.index;
      }).map(function(obj) {
        return {
          data: obj.data,
          mode: obj.mode,
          length: obj.length
        };
      });
    }
    function getSegmentBitsLength(length, mode) {
      switch (mode) {
        case Mode.NUMERIC:
          return NumericData.getBitsLength(length);
        case Mode.ALPHANUMERIC:
          return AlphanumericData.getBitsLength(length);
        case Mode.KANJI:
          return KanjiData.getBitsLength(length);
        case Mode.BYTE:
          return ByteData.getBitsLength(length);
      }
    }
    function mergeSegments(segs) {
      return segs.reduce(function(acc, curr) {
        const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
        if (prevSeg && prevSeg.mode === curr.mode) {
          acc[acc.length - 1].data += curr.data;
          return acc;
        }
        acc.push(curr);
        return acc;
      }, []);
    }
    function buildNodes(segs) {
      const nodes = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        switch (seg.mode) {
          case Mode.NUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.ALPHANUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.KANJI:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
            break;
          case Mode.BYTE:
            nodes.push([
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
        }
      }
      return nodes;
    }
    function buildGraph(nodes, version) {
      const table = {};
      const graph = { start: {} };
      let prevNodeIds = ["start"];
      for (let i = 0; i < nodes.length; i++) {
        const nodeGroup = nodes[i];
        const currentNodeIds = [];
        for (let j = 0; j < nodeGroup.length; j++) {
          const node = nodeGroup[j];
          const key = "" + i + j;
          currentNodeIds.push(key);
          table[key] = { node, lastCount: 0 };
          graph[key] = {};
          for (let n = 0; n < prevNodeIds.length; n++) {
            const prevNodeId = prevNodeIds[n];
            if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
              graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
              table[prevNodeId].lastCount += node.length;
            } else {
              if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
              graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
            }
          }
        }
        prevNodeIds = currentNodeIds;
      }
      for (let n = 0; n < prevNodeIds.length; n++) {
        graph[prevNodeIds[n]].end = 0;
      }
      return { map: graph, table };
    }
    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
      if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
        throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
      }
      if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
        mode = Mode.BYTE;
      }
      switch (mode) {
        case Mode.NUMERIC:
          return new NumericData(data);
        case Mode.ALPHANUMERIC:
          return new AlphanumericData(data);
        case Mode.KANJI:
          return new KanjiData(data);
        case Mode.BYTE:
          return new ByteData(data);
      }
    }
    exports.fromArray = function fromArray(array) {
      return array.reduce(function(acc, seg) {
        if (typeof seg === "string") {
          acc.push(buildSingleSegment(seg, null));
        } else if (seg.data) {
          acc.push(buildSingleSegment(seg.data, seg.mode));
        }
        return acc;
      }, []);
    };
    exports.fromString = function fromString(data, version) {
      const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
      const nodes = buildNodes(segs);
      const graph = buildGraph(nodes, version);
      const path = dijkstra.find_path(graph.map, "start", "end");
      const optimizedSegs = [];
      for (let i = 1; i < path.length - 1; i++) {
        optimizedSegs.push(graph.table[path[i]].node);
      }
      return exports.fromArray(mergeSegments(optimizedSegs));
    };
    exports.rawSplit = function rawSplit(data) {
      return exports.fromArray(
        getSegmentsFromString(data, Utils.isKanjiModeEnabled())
      );
    };
  }
});

// node_modules/qrcode/lib/core/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode/lib/core/qrcode.js"(exports) {
    var Utils = require_utils();
    var ECLevel = require_error_correction_level();
    var BitBuffer = require_bit_buffer();
    var BitMatrix = require_bit_matrix();
    var AlignmentPattern = require_alignment_pattern();
    var FinderPattern = require_finder_pattern();
    var MaskPattern = require_mask_pattern();
    var ECCode = require_error_correction_code();
    var ReedSolomonEncoder = require_reed_solomon_encoder();
    var Version = require_version();
    var FormatInfo = require_format_info();
    var Mode = require_mode();
    var Segments = require_segments();
    function setupFinderPattern(matrix, version) {
      const size = matrix.size;
      const pos = FinderPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -1; r <= 7; r++) {
          if (row + r <= -1 || size <= row + r) continue;
          for (let c = -1; c <= 7; c++) {
            if (col + c <= -1 || size <= col + c) continue;
            if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupTimingPattern(matrix) {
      const size = matrix.size;
      for (let r = 8; r < size - 8; r++) {
        const value = r % 2 === 0;
        matrix.set(r, 6, value, true);
        matrix.set(6, r, value, true);
      }
    }
    function setupAlignmentPattern(matrix, version) {
      const pos = AlignmentPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupVersionInfo(matrix, version) {
      const size = matrix.size;
      const bits = Version.getEncodedBits(version);
      let row, col, mod;
      for (let i = 0; i < 18; i++) {
        row = Math.floor(i / 3);
        col = i % 3 + size - 8 - 3;
        mod = (bits >> i & 1) === 1;
        matrix.set(row, col, mod, true);
        matrix.set(col, row, mod, true);
      }
    }
    function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
      const size = matrix.size;
      const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
      let i, mod;
      for (i = 0; i < 15; i++) {
        mod = (bits >> i & 1) === 1;
        if (i < 6) {
          matrix.set(i, 8, mod, true);
        } else if (i < 8) {
          matrix.set(i + 1, 8, mod, true);
        } else {
          matrix.set(size - 15 + i, 8, mod, true);
        }
        if (i < 8) {
          matrix.set(8, size - i - 1, mod, true);
        } else if (i < 9) {
          matrix.set(8, 15 - i - 1 + 1, mod, true);
        } else {
          matrix.set(8, 15 - i - 1, mod, true);
        }
      }
      matrix.set(size - 8, 8, 1, true);
    }
    function setupData(matrix, data) {
      const size = matrix.size;
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (let c = 0; c < 2; c++) {
            if (!matrix.isReserved(row, col - c)) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) === 1;
              }
              matrix.set(row, col - c, dark);
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || size <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 !== 0) {
        buffer.putBit(0);
      }
      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
      return createCodewords(buffer, version, errorCorrectionLevel);
    }
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewords = totalCodewords - ecTotalCodewords;
      const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
      const blocksInGroup2 = totalCodewords % ecTotalBlocks;
      const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
      const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
      const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
      const rs = new ReedSolomonEncoder(ecCount);
      let offset = 0;
      const dcData = new Array(ecTotalBlocks);
      const ecData = new Array(ecTotalBlocks);
      let maxDataSize = 0;
      const buffer = new Uint8Array(bitBuffer.buffer);
      for (let b = 0; b < ecTotalBlocks; b++) {
        const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
        dcData[b] = buffer.slice(offset, offset + dataSize);
        ecData[b] = rs.encode(dcData[b]);
        offset += dataSize;
        maxDataSize = Math.max(maxDataSize, dataSize);
      }
      const data = new Uint8Array(totalCodewords);
      let index = 0;
      let i, r;
      for (i = 0; i < maxDataSize; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          if (i < dcData[r].length) {
            data[index++] = dcData[r][i];
          }
        }
      }
      for (i = 0; i < ecCount; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          data[index++] = ecData[r][i];
        }
      }
      return data;
    }
    function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
      let segments;
      if (Array.isArray(data)) {
        segments = Segments.fromArray(data);
      } else if (typeof data === "string") {
        let estimatedVersion = version;
        if (!estimatedVersion) {
          const rawSegments = Segments.rawSplit(data);
          estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
        }
        segments = Segments.fromString(data, estimatedVersion || 40);
      } else {
        throw new Error("Invalid data");
      }
      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(
          "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
        );
      }
      const dataBits = createData(version, errorCorrectionLevel, segments);
      const moduleCount = Utils.getSymbolSize(version);
      const modules = new BitMatrix(moduleCount);
      setupFinderPattern(modules, version);
      setupTimingPattern(modules);
      setupAlignmentPattern(modules, version);
      setupFormatInfo(modules, errorCorrectionLevel, 0);
      if (version >= 7) {
        setupVersionInfo(modules, version);
      }
      setupData(modules, dataBits);
      if (isNaN(maskPattern)) {
        maskPattern = MaskPattern.getBestMask(
          modules,
          setupFormatInfo.bind(null, modules, errorCorrectionLevel)
        );
      }
      MaskPattern.applyMask(maskPattern, modules);
      setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
      return {
        modules,
        version,
        errorCorrectionLevel,
        maskPattern,
        segments
      };
    }
    exports.create = function create(data, options) {
      if (typeof data === "undefined" || data === "") {
        throw new Error("No input text");
      }
      let errorCorrectionLevel = ECLevel.M;
      let version;
      let mask;
      if (typeof options !== "undefined") {
        errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
        version = Version.from(options.version);
        mask = MaskPattern.from(options.maskPattern);
        if (options.toSJISFunc) {
          Utils.setToSJISFunction(options.toSJISFunc);
        }
      }
      return createSymbol(data, version, errorCorrectionLevel, mask);
    };
  }
});

// node_modules/qrcode/lib/renderer/utils.js
var require_utils2 = __commonJS({
  "node_modules/qrcode/lib/renderer/utils.js"(exports) {
    function hex2rgba(hex) {
      if (typeof hex === "number") {
        hex = hex.toString();
      }
      if (typeof hex !== "string") {
        throw new Error("Color should be defined as hex string");
      }
      let hexCode = hex.slice().replace("#", "").split("");
      if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
        throw new Error("Invalid hex color: " + hex);
      }
      if (hexCode.length === 3 || hexCode.length === 4) {
        hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
          return [c, c];
        }));
      }
      if (hexCode.length === 6) hexCode.push("F", "F");
      const hexValue = parseInt(hexCode.join(""), 16);
      return {
        r: hexValue >> 24 & 255,
        g: hexValue >> 16 & 255,
        b: hexValue >> 8 & 255,
        a: hexValue & 255,
        hex: "#" + hexCode.slice(0, 6).join("")
      };
    }
    exports.getOptions = function getOptions(options) {
      if (!options) options = {};
      if (!options.color) options.color = {};
      const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
      const width = options.width && options.width >= 21 ? options.width : void 0;
      const scale = options.scale || 4;
      return {
        width,
        scale: width ? 4 : scale,
        margin,
        color: {
          dark: hex2rgba(options.color.dark || "#000000ff"),
          light: hex2rgba(options.color.light || "#ffffffff")
        },
        type: options.type,
        rendererOpts: options.rendererOpts || {}
      };
    };
    exports.getScale = function getScale(qrSize, opts) {
      return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
    };
    exports.getImageWidth = function getImageWidth(qrSize, opts) {
      const scale = exports.getScale(qrSize, opts);
      return Math.floor((qrSize + opts.margin * 2) * scale);
    };
    exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
      const size = qr.modules.size;
      const data = qr.modules.data;
      const scale = exports.getScale(size, opts);
      const symbolSize = Math.floor((size + opts.margin * 2) * scale);
      const scaledMargin = opts.margin * scale;
      const palette = [opts.color.light, opts.color.dark];
      for (let i = 0; i < symbolSize; i++) {
        for (let j = 0; j < symbolSize; j++) {
          let posDst = (i * symbolSize + j) * 4;
          let pxColor = opts.color.light;
          if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
            const iSrc = Math.floor((i - scaledMargin) / scale);
            const jSrc = Math.floor((j - scaledMargin) / scale);
            pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
          }
          imgData[posDst++] = pxColor.r;
          imgData[posDst++] = pxColor.g;
          imgData[posDst++] = pxColor.b;
          imgData[posDst] = pxColor.a;
        }
      }
    };
  }
});

// node_modules/qrcode/lib/renderer/canvas.js
var require_canvas = __commonJS({
  "node_modules/qrcode/lib/renderer/canvas.js"(exports) {
    var Utils = require_utils2();
    function clearCanvas(ctx, canvas, size) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!canvas.style) canvas.style = {};
      canvas.height = size;
      canvas.width = size;
      canvas.style.height = size + "px";
      canvas.style.width = size + "px";
    }
    function getCanvasElement() {
      try {
        return document.createElement("canvas");
      } catch (e) {
        throw new Error("You need to specify a canvas element");
      }
    }
    exports.render = function render(qrData, canvas, options) {
      let opts = options;
      let canvasEl = canvas;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!canvas) {
        canvasEl = getCanvasElement();
      }
      opts = Utils.getOptions(opts);
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      const ctx = canvasEl.getContext("2d");
      const image = ctx.createImageData(size, size);
      Utils.qrToImageData(image.data, qrData, opts);
      clearCanvas(ctx, canvasEl, size);
      ctx.putImageData(image, 0, 0);
      return canvasEl;
    };
    exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
      let opts = options;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!opts) opts = {};
      const canvasEl = exports.render(qrData, canvas, opts);
      const type = opts.type || "image/png";
      const rendererOpts = opts.rendererOpts || {};
      return canvasEl.toDataURL(type, rendererOpts.quality);
    };
  }
});

// node_modules/qrcode/lib/renderer/svg-tag.js
var require_svg_tag = __commonJS({
  "node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
    var Utils = require_utils2();
    function getColorAttrib(color, attrib) {
      const alpha = color.a / 255;
      const str = attrib + '="' + color.hex + '"';
      return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
    }
    function svgCmd(cmd, x, y) {
      let str = cmd + x;
      if (typeof y !== "undefined") str += " " + y;
      return str;
    }
    function qrToPath(data, size, margin) {
      let path = "";
      let moveBy = 0;
      let newRow = false;
      let lineLength = 0;
      for (let i = 0; i < data.length; i++) {
        const col = Math.floor(i % size);
        const row = Math.floor(i / size);
        if (!col && !newRow) newRow = true;
        if (data[i]) {
          lineLength++;
          if (!(i > 0 && col > 0 && data[i - 1])) {
            path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
            moveBy = 0;
            newRow = false;
          }
          if (!(col + 1 < size && data[i + 1])) {
            path += svgCmd("h", lineLength);
            lineLength = 0;
          }
        } else {
          moveBy++;
        }
      }
      return path;
    }
    exports.render = function render(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const qrcodesize = size + opts.margin * 2;
      const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
      const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
      const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
      const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
      const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
      if (typeof cb === "function") {
        cb(null, svgTag);
      }
      return svgTag;
    };
  }
});

// node_modules/qrcode/lib/browser.js
var require_browser = __commonJS({
  "node_modules/qrcode/lib/browser.js"(exports) {
    var canPromise = require_can_promise();
    var QRCode2 = require_qrcode();
    var CanvasRenderer = require_canvas();
    var SvgRenderer = require_svg_tag();
    function renderCanvas(renderFunc, canvas, text, opts, cb) {
      const args = [].slice.call(arguments, 1);
      const argsNum = args.length;
      const isLastArgCb = typeof args[argsNum - 1] === "function";
      if (!isLastArgCb && !canPromise()) {
        throw new Error("Callback required as last argument");
      }
      if (isLastArgCb) {
        if (argsNum < 2) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 2) {
          cb = text;
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 3) {
          if (canvas.getContext && typeof cb === "undefined") {
            cb = opts;
            opts = void 0;
          } else {
            cb = opts;
            opts = text;
            text = canvas;
            canvas = void 0;
          }
        }
      } else {
        if (argsNum < 1) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 1) {
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 2 && !canvas.getContext) {
          opts = text;
          text = canvas;
          canvas = void 0;
        }
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode2.create(text, opts);
            resolve(renderFunc(data, canvas, opts));
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode2.create(text, opts);
        cb(null, renderFunc(data, canvas, opts));
      } catch (e) {
        cb(e);
      }
    }
    exports.create = QRCode2.create;
    exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
    exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
    exports.toString = renderCanvas.bind(null, function(data, _, opts) {
      return SvgRenderer.render(data, opts);
    });
  }
});

// web/app.ts
var import_qrcode = __toESM(require_browser(), 1);
var landingCard = document.getElementById("landingCard");
var dashboardCard = document.getElementById("dashboardCard");
var notEnabledBanner = document.getElementById("notEnabledBanner");
var notEnabledMessage = document.getElementById("notEnabledMessage");
var btnGoogleSignIn = document.getElementById("btnGoogleSignIn");
var formCredentialLogin = document.getElementById("formCredentialLogin");
var inputEmail = document.getElementById("inputEmail");
var inputPassword = document.getElementById("inputPassword");
var checkRememberMe = document.getElementById("checkRememberMe");
var userName = document.getElementById("userName");
var userEmail = document.getElementById("userEmail");
var btnSignOut = document.getElementById("btnSignOut");
function getCookie(name) {
  const match = document.cookie.match(new RegExp("(^|;\\s*)(" + name + ")=([^;]*)"));
  return match ? decodeURIComponent(match[3]) : null;
}
function setCookie(name, value, days = 365) {
  const maxAge = days > 0 ? days * 86400 : 0;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}
function deleteCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}
function saveRememberedEmail(email, shouldRemember) {
  if (shouldRemember && email) {
    setCookie("agentlink_remember_email", email.trim(), 365);
  } else {
    deleteCookie("agentlink_remember_email");
  }
}
var btnGenerateKey = document.getElementById("btnGenerateKey");
var newKeyBanner = document.getElementById("newKeyBanner");
var newKeyValue = document.getElementById("newKeyValue");
var newKeyCmd = document.getElementById("newKeyCmd");
var btnCopyNewKey = document.getElementById("btnCopyNewKey");
var keysListContainer = document.getElementById("keysListContainer");
var agentCountBadge = document.getElementById("agentCountBadge");
var agentListContainer = document.getElementById("agentListContainer");
var agentQrModal = document.getElementById("agentQrModal");
var btnCloseAgentQrModal = document.getElementById("btnCloseAgentQrModal");
var modalAgentQrCanvas = document.getElementById("modalAgentQrCanvas");
var modalAgentName = document.getElementById("modalAgentName");
var modalAgentKid = document.getElementById("modalAgentKid");
var modalAgentQrJson = document.getElementById("modalAgentQrJson");
var btnCopyModalQrJson = document.getElementById("btnCopyModalQrJson");
var googleConsentModal = document.getElementById("googleConsentModal");
var formGoogleSignInModal = document.getElementById("formGoogleSignInModal");
var inputGoogleEmail = document.getElementById("inputGoogleEmail");
var checkGoogleRememberMe = document.getElementById("checkGoogleRememberMe");
var btnCancelGoogleConsent = document.getElementById("btnCancelGoogleConsent");
var aboutModal = document.getElementById("aboutModal");
var aboutContent = document.getElementById("aboutContent");
var btnOpenAboutModal = document.getElementById("btnOpenAboutModal");
var btnCloseAboutModal = document.getElementById("btnCloseAboutModal");
var linkAboutEncryptionLanding = document.getElementById("linkAboutEncryptionLanding");
var sessionToken = localStorage.getItem("agentlink_token") || "";
var currentUser = null;
var fleetAgents = /* @__PURE__ */ new Map();
function clientLog(level, category, message, details) {
  const prefix = `[${category.toUpperCase()}]`;
  if (level === "error") console.error(prefix, message, details || "");
  else if (level === "warn") console.warn(prefix, message, details || "");
  else console.log(prefix, message, details || "");
  try {
    fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, category, message, details })
    }).catch(() => {
    });
  } catch {
  }
}
window.addEventListener("error", (event) => {
  clientLog("error", "ui_error", event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack
  });
});
window.addEventListener("unhandledrejection", (event) => {
  clientLog("error", "unhandled_promise", String(event.reason), {
    reason: event.reason?.stack || event.reason
  });
});
function showNotEnabled(message) {
  notEnabledBanner.classList.remove("hidden");
  notEnabledMessage.textContent = message || "Not enabled right now";
}
function hideNotEnabled() {
  notEnabledBanner.classList.add("hidden");
}
function unlockDashboard(user, token) {
  sessionToken = token;
  currentUser = user;
  localStorage.setItem("agentlink_token", token);
  localStorage.setItem("agentlink_user", JSON.stringify(user));
  landingCard.classList.add("hidden");
  dashboardCard.classList.remove("hidden");
  userName.textContent = user.name || "Human Authority";
  userEmail.textContent = user.email || "";
  refreshDashboard();
}
function lockLanding() {
  sessionToken = "";
  currentUser = null;
  localStorage.removeItem("agentlink_token");
  localStorage.removeItem("agentlink_user");
  landingCard.classList.remove("hidden");
  dashboardCard.classList.add("hidden");
  hideNotEnabled();
}
async function apiRequest(path, options = {}) {
  const headers = {
    "Accept": "application/json",
    ...options.headers
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}
function openGoogleConsentModal() {
  clientLog("info", "auth_ui", "Opening Google Sign-In modal");
  hideNotEnabled();
  googleConsentModal?.classList.remove("hidden");
  if (inputGoogleEmail) {
    inputGoogleEmail.value = "";
    setTimeout(() => inputGoogleEmail.focus(), 50);
  }
}
function closeGoogleConsentModal() {
  clientLog("info", "auth_ui", "Closing Google Sign-In modal");
  googleConsentModal?.classList.add("hidden");
}
async function handleGoogleLogin(emailParam, shouldRemember) {
  clientLog("info", "auth", "handleGoogleLogin triggered", { emailParam: emailParam || null });
  hideNotEnabled();
  closeGoogleConsentModal();
  let email = emailParam;
  if (!email && inputEmail && inputEmail.value.trim()) {
    email = inputEmail.value.trim();
  }
  if (!email) {
    clientLog("info", "auth", "No pre-selected email; displaying Google Sign-In modal");
    openGoogleConsentModal();
    return;
  }
  const remember = shouldRemember !== void 0 ? shouldRemember : checkRememberMe ? checkRememberMe.checked : true;
  saveRememberedEmail(email, remember);
  clientLog("info", "auth", `Attempting Google authentication for ${email}`);
  try {
    const res = await apiRequest("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        name: email.split("@")[0]
      })
    });
    if (res.authenticated && res.token) {
      clientLog("info", "auth", `Google authentication succeeded for ${email}`, { user: res.user?.id });
      unlockDashboard(res.user, res.token);
    }
  } catch (err) {
    clientLog("warn", "auth", `Google authentication failed or rejected for ${email}`, {
      status: err.status,
      error: err.data?.error || err.message
    });
    if (err.data?.error === "not_enabled" || err.status === 403) {
      showNotEnabled(err.data?.message || "Not enabled right now");
    } else {
      showNotEnabled(err.message);
    }
  }
}
formGoogleSignInModal?.addEventListener("submit", (e) => {
  e.preventDefault();
  const enteredEmail = inputGoogleEmail?.value.trim();
  const remember = checkGoogleRememberMe ? checkGoogleRememberMe.checked : true;
  clientLog("info", "auth_ui", "Submitted Google Sign-In form", { email: enteredEmail, remember });
  if (enteredEmail) {
    handleGoogleLogin(enteredEmail, remember);
  }
});
btnCancelGoogleConsent?.addEventListener("click", () => {
  closeGoogleConsentModal();
});
googleConsentModal?.addEventListener("click", (e) => {
  if (e.target === googleConsentModal) {
    closeGoogleConsentModal();
  }
});
function renderMarkdownToHtml(text) {
  const lines = text.split("\n");
  const html = [];
  let inList = false;
  let inNumberedList = false;
  function closeLists() {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    if (inNumberedList) {
      html.push("</ol>");
      inNumberedList = false;
    }
  }
  function inlineFormat(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\*(.*?)\*/g, "<em>$1</em>").replace(/`([^`]+)`/g, '<code style="background: var(--bg-primary); border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--accent);">$1</code>');
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      closeLists();
      continue;
    }
    if (line.startsWith("# ")) {
      closeLists();
      html.push(`<h2 style="font-size: 17px; color: var(--accent); margin: 0 0 10px 0; font-weight: 700;">${inlineFormat(line.slice(2))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeLists();
      html.push(`<div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 12px;"><h3 style="font-size: 14px; margin: 0 0 8px 0; color: #38bdf8;">${inlineFormat(line.slice(4))}</h3>`);
      const cardBody = [];
      let j = i + 1;
      let cardInList = false;
      let cardInNumList = false;
      while (j < lines.length && !lines[j].trim().startsWith("### ") && !lines[j].trim().startsWith("# ") && !lines[j].trim().startsWith("---")) {
        const cLine = lines[j].trim();
        if (!cLine) {
          if (cardInList) {
            cardBody.push("</ul>");
            cardInList = false;
          }
          if (cardInNumList) {
            cardBody.push("</ol>");
            cardInNumList = false;
          }
        } else if (cLine.startsWith("- ")) {
          if (!cardInList) {
            cardBody.push('<ul style="margin: 6px 0 6px 18px; padding: 0;">');
            cardInList = true;
          }
          cardBody.push(`<li style="margin-bottom: 4px; color: var(--text-secondary);">${inlineFormat(cLine.slice(2))}</li>`);
        } else if (/^\d+\.\s/.test(cLine)) {
          if (!cardInNumList) {
            cardBody.push('<ol style="margin: 6px 0 6px 18px; padding: 0;">');
            cardInNumList = true;
          }
          cardBody.push(`<li style="margin-bottom: 4px; color: var(--text-secondary);">${inlineFormat(cLine.replace(/^\d+\.\s/, ""))}</li>`);
        } else {
          cardBody.push(`<p style="margin: 0 0 8px 0; color: var(--text-primary); line-height: 1.5;">${inlineFormat(cLine)}</p>`);
        }
        j++;
      }
      if (cardInList) cardBody.push("</ul>");
      if (cardInNumList) cardBody.push("</ol>");
      html.push(cardBody.join(""));
      html.push("</div>");
      i = j - 1;
    } else if (line === "---") {
      closeLists();
    } else if (line.startsWith("- ")) {
      if (!inList) {
        html.push('<ul style="margin: 6px 0 6px 18px; padding: 0;">');
        inList = true;
      }
      html.push(`<li style="margin-bottom: 4px; color: var(--text-secondary);">${inlineFormat(line.slice(2))}</li>`);
    } else if (/^\d+\.\s/.test(line)) {
      if (!inNumberedList) {
        html.push('<ol style="margin: 6px 0 6px 18px; padding: 0;">');
        inNumberedList = true;
      }
      html.push(`<li style="margin-bottom: 4px; color: var(--text-secondary);">${inlineFormat(line.replace(/^\d+\.\s/, ""))}</li>`);
    } else {
      closeLists();
      html.push(`<p style="margin: 0 0 10px 0; color: var(--text-primary); line-height: 1.5;">${inlineFormat(line)}</p>`);
    }
  }
  closeLists();
  return html.join("\n");
}
async function loadAndDisplayDocumentation() {
  if (!aboutContent) return;
  try {
    let md = "";
    try {
      const res = await fetch("/api/docs/encryption");
      if (res.ok) {
        const data = await res.json();
        md = data.content;
      }
    } catch {
    }
    if (!md) {
      const res = await fetch("/docs/encryption.md");
      if (res.ok) {
        md = await res.text();
      }
    }
    if (md) {
      aboutContent.innerHTML = renderMarkdownToHtml(md);
      clientLog("info", "docs", "Documentation loaded directly from docs/encryption.md and rendered");
      return;
    }
  } catch (err) {
    clientLog("warn", "docs", "Failed to load docs/encryption.md", { error: err.message });
  }
  aboutContent.innerHTML = '<div style="color: #f87171; padding: 16px;">Failed to load documentation from <code>docs/encryption.md</code>.</div>';
}
function openAboutModal() {
  clientLog("info", "ui", "Opening About & Zero-Knowledge Architecture modal");
  aboutModal?.classList.remove("hidden");
  loadAndDisplayDocumentation();
}
function closeAboutModal() {
  clientLog("info", "ui", "Closing About modal");
  aboutModal?.classList.add("hidden");
}
btnOpenAboutModal?.addEventListener("click", () => {
  openAboutModal();
});
btnCloseAboutModal?.addEventListener("click", () => {
  closeAboutModal();
});
linkAboutEncryptionLanding?.addEventListener("click", (e) => {
  e.preventDefault();
  openAboutModal();
});
aboutModal?.addEventListener("click", (e) => {
  if (e.target === aboutModal) {
    closeAboutModal();
  }
});
formCredentialLogin?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideNotEnabled();
  const email = inputEmail.value.trim();
  const password = inputPassword.value.trim();
  const remember = checkRememberMe ? checkRememberMe.checked : true;
  saveRememberedEmail(email, remember);
  clientLog("info", "auth", `Credential login attempt for ${email}`);
  try {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (res.authenticated && res.token) {
      clientLog("info", "auth", `Credential login succeeded for ${email}`);
      unlockDashboard(res.user, res.token);
    }
  } catch (err) {
    clientLog("warn", "auth", `Credential login failed for ${email}`, { error: err.message });
    if (err.data?.error === "not_enabled" || err.status === 403) {
      showNotEnabled(err.data?.message || "Not enabled right now");
    } else {
      showNotEnabled(err.message);
    }
  }
});
btnGoogleSignIn?.addEventListener("click", () => {
  clientLog("info", "auth_ui", 'Clicked "Sign in with Google" button on landing gate');
  handleGoogleLogin();
});
btnSignOut?.addEventListener("click", async () => {
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
  } catch {
  }
  lockLanding();
});
async function refreshApiKeys() {
  try {
    const res = await apiRequest("/api/keys");
    const keys = res.keys || [];
    if (keys.length === 0) {
      keysListContainer.innerHTML = `<em>No active API keys yet. Click "\u2795 Generate Agent API Key" to create one.</em>`;
    } else {
      keysListContainer.innerHTML = keys.map((k) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border);">
          <div>
            <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 12px;">${k.keyMasked || k.key}</strong>
            <span style="font-size: 11px; color: var(--text-secondary); margin-left: 8px;">${k.label || "Agent Key"}</span>
            <div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px;">Created: ${new Date(k.createdAt).toLocaleDateString()}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${k.key}')">\u{1F4CB} Copy</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="window.revokeKey('${k.id}')">Revoke</button>
          </div>
        </div>
      `).join("");
    }
  } catch (err) {
    console.error("Failed to refresh API keys:", err);
  }
}
btnGenerateKey?.addEventListener("click", async () => {
  try {
    const res = await apiRequest("/api/keys/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: `Agent Key (${(/* @__PURE__ */ new Date()).toLocaleDateString()})` })
    });
    if (res.apiKey) {
      newKeyBanner.classList.remove("hidden");
      newKeyValue.value = res.apiKey.key;
      newKeyCmd.textContent = res.apiKey.key;
      await refreshApiKeys();
    }
  } catch (err) {
    alert(`Could not generate API key: ${err.message}`);
  }
});
btnCopyNewKey?.addEventListener("click", () => {
  if (newKeyValue.value) {
    navigator.clipboard.writeText(newKeyValue.value);
    btnCopyNewKey.textContent = "\u2713 Copied!";
    setTimeout(() => {
      btnCopyNewKey.textContent = "\u{1F4CB} Copy Key";
    }, 2e3);
  }
});
window.revokeKey = async (keyId) => {
  if (!confirm("Revoke this API key? Connected agents using it will need a new key.")) return;
  try {
    await apiRequest(`/api/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
    await refreshApiKeys();
  } catch (err) {
    alert(`Revocation failed: ${err.message}`);
  }
};
async function refreshFleetAgents() {
  try {
    const res = await apiRequest("/api/agents");
    const agents = res.agents || [];
    agentCountBadge.textContent = `${agents.length} Enrolled`;
    fleetAgents.clear();
    agents.forEach((a) => fleetAgents.set(a.id, a));
    if (agents.length === 0) {
      agentListContainer.innerHTML = `<em>No agents registered yet. Use an API key with <code>agent-link connect</code> to register your first agent.</em>`;
    } else {
      agentListContainer.innerHTML = agents.map((a) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 13px;">${a.id}</strong>
            <span class="badge ${a.connected ? "badge-success" : "badge-warning"}" style="font-size: 10px;">
              ${a.connected ? "\u25CF Outbound WS" : "\u25CF Polling HTTP"}
            </span>
            <span style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono);">
              Key ID: ${a.kid || "ed25519-id"}
            </span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.promptCreateLink('${a.id}')" title="Link this agent to another peer">
              \u{1F517} Link
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.showAgentQr('${a.id}')" data-testid="btn-view-agent-qr-${a.id}">
              \u{1F4F1} View QR
            </button>
            <button type="button" class="btn btn-danger btn-sm" onclick="window.deregisterAgent('${a.id}')">
              De-register
            </button>
          </div>
        </div>
      `).join("");
    }
  } catch (err) {
    console.error("Failed to refresh agents:", err);
  }
}
var linksListContainer = document.getElementById("linksListContainer");
var btnShowCreateLinkModal = document.getElementById("btnShowCreateLinkModal");
var createLinkModal = document.getElementById("createLinkModal");
var btnCloseCreateLinkModal = document.getElementById("btnCloseCreateLinkModal");
var formCreateLink = document.getElementById("formCreateLink");
var selectAgentA = document.getElementById("selectAgentA");
var selectAgentB = document.getElementById("selectAgentB");
var sendMessageModal = document.getElementById("sendMessageModal");
var btnCloseSendMsgModal = document.getElementById("btnCloseSendMsgModal");
var formSendMessage = document.getElementById("formSendMessage");
var modalMsgLinkId = document.getElementById("modalMsgLinkId");
var modalMsgLinkDisplay = document.getElementById("modalMsgLinkDisplay");
var modalMsgSenderSelect = document.getElementById("modalMsgSenderSelect");
var modalMsgText = document.getElementById("modalMsgText");
var linkConversationModal = document.getElementById("linkConversationModal");
var btnCloseConversationModal = document.getElementById("btnCloseConversationModal");
var convoAgentA = document.getElementById("convoAgentA");
var convoAgentB = document.getElementById("convoAgentB");
var convoStatusBadge = document.getElementById("convoStatusBadge");
var convoLinkId = document.getElementById("convoLinkId");
var convoFramesCount = document.getElementById("convoFramesCount");
var flowAgentALabel = document.getElementById("flowAgentALabel");
var flowAgentAKid = document.getElementById("flowAgentAKid");
var flowAgentBLabel = document.getElementById("flowAgentBLabel");
var flowAgentBKid = document.getElementById("flowAgentBKid");
var conversationStream = document.getElementById("conversationStream");
var formConvoSend = document.getElementById("formConvoSend");
var convoSenderSelect = document.getElementById("convoSenderSelect");
var convoMsgInput = document.getElementById("convoMsgInput");
var currentConvoLinkId = null;
var convoPollTimer = null;
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
var activeLinks = /* @__PURE__ */ new Map();
async function refreshPeerLinks() {
  try {
    const res = await apiRequest("/api/links");
    const links = res.links || [];
    activeLinks.clear();
    links.forEach((l) => activeLinks.set(l.id, l));
    if (links.length === 0) {
      linksListContainer.innerHTML = `<em>No active links yet. Click "\u2795 Link Two Agents" to link your enrolled agents.</em>`;
    } else {
      linksListContainer.innerHTML = links.map((l) => {
        const isActive = l.status === "active";
        const approvals = l.approvals || {};
        const totalOwners = Object.keys(approvals).length || 1;
        const approvedCount = Object.values(approvals).filter(Boolean).length;
        const isCurrentApproved = currentUser ? Boolean(approvals[currentUser.id]) : false;
        const peerEmail = l.responderHumanEmail || (l.initiatorHumanId !== currentUser?.id ? l.initiatorHumanEmail : null);
        return `
          <div class="link-item" style="cursor: pointer; background: var(--bg-secondary); padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border);" onclick="window.openLinkConversationModal('${l.id}')">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="color: var(--accent); font-family: var(--font-mono); font-size: 14px;">${escapeHtml(l.agentAId)}</strong>
                  <span style="color: var(--text-secondary); font-size: 13px;">\u27F7</span>
                  <strong style="color: #38bdf8; font-family: var(--font-mono); font-size: 14px;">${escapeHtml(l.agentBId)}</strong>
                  <span class="badge ${isActive ? "badge-success" : "badge-warning"}" style="font-size: 10px;">
                    ${isActive ? "\u25CF Active" : `\u25CF Pending (${approvedCount}/${totalOwners} approved)`}
                  </span>
                  ${peerEmail ? `<span style="font-size: 11px; background: rgba(56, 189, 248, 0.1); color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono);">\u{1F464} ${escapeHtml(peerEmail)}</span>` : ""}
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px;">
                  ID: <span style="font-family: var(--font-mono);">${escapeHtml(l.id)}</span>
                  &bull; Frames: <strong style="color: var(--text-primary);">${l.framesCount || 0}</strong>
                  &bull; Created: ${new Date(l.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;" onclick="event.stopPropagation()">
                ${!isActive && (!isCurrentApproved || currentUser?.role === "admin") ? `
                  <button type="button" class="btn btn-sm" style="background: #059669;" onclick="window.approveLink('${l.id}')">
                    \u2713 Approve Link
                  </button>
                ` : !isActive && isCurrentApproved ? `
                  <span style="font-size: 11px; color: #34d399; font-weight: 500; align-self: center;">\u2713 You Approved (Waiting for Peer)</span>
                ` : ""}
                <button type="button" class="btn btn-sm" style="background: #2563eb;" onclick="window.openLinkConversationModal('${l.id}')" title="View conversation flow & frames">
                  \u{1F441}\uFE0F Conversation
                </button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="window.openSendMsgModal('${l.id}')" title="Send a message to an agent">
                  \u{1F4AC} Send to Agent
                </button>
                <button type="button" class="btn btn-danger btn-sm" onclick="window.severLink('${l.id}')">
                  Sever
                </button>
              </div>
            </div>
            ${l.recentMessages && l.recentMessages.length > 0 ? `
              <div style="margin-top: 8px; padding: 6px 10px; background: rgba(0,0,0,0.3); border-radius: 6px; font-family: var(--font-mono); font-size: 11px; color: #a1a1aa; border-left: 2px solid var(--accent); display: flex; justify-content: space-between; align-items: center;">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%;">
                  Recent Frame: <strong style="color: #38bdf8;">${escapeHtml(l.recentMessages[l.recentMessages.length - 1].senderId)}</strong>: <span style="color: #e4e4e7;">${escapeHtml(l.recentMessages[l.recentMessages.length - 1].text)}</span>
                </div>
                <span style="font-size: 10px; color: var(--accent); white-space: nowrap;">View full flow \u2192</span>
              </div>
            ` : `
              <div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary); opacity: 0.8;">
                Click to open live conversation flow & message stream \u2192
              </div>
            `}
          </div>
        `;
      }).join("");
    }
  } catch (err) {
    console.error("Failed to refresh links:", err);
  }
}
function populateLinkSelects(preselectA) {
  const agents = Array.from(fleetAgents.values());
  selectAgentA.innerHTML = "";
  selectAgentB.innerHTML = "";
  if (agents.length === 0) {
    selectAgentA.innerHTML = '<option value="">No agents enrolled</option>';
    selectAgentB.innerHTML = '<option value="">No agents enrolled</option>';
    return;
  }
  agents.forEach((a) => {
    const optA = document.createElement("option");
    optA.value = a.id;
    optA.textContent = `${a.id} (${a.kid ? a.kid.slice(0, 16) : "local"}...)`;
    selectAgentA.appendChild(optA);
    const optB = document.createElement("option");
    optB.value = a.id;
    optB.textContent = `${a.id} (${a.kid ? a.kid.slice(0, 16) : "local"}...)`;
    selectAgentB.appendChild(optB);
  });
  if (preselectA && fleetAgents.has(preselectA)) {
    selectAgentA.value = preselectA;
    const other = agents.find((a) => a.id !== preselectA);
    if (other) selectAgentB.value = other.id;
  } else if (agents.length >= 2) {
    selectAgentA.value = agents[0].id;
    selectAgentB.value = agents[1].id;
  }
}
window.promptCreateLink = (agentId) => {
  populateLinkSelects(agentId);
  createLinkModal.classList.remove("hidden");
};
btnShowCreateLinkModal?.addEventListener("click", () => {
  populateLinkSelects();
  createLinkModal.classList.remove("hidden");
});
btnCloseCreateLinkModal?.addEventListener("click", () => {
  createLinkModal.classList.add("hidden");
});
formCreateLink?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const agentAId = selectAgentA.value;
  const agentBId = selectAgentB.value;
  if (agentAId === agentBId) {
    alert("Please select two different agents to link.");
    return;
  }
  try {
    const res = await apiRequest("/api/links/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentAId, agentBId })
    });
    if (res.linkId) {
      await apiRequest(`/api/links/${encodeURIComponent(res.linkId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerVerification: "optical_qr_verified" })
      });
      createLinkModal.classList.add("hidden");
      await refreshPeerLinks();
    }
  } catch (err) {
    alert(`Failed to establish link: ${err.message}`);
  }
});
window.approveLink = async (linkId) => {
  try {
    await apiRequest(`/api/links/${encodeURIComponent(linkId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerVerification: "optical_qr_verified" })
    });
    await refreshPeerLinks();
  } catch (err) {
    alert(`Approval failed: ${err.message}`);
  }
};
window.severLink = async (linkId) => {
  if (!confirm(`Sever this link (${linkId})? Messages will no longer route between these agents.`)) return;
  try {
    await apiRequest(`/api/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
    await refreshPeerLinks();
  } catch (err) {
    alert(`Severing link failed: ${err.message}`);
  }
};
window.openSendMsgModal = (linkId) => {
  const link = activeLinks.get(linkId);
  if (!link) return;
  modalMsgLinkId.value = linkId;
  modalMsgLinkDisplay.textContent = `${link.agentAId} \u27F7 ${link.agentBId}`;
  modalMsgSenderSelect.innerHTML = `
    <option value="${link.agentAId}">${link.agentAId}</option>
    <option value="${link.agentBId}">${link.agentBId}</option>
  `;
  modalMsgText.value = "";
  sendMessageModal.classList.remove("hidden");
};
btnCloseSendMsgModal?.addEventListener("click", () => {
  sendMessageModal.classList.add("hidden");
});
formSendMessage?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const linkId = modalMsgLinkId.value;
  const senderId = modalMsgSenderSelect.value;
  const text = modalMsgText.value.trim();
  if (!text) return;
  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(linkId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId, payload: text })
    });
    if (res.status === "ok") {
      sendMessageModal.classList.add("hidden");
      alert(`Message dispatched from ${senderId}! When peer polls, they will receive it.`);
      await refreshPeerLinks();
    }
  } catch (err) {
    alert(`Message dispatch failed: ${err.message}`);
  }
});
window.openLinkConversationModal = async (linkId) => {
  currentConvoLinkId = linkId;
  let link = activeLinks.get(linkId);
  if (!link) {
    link = {
      id: linkId,
      agentAId: "Agent A",
      agentBId: "Agent B",
      status: "active",
      framesCount: 0,
      recentMessages: []
    };
  }
  renderConversationModalHeader(link);
  linkConversationModal.classList.remove("hidden");
  await refreshConversationFlow(linkId, true);
  if (convoPollTimer) clearInterval(convoPollTimer);
  convoPollTimer = setInterval(async () => {
    if (!linkConversationModal.classList.contains("hidden") && currentConvoLinkId === linkId) {
      await refreshConversationFlow(linkId, false);
    } else {
      clearInterval(convoPollTimer);
      convoPollTimer = null;
    }
  }, 2e3);
};
function renderConversationModalHeader(link) {
  if (convoAgentA) convoAgentA.textContent = link.agentAId || "Agent A";
  if (convoAgentB) convoAgentB.textContent = link.agentBId || "Agent B";
  if (convoLinkId) convoLinkId.textContent = link.id;
  if (convoFramesCount) convoFramesCount.textContent = String(link.framesCount || 0);
  const isActive = link.status === "active";
  if (convoStatusBadge) {
    convoStatusBadge.className = `badge ${isActive ? "badge-success" : "badge-warning"}`;
    convoStatusBadge.textContent = isActive ? "\u25CF Active" : "\u25CF Pending Approval";
  }
  if (flowAgentALabel) flowAgentALabel.textContent = link.agentAId || "Agent A";
  if (flowAgentBLabel) flowAgentBLabel.textContent = link.agentBId || "Agent B";
  const agentA = fleetAgents.get(link.agentAId);
  const agentB = fleetAgents.get(link.agentBId);
  if (flowAgentAKid) flowAgentAKid.textContent = agentA?.kid || "registered";
  if (flowAgentBKid) flowAgentBKid.textContent = agentB?.kid || "registered";
  if (convoSenderSelect && link.agentAId && link.agentBId) {
    convoSenderSelect.innerHTML = `
      <option value="${link.agentAId}">From: ${link.agentAId}</option>
      <option value="${link.agentBId}">From: ${link.agentBId}</option>
    `;
  }
}
async function refreshConversationFlow(linkId, autoScroll = true) {
  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(linkId)}`);
    const link = res.link;
    if (!link) return;
    activeLinks.set(link.id, link);
    renderConversationModalHeader(link);
    if (convoFramesCount) convoFramesCount.textContent = String(link.framesCount || 0);
    const msgs = link.recentMessages || [];
    if (msgs.length === 0) {
      conversationStream.innerHTML = `
        <div style="margin: auto; text-align: center; color: var(--text-secondary); padding: 32px 16px;">
          <div style="font-size: 32px; margin-bottom: 8px;">\u{1F4AC}</div>
          <strong style="color: var(--text-primary); font-size: 14px;">No Frames Exchanged Yet</strong>
          <p style="font-size: 12px; margin-top: 6px; max-width: 360px; line-height: 1.4;">
            Messages transmitted between <strong style="color: var(--accent);">${escapeHtml(link.agentAId)}</strong> and <strong style="color: #38bdf8;">${escapeHtml(link.agentBId)}</strong> across the zero-knowledge tunnel will appear here in real time.
          </p>
        </div>
      `;
      return;
    }
    conversationStream.innerHTML = msgs.map((m) => {
      const isFromA = m.senderId === link.agentAId;
      const bubbleBg = isFromA ? "rgba(168, 85, 247, 0.12)" : "rgba(56, 189, 248, 0.12)";
      const borderCol = isFromA ? "rgba(168, 85, 247, 0.35)" : "rgba(56, 189, 248, 0.35)";
      const accentCol = isFromA ? "var(--accent)" : "#38bdf8";
      const targetAgent = isFromA ? link.agentBId : link.agentAId;
      return `
        <div style="display: flex; flex-direction: column; max-width: 85%; ${isFromA ? "align-self: flex-start;" : "align-self: flex-end;"} background: ${bubbleBg}; border: 1px solid ${borderCol}; border-radius: 8px; padding: 10px 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.25);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="color: ${accentCol}; font-family: var(--font-mono); font-size: 12px;">${escapeHtml(m.senderId)}</strong>
              <span style="color: var(--text-secondary); font-size: 10px;">\u2794</span>
              <span style="color: var(--text-secondary); font-size: 11px; font-family: var(--font-mono);">${escapeHtml(targetAgent)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${m.isEncrypted ? `
                <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 9px; padding: 1px 5px; font-weight: 600;">
                  \u{1F512} ${m.isSigned ? "E2EE Signed (v2)" : "E2EE Frame"}
                </span>
              ` : `
                <span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; font-size: 9px; padding: 1px 5px; font-weight: 600;">
                  \u26A0\uFE0F Plaintext (Insecure)
                </span>
              `}
              <span style="font-size: 10px; color: var(--text-secondary);">${new Date(m.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
          <div style="font-size: 13px; color: var(--text-primary); word-break: break-word; line-height: 1.4;">
            ${escapeHtml(m.text || "")}
          </div>
          ${m.isEncrypted && m.payload && m.payload.data ? `
            <div style="margin-top: 6px; font-family: var(--font-mono); font-size: 9px; color: var(--text-secondary); background: rgba(0,0,0,0.3); padding: 4px 6px; border-radius: 4px; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap;">
              Cipher: ${escapeHtml(m.payload.data)}
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
    if (autoScroll) {
      conversationStream.scrollTop = conversationStream.scrollHeight;
    }
  } catch (err) {
    console.error("Failed to refresh conversation flow:", err);
  }
}
formConvoSend?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentConvoLinkId) return;
  const senderId = convoSenderSelect.value;
  const text = convoMsgInput.value.trim();
  if (!text) return;
  convoMsgInput.value = "";
  try {
    const res = await apiRequest(`/api/links/${encodeURIComponent(currentConvoLinkId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId, payload: text })
    });
    if (res.status === "ok") {
      await refreshConversationFlow(currentConvoLinkId, true);
      await refreshPeerLinks();
    }
  } catch (err) {
    alert(`Failed to dispatch message: ${err.message}`);
  }
});
btnCloseConversationModal?.addEventListener("click", () => {
  linkConversationModal.classList.add("hidden");
  if (convoPollTimer) {
    clearInterval(convoPollTimer);
    convoPollTimer = null;
  }
  currentConvoLinkId = null;
});
window.deregisterAgent = async (agentId) => {
  if (!confirm(`De-register agent "${agentId}"?`)) return;
  try {
    await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
    await refreshFleetAgents();
    await refreshPeerLinks();
  } catch (err) {
    alert(`De-registration failed: ${err.message}`);
  }
};
window.showAgentQr = (agentId) => {
  const agent = fleetAgents.get(agentId) || { id: agentId };
  modalAgentName.textContent = agent.id;
  modalAgentKid.textContent = agent.kid || "local-ed25519";
  let payloadStr = agent.qrPayload;
  if (!payloadStr) {
    payloadStr = JSON.stringify({
      v: 1,
      agent: agent.id,
      signPub: agent.signPub || "sample_sign_pubkey",
      encPub: agent.encPub || "sample_enc_pubkey",
      kid: agent.kid || "kid-sample",
      iat: agent.registeredAt || (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  modalAgentQrJson.value = payloadStr;
  import_qrcode.default.toCanvas(modalAgentQrCanvas, payloadStr, {
    width: 224,
    margin: 1,
    errorCorrectionLevel: "M"
  });
  agentQrModal.classList.remove("hidden");
};
btnCloseAgentQrModal?.addEventListener("click", () => {
  agentQrModal.classList.add("hidden");
});
btnCopyModalQrJson?.addEventListener("click", () => {
  if (modalAgentQrJson.value) {
    navigator.clipboard.writeText(modalAgentQrJson.value);
    btnCopyModalQrJson.textContent = "\u2713 Copied!";
    setTimeout(() => {
      btnCopyModalQrJson.textContent = "\u{1F4CB} Copy";
    }, 2e3);
  }
});
var btnOpenCleanSlateModal = document.getElementById("btnOpenCleanSlateModal");
var cleanSlateModal = document.getElementById("cleanSlateModal");
var btnCloseCleanSlateModal = document.getElementById("btnCloseCleanSlateModal");
var btnPurgeTestData = document.getElementById("btnPurgeTestData");
var btnResetAllCleanSlate = document.getElementById("btnResetAllCleanSlate");
var cleanSlateStatusMessage = document.getElementById("cleanSlateStatusMessage");
function showCleanSlateStatus(msg, isError = false) {
  if (!cleanSlateStatusMessage) return;
  cleanSlateStatusMessage.textContent = msg;
  cleanSlateStatusMessage.style.display = "block";
  cleanSlateStatusMessage.style.background = isError ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)";
  cleanSlateStatusMessage.style.color = isError ? "#f87171" : "#34d399";
  cleanSlateStatusMessage.style.border = `1px solid ${isError ? "#ef4444" : "#10b981"}`;
  cleanSlateStatusMessage.classList.remove("hidden");
}
btnOpenCleanSlateModal?.addEventListener("click", () => {
  if (cleanSlateStatusMessage) {
    cleanSlateStatusMessage.classList.add("hidden");
    cleanSlateStatusMessage.style.display = "none";
  }
  cleanSlateModal?.classList.remove("hidden");
});
btnCloseCleanSlateModal?.addEventListener("click", () => {
  cleanSlateModal?.classList.add("hidden");
});
async function triggerCleanSlate(mode) {
  try {
    showCleanSlateStatus("Cleaning...", false);
    const res = await apiRequest("/api/admin/clean-slate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    if (res.status === "ok") {
      showCleanSlateStatus(
        `\u2713 Clean slate complete! Purged ${res.removedAgents} agents, ${res.removedKeys} keys, ${res.removedLinks} links.`,
        false
      );
      await refreshDashboard();
      setTimeout(() => {
        cleanSlateModal?.classList.add("hidden");
      }, 1500);
    } else {
      showCleanSlateStatus(res.message || "Clean slate operation failed", true);
    }
  } catch (err) {
    showCleanSlateStatus(err.message || "Failed to execute clean slate", true);
  }
}
btnPurgeTestData?.addEventListener("click", () => {
  triggerCleanSlate("test_artifacts");
});
btnResetAllCleanSlate?.addEventListener("click", () => {
  if (confirm("Are you sure you want to perform a full reset to a pristine clean slate? This will remove all agents and links.")) {
    triggerCleanSlate("all");
  }
});
var btnOpenInviteModal = document.getElementById("btnOpenInviteModal");
var inviteModal = document.getElementById("inviteModal");
var btnCloseInviteModal = document.getElementById("btnCloseInviteModal");
var inviteForm = document.getElementById("inviteForm");
var inviteRecipientEmail = document.getElementById("inviteRecipientEmail");
var inviteNote = document.getElementById("inviteNote");
var inviteResultBox = document.getElementById("inviteResultBox");
var inviteUrlDisplay = document.getElementById("inviteUrlDisplay");
var btnCopyInviteLink = document.getElementById("btnCopyInviteLink");
var btnCopyInviteEmail = document.getElementById("btnCopyInviteEmail");
var lastInviteEmailTemplate = null;
btnOpenInviteModal?.addEventListener("click", () => {
  inviteModal?.classList.remove("hidden");
  inviteResultBox?.classList.add("hidden");
  if (inviteRecipientEmail) inviteRecipientEmail.value = "";
  if (inviteNote) inviteNote.value = "";
});
btnCloseInviteModal?.addEventListener("click", () => {
  inviteModal?.classList.add("hidden");
});
inviteForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const toEmail = inviteRecipientEmail?.value.trim() || "";
  const note = inviteNote?.value.trim() || void 0;
  if (!toEmail) return;
  try {
    const res = await apiRequest("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toEmail, note })
    });
    if (res.status === "ok") {
      lastInviteEmailTemplate = res.emailTemplate;
      if (inviteUrlDisplay) {
        inviteUrlDisplay.value = res.inviteUrl;
      }
      inviteResultBox?.classList.remove("hidden");
      clientLog("info", "invites", `Successfully created invite for ${toEmail}`);
    }
  } catch (err) {
    alert(`Failed to create invite: ${err.message}`);
  }
});
btnCopyInviteLink?.addEventListener("click", () => {
  if (inviteUrlDisplay && inviteUrlDisplay.value) {
    navigator.clipboard.writeText(inviteUrlDisplay.value);
    btnCopyInviteLink.textContent = "\u2705 Copied!";
    setTimeout(() => {
      if (btnCopyInviteLink) btnCopyInviteLink.textContent = "\u{1F4CB} Copy Link";
    }, 2e3);
  }
});
btnCopyInviteEmail?.addEventListener("click", () => {
  if (lastInviteEmailTemplate) {
    const fullText = `Subject: ${lastInviteEmailTemplate.subject}

${lastInviteEmailTemplate.body}`;
    navigator.clipboard.writeText(fullText);
    btnCopyInviteEmail.textContent = "\u2705 Email Copied!";
    setTimeout(() => {
      if (btnCopyInviteEmail) btnCopyInviteEmail.textContent = "\u{1F4CB} Copy Full Email Knowledge Template";
    }, 2e3);
  }
});
var bugFilter = "open";
var cachedBugs = [];
async function refreshBugReports() {
  try {
    const res = await apiRequest("/api/bugs?limit=100");
    cachedBugs = res.bugs || [];
    renderBugReports();
  } catch (err) {
    console.error("Failed to refresh bug reports:", err);
  }
}
function renderBugReports() {
  const container = document.getElementById("bugsListContainer");
  const badge = document.getElementById("bugCountBadge");
  if (!container || !badge) return;
  const openBugs = cachedBugs.filter((b) => !b.resolved);
  badge.textContent = `${openBugs.length} Open`;
  badge.className = openBugs.length > 0 ? "badge badge-warning" : "badge badge-success";
  let filtered = cachedBugs;
  if (bugFilter === "open") {
    filtered = openBugs;
  } else if (bugFilter === "resolved") {
    filtered = cachedBugs.filter((b) => b.resolved);
  }
  filtered = [...filtered].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  if (filtered.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 16px; color: var(--text-secondary); font-size: 13px;">
      ${bugFilter === "open" ? "\u{1F389} No open bug reports! All systems operational." : "No bug reports found."}
    </div>`;
    return;
  }
  container.innerHTML = filtered.map((b) => {
    const sevColors = {
      critical: "#ef4444",
      high: "#f97316",
      medium: "#eab308",
      low: "#3b82f6"
    };
    const sevColor = sevColors[b.severity] || "#eab308";
    const statusBadge = b.resolved ? `<span class="badge badge-success" style="font-size: 10px;">\u2705 Resolved</span>` : `<span class="badge badge-danger" style="font-size: 10px; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid #ef4444;">\u{1F534} Open</span>`;
    const sevBadge = `<span style="font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: ${sevColor}22; color: ${sevColor}; border: 1px solid ${sevColor}; text-transform: uppercase;">${b.severity || "medium"}</span>`;
    const timeStr = new Date(b.timestamp).toLocaleString();
    const resolvedMeta = b.resolved ? `<div style="font-size: 11px; color: #34d399; margin-top: 6px; background: rgba(16, 185, 129, 0.08); padding: 4px 8px; border-radius: 4px;">
           \u2713 Resolved by <strong>${escapeHtml(b.resolvedBy || "Administrator")}</strong>${b.resolvedAt ? ` on ${new Date(b.resolvedAt).toLocaleString()}` : ""}
           ${b.resolutionNote ? `<br><em>Fix Note: ${escapeHtml(b.resolutionNote)}</em>` : ""}
         </div>` : "";
    return `
      <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              ${statusBadge}
              ${sevBadge}
              <strong style="font-size: 13px; color: var(--text-primary);">${escapeHtml(b.title)}</strong>
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
              <span>\u{1F916} Agent: <strong style="font-family: var(--font-mono); color: var(--accent);">${escapeHtml(b.agentId || "anonymous")}</strong></span>
              <span>\u{1F552} ${timeStr}</span>
              <span style="font-family: var(--font-mono); font-size: 10px;">ID: ${escapeHtml(b.id)}</span>
            </div>
          </div>
          <div>
            ${b.resolved ? `<button type="button" class="btn btn-secondary btn-sm" onclick="window.toggleResolveBug('${b.id}', false)" style="font-size: 11px; padding: 4px 8px;">\u21A9 Reopen</button>` : `<button type="button" class="btn btn-sm" onclick="window.toggleResolveBug('${b.id}', true)" style="font-size: 11px; padding: 4px 10px; background: #10b981; border-color: #059669; color: #fff;">\u2713 Mark as Resolved</button>`}
          </div>
        </div>
        <div style="font-size: 12px; background: var(--bg-primary); padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); font-family: var(--font-mono); white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto;">${escapeHtml(b.details)}</div>
        ${resolvedMeta}
      </div>
    `;
  }).join("");
}
window.toggleResolveBug = async (bugId, resolve) => {
  let note = null;
  if (resolve) {
    note = prompt("Enter an optional resolution note or fix commit reference:") || null;
  }
  try {
    await apiRequest(`/api/bugs/${encodeURIComponent(bugId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolved: resolve, note })
    });
    await refreshBugReports();
  } catch (err) {
    alert(`Failed to update bug report: ${err.message}`);
  }
};
var btnRefreshBugs = document.getElementById("btnRefreshBugs");
var btnBugFilterOpen = document.getElementById("btnBugFilterOpen");
var btnBugFilterAll = document.getElementById("btnBugFilterAll");
var btnBugFilterResolved = document.getElementById("btnBugFilterResolved");
btnRefreshBugs?.addEventListener("click", () => refreshBugReports());
btnBugFilterOpen?.addEventListener("click", () => {
  bugFilter = "open";
  if (btnBugFilterOpen) btnBugFilterOpen.className = "btn btn-sm";
  if (btnBugFilterAll) btnBugFilterAll.className = "btn btn-secondary btn-sm";
  if (btnBugFilterResolved) btnBugFilterResolved.className = "btn btn-secondary btn-sm";
  renderBugReports();
});
btnBugFilterAll?.addEventListener("click", () => {
  bugFilter = "all";
  if (btnBugFilterAll) btnBugFilterAll.className = "btn btn-sm";
  if (btnBugFilterOpen) btnBugFilterOpen.className = "btn btn-secondary btn-sm";
  if (btnBugFilterResolved) btnBugFilterResolved.className = "btn btn-secondary btn-sm";
  renderBugReports();
});
btnBugFilterResolved?.addEventListener("click", () => {
  bugFilter = "resolved";
  if (btnBugFilterResolved) btnBugFilterResolved.className = "btn btn-sm";
  if (btnBugFilterOpen) btnBugFilterOpen.className = "btn btn-secondary btn-sm";
  if (btnBugFilterAll) btnBugFilterAll.className = "btn btn-secondary btn-sm";
  renderBugReports();
});
async function refreshDashboard() {
  await Promise.all([refreshApiKeys(), refreshFleetAgents(), refreshPeerLinks(), refreshBugReports()]);
}
window.addEventListener("DOMContentLoaded", async () => {
  clientLog("info", "lifecycle", "Application DOM loaded and initialized");
  const initialRememberedEmail = getCookie("agentlink_remember_email");
  if (initialRememberedEmail) {
    if (inputEmail) inputEmail.value = initialRememberedEmail;
    if (inputGoogleEmail) inputGoogleEmail.value = initialRememberedEmail;
    if (checkRememberMe) checkRememberMe.checked = true;
    if (checkGoogleRememberMe) checkGoogleRememberMe.checked = true;
  }
  inputEmail?.addEventListener("input", () => {
    if (inputGoogleEmail) inputGoogleEmail.value = inputEmail.value;
  });
  inputGoogleEmail?.addEventListener("input", () => {
    if (inputEmail) inputEmail.value = inputGoogleEmail.value;
  });
  checkRememberMe?.addEventListener("change", () => {
    if (checkGoogleRememberMe) checkGoogleRememberMe.checked = checkRememberMe.checked;
  });
  checkGoogleRememberMe?.addEventListener("change", () => {
    if (checkRememberMe) checkRememberMe.checked = checkGoogleRememberMe.checked;
  });
  const urlParams = new URLSearchParams(window.location.search);
  const inviteToken = urlParams.get("invite");
  if (inviteToken && !sessionToken) {
    openGoogleModal();
  }
  if (sessionToken) {
    clientLog("info", "lifecycle", "Found existing session token, verifying with server");
    try {
      const res = await apiRequest("/api/auth/me");
      if (res.status === "ok" && res.user) {
        clientLog("info", "lifecycle", "Session valid; unlocking dashboard");
        unlockDashboard(res.user, sessionToken);
      } else {
        clientLog("warn", "lifecycle", "Session invalid; locking landing");
        lockLanding();
      }
    } catch {
      clientLog("warn", "lifecycle", "Failed to verify session; locking landing");
      lockLanding();
    }
  } else {
    clientLog("info", "lifecycle", "No existing session; landing gate active");
    lockLanding();
  }
});
//# sourceMappingURL=bundle.js.map
