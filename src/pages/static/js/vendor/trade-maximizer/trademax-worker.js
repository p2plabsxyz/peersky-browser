// From https://www.npmjs.com/package/java-random/v/0.2.1
// modified to be plain js vs node.js

const p2_16 = 0x10000;
const m2_16 = 0x0ffff;

const p2_16x	= 0x0000000010000;
const p2_24	= 0x0000001000000;
const p2_27	= 0x0000008000000;
const p2_31	= 0x0000080000000;
const p2_32	= 0x0000100000000;
const p2_48	= 0x1000000000000;
const p2_53	= Math.pow(2, 53);	// NB: exceeds Number.MAX_SAFE_INTEGER

const int32_max	= 0x7fffffff;


class UInt48 {

	constructor(n) {
		if (n instanceof UInt48) {
			Object.assign(this, n);
		} else if (typeof n === 'number') {
			let w0 = n & m2_16;
			n /= p2_16;
			let w1 = n & m2_16;
			n /= p2_16;
			let w2 = n & m2_16;
			Object.assign(this, { w2, w1, w0 });
		}
	}

	norm() {
		if (this.w0 >= p2_16) {
			let carry = Math.floor(this.w0 / p2_16);
			this.w1 += carry;
			this.w0 &= m2_16;
		}
		if (this.w1 >= p2_16) {
			let carry = Math.floor(this.w1 / p2_16);
			this.w2 += carry;
			this.w1 &= m2_16;
		}
		this.w2 &= m2_16;

		return this;
	}

	add(n) {
		let tmp = new UInt48(this);

		tmp.w0 += n.w0;
		tmp.w1 += n.w1;
		tmp.w2 += n.w2;

		return tmp.norm();
	}

	xor(n) {
		let tmp = new UInt48(this);

		tmp.w2 ^= n.w2;
		tmp.w1 ^= n.w1;
		tmp.w0 ^= n.w0;

		return tmp;
	}

	mul(n) {
		let tmp1 = new UInt48(n);
		tmp1.w2 = tmp1.w2 * this.w0;
		tmp1.w1 = tmp1.w1 * this.w0;
		tmp1.w0 = tmp1.w0 * this.w0;
		tmp1.norm();

		let tmp2 = new UInt48(n);
		tmp2.w2 = tmp2.w1 * this.w1;
		tmp2.w1 = tmp2.w0 * this.w1;
		tmp2.w0 = 0;
		tmp2.norm();

		let tmp3 = new UInt48(n);
		tmp3.w2 = tmp3.w0 * this.w2;
		tmp3.w1 = 0;
		tmp3.w0 = 0;
		tmp3.norm();

		return tmp3.add(tmp2).add(tmp1);
	}

	valueOf() {
		return p2_16 * (p2_16 * this.w2 + this.w1) + this.w0;
	}
}

class JavaRandom {

	constructor(seedval) {

		this.mul = new UInt48(0x5deece66d);
		this.add = new UInt48(0xb);

		// perform seed initialisation
		if (seedval === undefined) {
			seedval = Math.floor(Math.random() * p2_48); 
		}
		this.setSeed(seedval);
	}

		setSeed(seedval) {
			if (typeof seedval !== 'number') {
				throw TypeError();
			}
			this.seed = new UInt48(seedval).xor(this.mul);
		}

		next(bits) {
			return this._next() >>> (32 - bits);
		}

		_next() {
			this.seed = this.seed.mul(this.mul).add(this.add);
			return this.seed / p2_16x; 
		}

		next_signed(bits) {
			return this._next() >> (32 - bits);
		}

		nextInt(bound) {
			if (bound === undefined) {
				return this.next_signed(32);
			}

			if (typeof bound !== 'number') {
				throw TypeError();
			}

			if (bound < 0 || bound > int32_max) {
				throw RangeError();
			}

			if ((bound & -bound) === bound) { // i.e., bound is a power of two
				let r = this.next(31) / p2_31;
				return ~~(bound * r);
			}

			var bits, val;
			do {
				bits = this.next(31);
				val = bits % bound;
			} while (bits - val + (bound - 1) < 0);
			return val;
		}

/*
		nextBoolean() {
			return next(1) != 0;
		}

		nextFloat() {
			return next(24) / p2_24;
		}

		nextDouble() {
			return (p2_27 * next(26) + next(27)) / p2_53;
		}

		function* doubles(streamSize) {
			if (streamSize === undefined) {
				while (true) {
					yield nextDouble();
				}
			} else {
				if (typeof streamSize !== 'number') {
					throw TypeError();
				}

				if (streamSize < 0) {
					throw RangeError();
				}

				while (streamSize-- > 0) {
					yield nextDouble();
				}
			}
		}

		// list of functions to export, using ES6 scoped-variable keys
		const functions = {
			setSeed,
			nextInt, nextBoolean, nextFloat, nextDouble,
			doubles
		};

		// convert into Property Descriptors
		for (let f in functions) {
			functions[f] = { value: functions[f] };
		}

		// add them to the current object
		Object.defineProperties(this, functions);
*/

};

// Jeff - I modified hex() to not show leading zero's just like java's toHexString
/**
 * [js-md5]{@link https://github.com/emn178/js-md5}
 *
 * @namespace md5
 * @version 0.7.3
 * @author Chen, Yi-Cyuan [emn178@gmail.com]
 * @copyright Chen, Yi-Cyuan 2014-2017
 * @license MIT
 */
(function () {
  'use strict';

  var ERROR = 'input is invalid type';
  var WINDOW = typeof window === 'object';
  var root = WINDOW ? window : {};
  if (root.JS_MD5_NO_WINDOW) {
    WINDOW = false;
  }
  var WEB_WORKER = !WINDOW && typeof self === 'object';
  var NODE_JS = !root.JS_MD5_NO_NODE_JS && typeof process === 'object' && process.versions && process.versions.node;
  if (NODE_JS) {
    root = global;
  } else if (WEB_WORKER) {
    root = self;
  }
  var COMMON_JS = !root.JS_MD5_NO_COMMON_JS && typeof module === 'object' && module.exports;
  var AMD = typeof define === 'function' && define.amd;
  var ARRAY_BUFFER = !root.JS_MD5_NO_ARRAY_BUFFER && typeof ArrayBuffer !== 'undefined';
  var HEX_CHARS = '0123456789abcdef'.split('');
  var HEX_CHARS2 = [ '' ].concat('123456789abcdef'.split(''));
  var EXTRA = [128, 32768, 8388608, -2147483648];
  var SHIFT = [0, 8, 16, 24];
  var OUTPUT_TYPES = ['hex', 'array', 'digest', 'buffer', 'arrayBuffer', 'base64'];
  var BASE64_ENCODE_CHAR = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

  var blocks = [], buffer8;
  if (ARRAY_BUFFER) {
    var buffer = new ArrayBuffer(68);
    buffer8 = new Uint8Array(buffer);
    blocks = new Uint32Array(buffer);
  }

  if (root.JS_MD5_NO_NODE_JS || !Array.isArray) {
    Array.isArray = function (obj) {
      return Object.prototype.toString.call(obj) === '[object Array]';
    };
  }

  if (ARRAY_BUFFER && (root.JS_MD5_NO_ARRAY_BUFFER_IS_VIEW || !ArrayBuffer.isView)) {
    ArrayBuffer.isView = function (obj) {
      return typeof obj === 'object' && obj.buffer && obj.buffer.constructor === ArrayBuffer;
    };
  }

  /**
   * @method hex
   * @memberof md5
   * @description Output hash as hex string
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {String} Hex string
   * @example
   * md5.hex('The quick brown fox jumps over the lazy dog');
   * // equal to
   * md5('The quick brown fox jumps over the lazy dog');
   */
  /**
   * @method digest
   * @memberof md5
   * @description Output hash as bytes array
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {Array} Bytes array
   * @example
   * md5.digest('The quick brown fox jumps over the lazy dog');
   */
  /**
   * @method array
   * @memberof md5
   * @description Output hash as bytes array
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {Array} Bytes array
   * @example
   * md5.array('The quick brown fox jumps over the lazy dog');
   */
  /**
   * @method arrayBuffer
   * @memberof md5
   * @description Output hash as ArrayBuffer
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {ArrayBuffer} ArrayBuffer
   * @example
   * md5.arrayBuffer('The quick brown fox jumps over the lazy dog');
   */
  /**
   * @method buffer
   * @deprecated This maybe confuse with Buffer in node.js. Please use arrayBuffer instead.
   * @memberof md5
   * @description Output hash as ArrayBuffer
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {ArrayBuffer} ArrayBuffer
   * @example
   * md5.buffer('The quick brown fox jumps over the lazy dog');
   */
  /**
   * @method base64
   * @memberof md5
   * @description Output hash as base64 string
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {String} base64 string
   * @example
   * md5.base64('The quick brown fox jumps over the lazy dog');
   */
  var createOutputMethod = function (outputType) {
    return function (message) {
      return new Md5(true).update(message)[outputType]();
    };
  };

  /**
   * @method create
   * @memberof md5
   * @description Create Md5 object
   * @returns {Md5} Md5 object.
   * @example
   * var hash = md5.create();
   */
  /**
   * @method update
   * @memberof md5
   * @description Create and update Md5 object
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {Md5} Md5 object.
   * @example
   * var hash = md5.update('The quick brown fox jumps over the lazy dog');
   * // equal to
   * var hash = md5.create();
   * hash.update('The quick brown fox jumps over the lazy dog');
   */
  var createMethod = function () {
    var method = createOutputMethod('hex');
    if (NODE_JS) {
      method = nodeWrap(method);
    }
    method.create = function () {
      return new Md5();
    };
    method.update = function (message) {
      return method.create().update(message);
    };
    for (var i = 0; i < OUTPUT_TYPES.length; ++i) {
      var type = OUTPUT_TYPES[i];
      method[type] = createOutputMethod(type);
    }
    return method;
  };

  var nodeWrap = function (method) {
    var crypto = eval("require('crypto')");
    var Buffer = eval("require('buffer').Buffer");
    var nodeMethod = function (message) {
      if (typeof message === 'string') {
        return crypto.createHash('md5').update(message, 'utf8').digest('hex');
      } else {
        if (message === null || message === undefined) {
          throw ERROR;
        } else if (message.constructor === ArrayBuffer) {
          message = new Uint8Array(message);
        }
      }
      if (Array.isArray(message) || ArrayBuffer.isView(message) ||
        message.constructor === Buffer) {
        return crypto.createHash('md5').update(new Buffer(message)).digest('hex');
      } else {
        return method(message);
      }
    };
    return nodeMethod;
  };

  /**
   * Md5 class
   * @class Md5
   * @description This is internal class.
   * @see {@link md5.create}
   */
  function Md5(sharedMemory) {
    if (sharedMemory) {
      blocks[0] = blocks[16] = blocks[1] = blocks[2] = blocks[3] =
      blocks[4] = blocks[5] = blocks[6] = blocks[7] =
      blocks[8] = blocks[9] = blocks[10] = blocks[11] =
      blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
      this.blocks = blocks;
      this.buffer8 = buffer8;
    } else {
      if (ARRAY_BUFFER) {
        var buffer = new ArrayBuffer(68);
        this.buffer8 = new Uint8Array(buffer);
        this.blocks = new Uint32Array(buffer);
      } else {
        this.blocks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      }
    }
    this.h0 = this.h1 = this.h2 = this.h3 = this.start = this.bytes = this.hBytes = 0;
    this.finalized = this.hashed = false;
    this.first = true;
  }

  /**
   * @method update
   * @memberof Md5
   * @instance
   * @description Update hash
   * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
   * @returns {Md5} Md5 object.
   * @see {@link md5.update}
   */
  Md5.prototype.update = function (message) {
    if (this.finalized) {
      return;
    }

    var notString, type = typeof message;
    if (type !== 'string') {
      if (type === 'object') {
        if (message === null) {
          throw ERROR;
        } else if (ARRAY_BUFFER && message.constructor === ArrayBuffer) {
          message = new Uint8Array(message);
        } else if (!Array.isArray(message)) {
          if (!ARRAY_BUFFER || !ArrayBuffer.isView(message)) {
            throw ERROR;
          }
        }
      } else {
        throw ERROR;
      }
      notString = true;
    }
    var code, index = 0, i, length = message.length, blocks = this.blocks;
    var buffer8 = this.buffer8;

    while (index < length) {
      if (this.hashed) {
        this.hashed = false;
        blocks[0] = blocks[16];
        blocks[16] = blocks[1] = blocks[2] = blocks[3] =
        blocks[4] = blocks[5] = blocks[6] = blocks[7] =
        blocks[8] = blocks[9] = blocks[10] = blocks[11] =
        blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
      }

      if (notString) {
        if (ARRAY_BUFFER) {
          for (i = this.start; index < length && i < 64; ++index) {
            buffer8[i++] = message[index];
          }
        } else {
          for (i = this.start; index < length && i < 64; ++index) {
            blocks[i >> 2] |= message[index] << SHIFT[i++ & 3];
          }
        }
      } else {
        if (ARRAY_BUFFER) {
          for (i = this.start; index < length && i < 64; ++index) {
            code = message.charCodeAt(index);
            if (code < 0x80) {
              buffer8[i++] = code;
            } else if (code < 0x800) {
              buffer8[i++] = 0xc0 | (code >> 6);
              buffer8[i++] = 0x80 | (code & 0x3f);
            } else if (code < 0xd800 || code >= 0xe000) {
              buffer8[i++] = 0xe0 | (code >> 12);
              buffer8[i++] = 0x80 | ((code >> 6) & 0x3f);
              buffer8[i++] = 0x80 | (code & 0x3f);
            } else {
              code = 0x10000 + (((code & 0x3ff) << 10) | (message.charCodeAt(++index) & 0x3ff));
              buffer8[i++] = 0xf0 | (code >> 18);
              buffer8[i++] = 0x80 | ((code >> 12) & 0x3f);
              buffer8[i++] = 0x80 | ((code >> 6) & 0x3f);
              buffer8[i++] = 0x80 | (code & 0x3f);
            }
          }
        } else {
          for (i = this.start; index < length && i < 64; ++index) {
            code = message.charCodeAt(index);
            if (code < 0x80) {
              blocks[i >> 2] |= code << SHIFT[i++ & 3];
            } else if (code < 0x800) {
              blocks[i >> 2] |= (0xc0 | (code >> 6)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
            } else if (code < 0xd800 || code >= 0xe000) {
              blocks[i >> 2] |= (0xe0 | (code >> 12)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | ((code >> 6) & 0x3f)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
            } else {
              code = 0x10000 + (((code & 0x3ff) << 10) | (message.charCodeAt(++index) & 0x3ff));
              blocks[i >> 2] |= (0xf0 | (code >> 18)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | ((code >> 12) & 0x3f)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | ((code >> 6) & 0x3f)) << SHIFT[i++ & 3];
              blocks[i >> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
            }
          }
        }
      }
      this.lastByteIndex = i;
      this.bytes += i - this.start;
      if (i >= 64) {
        this.start = i - 64;
        this.hash();
        this.hashed = true;
      } else {
        this.start = i;
      }
    }
    if (this.bytes > 4294967295) {
      this.hBytes += this.bytes / 4294967296 << 0;
      this.bytes = this.bytes % 4294967296;
    }
    return this;
  };

  Md5.prototype.finalize = function () {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    var blocks = this.blocks, i = this.lastByteIndex;
    blocks[i >> 2] |= EXTRA[i & 3];
    if (i >= 56) {
      if (!this.hashed) {
        this.hash();
      }
      blocks[0] = blocks[16];
      blocks[16] = blocks[1] = blocks[2] = blocks[3] =
      blocks[4] = blocks[5] = blocks[6] = blocks[7] =
      blocks[8] = blocks[9] = blocks[10] = blocks[11] =
      blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
    }
    blocks[14] = this.bytes << 3;
    blocks[15] = this.hBytes << 3 | this.bytes >>> 29;
    this.hash();
  };

  Md5.prototype.hash = function () {
    var a, b, c, d, bc, da, blocks = this.blocks;

    if (this.first) {
      a = blocks[0] - 680876937;
      a = (a << 7 | a >>> 25) - 271733879 << 0;
      d = (-1732584194 ^ a & 2004318071) + blocks[1] - 117830708;
      d = (d << 12 | d >>> 20) + a << 0;
      c = (-271733879 ^ (d & (a ^ -271733879))) + blocks[2] - 1126478375;
      c = (c << 17 | c >>> 15) + d << 0;
      b = (a ^ (c & (d ^ a))) + blocks[3] - 1316259209;
      b = (b << 22 | b >>> 10) + c << 0;
    } else {
      a = this.h0;
      b = this.h1;
      c = this.h2;
      d = this.h3;
      a += (d ^ (b & (c ^ d))) + blocks[0] - 680876936;
      a = (a << 7 | a >>> 25) + b << 0;
      d += (c ^ (a & (b ^ c))) + blocks[1] - 389564586;
      d = (d << 12 | d >>> 20) + a << 0;
      c += (b ^ (d & (a ^ b))) + blocks[2] + 606105819;
      c = (c << 17 | c >>> 15) + d << 0;
      b += (a ^ (c & (d ^ a))) + blocks[3] - 1044525330;
      b = (b << 22 | b >>> 10) + c << 0;
    }

    a += (d ^ (b & (c ^ d))) + blocks[4] - 176418897;
    a = (a << 7 | a >>> 25) + b << 0;
    d += (c ^ (a & (b ^ c))) + blocks[5] + 1200080426;
    d = (d << 12 | d >>> 20) + a << 0;
    c += (b ^ (d & (a ^ b))) + blocks[6] - 1473231341;
    c = (c << 17 | c >>> 15) + d << 0;
    b += (a ^ (c & (d ^ a))) + blocks[7] - 45705983;
    b = (b << 22 | b >>> 10) + c << 0;
    a += (d ^ (b & (c ^ d))) + blocks[8] + 1770035416;
    a = (a << 7 | a >>> 25) + b << 0;
    d += (c ^ (a & (b ^ c))) + blocks[9] - 1958414417;
    d = (d << 12 | d >>> 20) + a << 0;
    c += (b ^ (d & (a ^ b))) + blocks[10] - 42063;
    c = (c << 17 | c >>> 15) + d << 0;
    b += (a ^ (c & (d ^ a))) + blocks[11] - 1990404162;
    b = (b << 22 | b >>> 10) + c << 0;
    a += (d ^ (b & (c ^ d))) + blocks[12] + 1804603682;
    a = (a << 7 | a >>> 25) + b << 0;
    d += (c ^ (a & (b ^ c))) + blocks[13] - 40341101;
    d = (d << 12 | d >>> 20) + a << 0;
    c += (b ^ (d & (a ^ b))) + blocks[14] - 1502002290;
    c = (c << 17 | c >>> 15) + d << 0;
    b += (a ^ (c & (d ^ a))) + blocks[15] + 1236535329;
    b = (b << 22 | b >>> 10) + c << 0;
    a += (c ^ (d & (b ^ c))) + blocks[1] - 165796510;
    a = (a << 5 | a >>> 27) + b << 0;
    d += (b ^ (c & (a ^ b))) + blocks[6] - 1069501632;
    d = (d << 9 | d >>> 23) + a << 0;
    c += (a ^ (b & (d ^ a))) + blocks[11] + 643717713;
    c = (c << 14 | c >>> 18) + d << 0;
    b += (d ^ (a & (c ^ d))) + blocks[0] - 373897302;
    b = (b << 20 | b >>> 12) + c << 0;
    a += (c ^ (d & (b ^ c))) + blocks[5] - 701558691;
    a = (a << 5 | a >>> 27) + b << 0;
    d += (b ^ (c & (a ^ b))) + blocks[10] + 38016083;
    d = (d << 9 | d >>> 23) + a << 0;
    c += (a ^ (b & (d ^ a))) + blocks[15] - 660478335;
    c = (c << 14 | c >>> 18) + d << 0;
    b += (d ^ (a & (c ^ d))) + blocks[4] - 405537848;
    b = (b << 20 | b >>> 12) + c << 0;
    a += (c ^ (d & (b ^ c))) + blocks[9] + 568446438;
    a = (a << 5 | a >>> 27) + b << 0;
    d += (b ^ (c & (a ^ b))) + blocks[14] - 1019803690;
    d = (d << 9 | d >>> 23) + a << 0;
    c += (a ^ (b & (d ^ a))) + blocks[3] - 187363961;
    c = (c << 14 | c >>> 18) + d << 0;
    b += (d ^ (a & (c ^ d))) + blocks[8] + 1163531501;
    b = (b << 20 | b >>> 12) + c << 0;
    a += (c ^ (d & (b ^ c))) + blocks[13] - 1444681467;
    a = (a << 5 | a >>> 27) + b << 0;
    d += (b ^ (c & (a ^ b))) + blocks[2] - 51403784;
    d = (d << 9 | d >>> 23) + a << 0;
    c += (a ^ (b & (d ^ a))) + blocks[7] + 1735328473;
    c = (c << 14 | c >>> 18) + d << 0;
    b += (d ^ (a & (c ^ d))) + blocks[12] - 1926607734;
    b = (b << 20 | b >>> 12) + c << 0;
    bc = b ^ c;
    a += (bc ^ d) + blocks[5] - 378558;
    a = (a << 4 | a >>> 28) + b << 0;
    d += (bc ^ a) + blocks[8] - 2022574463;
    d = (d << 11 | d >>> 21) + a << 0;
    da = d ^ a;
    c += (da ^ b) + blocks[11] + 1839030562;
    c = (c << 16 | c >>> 16) + d << 0;
    b += (da ^ c) + blocks[14] - 35309556;
    b = (b << 23 | b >>> 9) + c << 0;
    bc = b ^ c;
    a += (bc ^ d) + blocks[1] - 1530992060;
    a = (a << 4 | a >>> 28) + b << 0;
    d += (bc ^ a) + blocks[4] + 1272893353;
    d = (d << 11 | d >>> 21) + a << 0;
    da = d ^ a;
    c += (da ^ b) + blocks[7] - 155497632;
    c = (c << 16 | c >>> 16) + d << 0;
    b += (da ^ c) + blocks[10] - 1094730640;
    b = (b << 23 | b >>> 9) + c << 0;
    bc = b ^ c;
    a += (bc ^ d) + blocks[13] + 681279174;
    a = (a << 4 | a >>> 28) + b << 0;
    d += (bc ^ a) + blocks[0] - 358537222;
    d = (d << 11 | d >>> 21) + a << 0;
    da = d ^ a;
    c += (da ^ b) + blocks[3] - 722521979;
    c = (c << 16 | c >>> 16) + d << 0;
    b += (da ^ c) + blocks[6] + 76029189;
    b = (b << 23 | b >>> 9) + c << 0;
    bc = b ^ c;
    a += (bc ^ d) + blocks[9] - 640364487;
    a = (a << 4 | a >>> 28) + b << 0;
    d += (bc ^ a) + blocks[12] - 421815835;
    d = (d << 11 | d >>> 21) + a << 0;
    da = d ^ a;
    c += (da ^ b) + blocks[15] + 530742520;
    c = (c << 16 | c >>> 16) + d << 0;
    b += (da ^ c) + blocks[2] - 995338651;
    b = (b << 23 | b >>> 9) + c << 0;
    a += (c ^ (b | ~d)) + blocks[0] - 198630844;
    a = (a << 6 | a >>> 26) + b << 0;
    d += (b ^ (a | ~c)) + blocks[7] + 1126891415;
    d = (d << 10 | d >>> 22) + a << 0;
    c += (a ^ (d | ~b)) + blocks[14] - 1416354905;
    c = (c << 15 | c >>> 17) + d << 0;
    b += (d ^ (c | ~a)) + blocks[5] - 57434055;
    b = (b << 21 | b >>> 11) + c << 0;
    a += (c ^ (b | ~d)) + blocks[12] + 1700485571;
    a = (a << 6 | a >>> 26) + b << 0;
    d += (b ^ (a | ~c)) + blocks[3] - 1894986606;
    d = (d << 10 | d >>> 22) + a << 0;
    c += (a ^ (d | ~b)) + blocks[10] - 1051523;
    c = (c << 15 | c >>> 17) + d << 0;
    b += (d ^ (c | ~a)) + blocks[1] - 2054922799;
    b = (b << 21 | b >>> 11) + c << 0;
    a += (c ^ (b | ~d)) + blocks[8] + 1873313359;
    a = (a << 6 | a >>> 26) + b << 0;
    d += (b ^ (a | ~c)) + blocks[15] - 30611744;
    d = (d << 10 | d >>> 22) + a << 0;
    c += (a ^ (d | ~b)) + blocks[6] - 1560198380;
    c = (c << 15 | c >>> 17) + d << 0;
    b += (d ^ (c | ~a)) + blocks[13] + 1309151649;
    b = (b << 21 | b >>> 11) + c << 0;
    a += (c ^ (b | ~d)) + blocks[4] - 145523070;
    a = (a << 6 | a >>> 26) + b << 0;
    d += (b ^ (a | ~c)) + blocks[11] - 1120210379;
    d = (d << 10 | d >>> 22) + a << 0;
    c += (a ^ (d | ~b)) + blocks[2] + 718787259;
    c = (c << 15 | c >>> 17) + d << 0;
    b += (d ^ (c | ~a)) + blocks[9] - 343485551;
    b = (b << 21 | b >>> 11) + c << 0;

    if (this.first) {
      this.h0 = a + 1732584193 << 0;
      this.h1 = b - 271733879 << 0;
      this.h2 = c - 1732584194 << 0;
      this.h3 = d + 271733878 << 0;
      this.first = false;
    } else {
      this.h0 = this.h0 + a << 0;
      this.h1 = this.h1 + b << 0;
      this.h2 = this.h2 + c << 0;
      this.h3 = this.h3 + d << 0;
    }
  };

  /**
   * @method hex
   * @memberof Md5
   * @instance
   * @description Output hash as hex string
   * @returns {String} Hex string
   * @see {@link md5.hex}
   * @example
   * hash.hex();
   */
  Md5.prototype.hex = function () {
    this.finalize();

    var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3;

    return HEX_CHARS2[(h0 >> 4) & 0x0F] + HEX_CHARS[h0 & 0x0F] +
      HEX_CHARS2[(h0 >> 12) & 0x0F] + HEX_CHARS[(h0 >> 8) & 0x0F] +
      HEX_CHARS2[(h0 >> 20) & 0x0F] + HEX_CHARS[(h0 >> 16) & 0x0F] +
      HEX_CHARS2[(h0 >> 28) & 0x0F] + HEX_CHARS[(h0 >> 24) & 0x0F] +
      HEX_CHARS2[(h1 >> 4) & 0x0F] + HEX_CHARS[h1 & 0x0F] +
      HEX_CHARS2[(h1 >> 12) & 0x0F] + HEX_CHARS[(h1 >> 8) & 0x0F] +
      HEX_CHARS2[(h1 >> 20) & 0x0F] + HEX_CHARS[(h1 >> 16) & 0x0F] +
      HEX_CHARS2[(h1 >> 28) & 0x0F] + HEX_CHARS[(h1 >> 24) & 0x0F] +
      HEX_CHARS2[(h2 >> 4) & 0x0F] + HEX_CHARS[h2 & 0x0F] +
      HEX_CHARS2[(h2 >> 12) & 0x0F] + HEX_CHARS[(h2 >> 8) & 0x0F] +
      HEX_CHARS2[(h2 >> 20) & 0x0F] + HEX_CHARS[(h2 >> 16) & 0x0F] +
      HEX_CHARS2[(h2 >> 28) & 0x0F] + HEX_CHARS[(h2 >> 24) & 0x0F] +
      HEX_CHARS2[(h3 >> 4) & 0x0F] + HEX_CHARS[h3 & 0x0F] +
      HEX_CHARS2[(h3 >> 12) & 0x0F] + HEX_CHARS[(h3 >> 8) & 0x0F] +
      HEX_CHARS2[(h3 >> 20) & 0x0F] + HEX_CHARS[(h3 >> 16) & 0x0F] +
      HEX_CHARS2[(h3 >> 28) & 0x0F] + HEX_CHARS[(h3 >> 24) & 0x0F];
  };

  /**
   * @method toString
   * @memberof Md5
   * @instance
   * @description Output hash as hex string
   * @returns {String} Hex string
   * @see {@link md5.hex}
   * @example
   * hash.toString();
   */
  Md5.prototype.toString = Md5.prototype.hex;

  /**
   * @method digest
   * @memberof Md5
   * @instance
   * @description Output hash as bytes array
   * @returns {Array} Bytes array
   * @see {@link md5.digest}
   * @example
   * hash.digest();
   */
  Md5.prototype.digest = function () {
    this.finalize();

    var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3;
    return [
      h0 & 0xFF, (h0 >> 8) & 0xFF, (h0 >> 16) & 0xFF, (h0 >> 24) & 0xFF,
      h1 & 0xFF, (h1 >> 8) & 0xFF, (h1 >> 16) & 0xFF, (h1 >> 24) & 0xFF,
      h2 & 0xFF, (h2 >> 8) & 0xFF, (h2 >> 16) & 0xFF, (h2 >> 24) & 0xFF,
      h3 & 0xFF, (h3 >> 8) & 0xFF, (h3 >> 16) & 0xFF, (h3 >> 24) & 0xFF
    ];
  };

  /**
   * @method array
   * @memberof Md5
   * @instance
   * @description Output hash as bytes array
   * @returns {Array} Bytes array
   * @see {@link md5.array}
   * @example
   * hash.array();
   */
  Md5.prototype.array = Md5.prototype.digest;

  /**
   * @method arrayBuffer
   * @memberof Md5
   * @instance
   * @description Output hash as ArrayBuffer
   * @returns {ArrayBuffer} ArrayBuffer
   * @see {@link md5.arrayBuffer}
   * @example
   * hash.arrayBuffer();
   */
  Md5.prototype.arrayBuffer = function () {
    this.finalize();

    var buffer = new ArrayBuffer(16);
    var blocks = new Uint32Array(buffer);
    blocks[0] = this.h0;
    blocks[1] = this.h1;
    blocks[2] = this.h2;
    blocks[3] = this.h3;
    return buffer;
  };

  /**
   * @method buffer
   * @deprecated This maybe confuse with Buffer in node.js. Please use arrayBuffer instead.
   * @memberof Md5
   * @instance
   * @description Output hash as ArrayBuffer
   * @returns {ArrayBuffer} ArrayBuffer
   * @see {@link md5.buffer}
   * @example
   * hash.buffer();
   */
  Md5.prototype.buffer = Md5.prototype.arrayBuffer;

  /**
   * @method base64
   * @memberof Md5
   * @instance
   * @description Output hash as base64 string
   * @returns {String} base64 string
   * @see {@link md5.base64}
   * @example
   * hash.base64();
   */
  Md5.prototype.base64 = function () {
    var v1, v2, v3, base64Str = '', bytes = this.array();
    for (var i = 0; i < 15;) {
      v1 = bytes[i++];
      v2 = bytes[i++];
      v3 = bytes[i++];
      base64Str += BASE64_ENCODE_CHAR[v1 >>> 2] +
        BASE64_ENCODE_CHAR[(v1 << 4 | v2 >>> 4) & 63] +
        BASE64_ENCODE_CHAR[(v2 << 2 | v3 >>> 6) & 63] +
        BASE64_ENCODE_CHAR[v3 & 63];
    }
    v1 = bytes[i];
    base64Str += BASE64_ENCODE_CHAR[v1 >>> 2] +
      BASE64_ENCODE_CHAR[(v1 << 4) & 63] +
      '==';
    return base64Str;
  };

  var exports = createMethod();

  if (COMMON_JS) {
    module.exports = exports;
  } else {
    /**
     * @method md5
     * @description Md5 hash function, export to global in browsers.
     * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
     * @returns {String} md5 hashes
     * @example
     * md5(''); // d41d8cd98f00b204e9800998ecf8427e
     * md5('The quick brown fox jumps over the lazy dog'); // 9e107d9d372bb6826bd81d3542a419d6
     * md5('The quick brown fox jumps over the lazy dog.'); // e4d909c290d0fb1ca068ffaddf22cbd0
     *
     * // It also supports UTF-8 encoding
     * md5('中文'); // a7bac2239fcdcb3a067903d8077c4a07
     *
     * // It also supports byte `Array`, `Uint8Array`, `ArrayBuffer`
     * md5([]); // d41d8cd98f00b204e9800998ecf8427e
     * md5(new Uint8Array([])); // d41d8cd98f00b204e9800998ecf8427e
     */
    root.md5 = exports;
    if (AMD) {
      define(function () {
        return exports;
      });
    }
  }
})();

self.RUN = 1;
self.ABORT = 2;

// messages from worker to main
self.OUTPUT = 10;
self.PROGRESS = 11;
self.ERROR = 12;
self.DONE = 13;

var MapStatus = [];
MapStatus[401] = "Unauthorized";
MapStatus[402] = "Payment Required";
MapStatus[403] = "Forbidden";
MapStatus[404] = "Not Found";
MapStatus[405] = "Method Not Allowed";
MapStatus[406] = "Not Acceptable";
MapStatus[407] = "Proxy Authentication Required";
MapStatus[408] = "Request Timeout";
MapStatus[409] = "Conflict";
MapStatus[410] = "Gone";
MapStatus[411] = "Length Required";
MapStatus[412] = "Precondition Failed";
MapStatus[413] = "Payload Too Large";
MapStatus[414] = "URI Too Large";
MapStatus[415] = "Unsupported Media Type";
MapStatus[429] = "Too Many Requests";
MapStatus[431] = "Request Header Fields Too Large";
MapStatus[451] = "Unavailable For Legal Reasons";
MapStatus[500] = "Internal Server Error";
MapStatus[501] = "Not Implemented";
MapStatus[502] = "Bad Gateway";
MapStatus[503] = "Service Unavailable";
MapStatus[504] = "Gateway Timeout";

function getXMLHttpRequest() {
  if( XMLHttpRequest )
    return new XMLHttpRequest();
  else
    return new ActiveXObject("Microsoft.XMLHTTP");
}

// test input
var testinput = [
  "(user1) item1 : item2",
  "(user2) item2 : item1"
];

//I could not get this style JS enums to work
//const VertexType { RECEIVER:1, SENDER:2 }
//const EdgeStatus { UNKNOWN:1, REQUIRED:2, OPTIONAL:3, FORBIDDEN:4 }
//const PriorityType { NO_PRIORITIES:1, LINEAR_PRIORITIES:2, TRIANGLE_PRIORITIES:3,
//                     SQUARE_PRIORITIES:4, SCALED_PRIORITIES:5, EXPLICIT_PRIORITIES:6 } }

const RECEIVER = 1;
const SENDER = 2;
const UNKNOWN = 3;
const REQUIRED = 4;
const OPTIONAL = 5;
const FORBIDDEN = 6;

const INFINITY  = 10000000000000000; // 10^16 from class Graph
//const INFINITY2 = 100000000000000;   // 10^14 from class TradeMaximizer
const UNIT = 1;

const version = "Version 0.1";

const NO_PRIORITIES = 0;
const LINEAR_PRIORITIES = 1;
const TRIANGLE_PRIORITIES = 2;
const SQUARE_PRIORITIES = 3;
const SCALED_PRIORITIES = 4; // no longer supported!!
const EXPLICIT_PRIORITIES = 5;

class MetricSumSquares {
  constructor() {
    this.name = "MetricSumSquares";
    this.sumOfSquares = 0;
    this.counts = null;
  }

  calculate(cycles) {
    this.sumOfSquares = 0;
    this.counts = [];
    for( let cycle of cycles ) {
      this.sumOfSquares += cycle.length * cycle.length;
      this.counts.push(cycle.length);
    }
    this.counts = this.counts.sort(function(a, b){return b - a});
    return this.sumOfSquares;
  }

  toString() {
    let str = "[ " + this.sumOfSquares + " :";

    for( let c of this.counts )
      str += " " + c;

    return str + " ]";
  }
} // class MetricSumSquares 

class MetricUsersTrading {
  constructor() {
    this.name = "MetricUsersTrading";
    this.count = 0;
  }

  calculate(cycles) {
    let users = new Array();

    for( let cycle of cycles )
      for( let vert of cycle )
        users[vert.user] = 1;

    this.count = Object.keys(users).length;

    return -this.count;
  }

  toString() {
    return "[ users trading = " + this.count + " ]";
  }
} // class MetricUsersTrading

var metricmap = [];
metricmap["CHAIN-SIZES-SOS"] = new MetricSumSquares();
metricmap["USERS-TRADING"]   = new MetricUsersTrading();

class Entry {
  constructor(vertex, cost, heap) {
    this.vertex = vertex;
    this.cost = cost;
    this.heap = heap;
    this.child = null;
    this.sibling = null;
    this.prev = null;
    this.used = false;
  }

  decreaseCost(toCost) {
    this.cost = toCost;
    if( this == this.heap.root || this.cost >= this.prev.cost )
      return;
    if( this == this.prev.child )
      this.prev.child = this.sibling;
    else
      this.prev.sibling = this.sibling;
    if( this.sibling != null )
      this.sibling.prev = this.prev;
    this.prev = null;

    this.heap.root = this.heap.merge(this, this.heap.root);
  }
}

class Heap {
  constructor() {
    this.root = null;
  }

  isEmpty() {
    return this.root == null;
  }

  merge(a, b) {
    if( b.cost < a.cost ) {
      let tmp = a;
      a = b;
      b = tmp;
    }
    b.prev = a;
    b.sibling = a.child;
    if( b.sibling != null )
      b.sibling.prev = b;
    a.child = b;
    return a;
  }

  extractMin() {
    let minEntry = this.root;

    this.root.used = true;

    let list = this.root.child;

    if( list != null ) {
      while( list.sibling != null ) {
        let nextList = null;
        while( list != null && list.sibling != null ) {
          let a = list;
          let b = a.sibling;

          list = b.sibling;

          a.sibling = null;
          b.sibling = null;
          a = this.merge(a,b);
          a.sibling = nextList;
          nextList = a;
        }
        if( list == null )
          list = nextList;
        else
          list.sibling = nextList;
      }
      list.prev = null;
    }
    this.root = list;
    return minEntry;
  }

  insert(vertex, cost) {
    let entry = new Entry(vertex, cost, this);
    this.root = this.root == null ? entry : this.merge(entry, this.root);
    return entry;
  }
} // class Heap

class Vertex {
  constructor(name, user, isDummy, type) {
    this.name = name;
    this.user = user;
    this.isDummy = isDummy;
    this.type = type;

    this.edgeMap = [];
    this.edgeList = [];
    this.edges = null;

    this.minimumInCost = Number.MAX_SAFE_INTEGER;
    this.twin = null;
    this.mark = 0;
    this.match = null;
    this.matchCost = 0;
    this.from = null;
    this.price = 0;
    this.heapEntry = null;
    this.component = 0;
    this.used = false;

    this.savedMatch = null;
    this.savedMatchCost = 0;

    this.dirty = true;
  }

  toString() {
    return this.name + this.user + "/" + this.type;
  }
}

class Edge {
  constructor(receiver, sender, cost) {
    this.receiver = receiver;
    this.sender = sender;
    this.cost = cost;
    this.status = UNKNOWN;
  }

  toString() {
    return this.receiver.toString() + "-from-" + this.sender.toString();
  }
}

class Graph {
  constructor(tm) {
    this.tm = tm;
    this.hasBeenFullyShrunk = false;
    this.sinkFrom = null;
    this.sinkCost = null;
    this.receiverList = new Array();
    this.senderList = new Array();
    this.receivers = [];
    this.senders = [];
    this.orphans = [];
    this.frozen = false;
    this.nameMap = new Array();
    this.timestamp = 0;
    this.component = 0;
    this.finished = [];
    this.seed = null;
    this.random = null;
    this.randomSequence = [];
this.rngcount = 0;
  }

  getVertex(name) {
    return this.nameMap[name];
  }

  addVertex(name, user, isDummy) {
    let receiver = new Vertex(name, user, isDummy, RECEIVER);

    this.receiverList.push(receiver);
    this.nameMap[name] = receiver;

    let sender = new Vertex(name, user, isDummy, SENDER);
    this.senderList.push(sender);
    receiver.twin = sender;
    sender.twin = receiver;

    return receiver;
  }

  addEdge(receiver, sender, cost) {
    let edge = new Edge(receiver,sender,cost);
    receiver.edgeMap[sender] = edge;
    sender.edgeMap[receiver] = edge;
    receiver.edgeList.push(edge);
    sender.edgeList.push(edge);
    return edge;
  }

  getEdge(receiver, sender) {
    return receiver.edgeMap[sender];
  }

  freeze() {
    this.receivers = this.receiverList;
    this.senders = this.senderList;

    this.receiverList = this.senderList = null;

    for( let v of this.receivers )
      v.edges = v.edgeList;
    for( let v of this.senders )
      v.edges = v.edgeList;

    this.frozen = true;
  }

  advanceTimestamp() {
    this.timestamp++;
  }

  visitReceivers(receiver) {
    receiver.mark = this.timestamp;
    for( let edge of receiver.edges ) {
      let v = edge.sender.twin;
      if( v.mark != this.timestamp )
        this.visitReceivers(v);
    }
    this.finished.push(receiver.twin);
  }

  visitSenders(sender) {
    sender.mark = this.timestamp;
    for( let edge of sender.edges ) {
      let v = edge.receiver.twin;
      if( v.mark != this.timestamp )
        this.visitSenders(v);
    }
    sender.component = this.component;
    sender.twin.component = this.component;
  }

  removeBadEdges(v) {
    let newedges = [];

    for( let edge of v.edges ) {
      if( edge.receiver.component == edge.sender.component )
	newedges.push(edge);
      else
        edge.sender.dirty = true;
    }
    v.edges = newedges;
  }

  removeImpossibleEdgesAndOrphans() {
    this.advanceTimestamp();
    this.finished = new Array();

    for( let v of this.receivers )
      if( v.mark != this.timestamp )
        this.visitReceivers(v);

    this.finished = this.finished.reverse();

    for( let v of this.finished ) {
      if( v.mark != this.timestamp ) {
        this.component++;
        this.visitSenders(v);
      }
    }

    for( let v of this.receivers ) this.removeBadEdges(v);
    for( let v of this.senders )   this.removeBadEdges(v);

    this.removeOrphans();
  }

  removeOrphans() {
    let newreceivers = [];

    for( let v of this.receivers ) {
      if( v.edges.length > 1 || v.edges[0].sender != v.twin )
        newreceivers.push(v);
      else
        this.orphans.push(v);
    }

    if( newreceivers.length == this.receivers.length )
      return;

    this.receivers = newreceivers;

    let newsenders = [];

    for( let v of this.senders ) {
      if( v.edges.length > 1 || v.edges[0].receiver != v.twin )
        newsenders.push(v);
    }
    this.senders = newsenders;
  }

  dijkstra() {
    this.sinkFrom = null;
    this.sinkCost = Number.MAX_SAFE_INTEGER;

    let heap = new Heap();

    for( let v of this.senders ) {
      v.from = null;
      v.heapEntry = heap.insert(v, INFINITY);
    }
    for( let v of this.receivers ) {
      v.from = null;
      let cost = v.match == null ? 0 : INFINITY;
      v.heapEntry = heap.insert(v, cost);
    }

    while( ! heap.isEmpty() ) {
      let minEntry = heap.extractMin();
      let vertex = minEntry.vertex;
      let cost = minEntry.cost;

      if( cost == INFINITY )
        break;

      if( vertex.type == RECEIVER ) {
        for( let e of vertex.edges ) {
          let other = e.sender;
          if( other == vertex.match )
            continue;

          let c = vertex.price + e.cost - other.price;
          if( cost + c < other.heapEntry.cost ) {
            other.heapEntry.decreaseCost(cost + c);
            other.from = vertex;
          }
        }
      }
      else if( vertex.match == null ) {
        if( cost < this.sinkCost ) {
          this.sinkFrom = vertex;
          this.sinkCost = cost;
        }
      }
      else {
        let other = vertex.match;
        let c = vertex.price - other.matchCost - other.price;
        if( cost + c < other.heapEntry.cost ) {
          other.heapEntry.decreaseCost(cost + c);
          other.from = vertex;
        }
      }
    }
  }

  findBestMatches() {
    if( this.hasBeenFullyShrunk ) {
      this.findUnweightedMatches();
      return;
    }

    for( let v of this.receivers ) {
      v.match = null;
      v.price = 0;
    }

    for( let v of this.senders ) {
      v.match = null;
      if( v.dirty ) {
        v.minimumInCost = Number.MAX_SAFE_INTEGER;
        for( let edge of v.edges )
          v.minimumInCost = Math.min(edge.cost, v.minimumInCost);
        v.dirty = false;
      }
      v.price = v.minimumInCost;
    }

    for( let round = 0 ; round < this.receivers.length ; round++ ) {
      this.dijkstra();

      let sender = this.sinkFrom;
      while( sender != null ) {
        let receiver = sender.from;

        if( sender.match != null )
          sender.match.match = null;
        if( receiver.match != null )
          receiver.match.match = null;

        sender.match = receiver;
        receiver.match = sender;

        for( let e of receiver.edges )
          if( e.sender == sender ) {
            receiver.matchCost = e.cost;
            break;
          }

        sender = receiver.from;
      }

      for( let v of this.receivers )
        v.price += v.heapEntry.cost;
      for( let v of this.senders )
        v.price += v.heapEntry.cost;
    }
  }

  findCycles() {
    this.findBestMatches();
    this.elideDummies();
    this.advanceTimestamp();

    let cycles = new Array();

    for( let vertex of this.receivers ) {
      if( vertex.mark == this.timestamp || vertex.match == vertex.twin )
        continue;

      let cycle = new Array();
      let v = vertex;
      while( v.mark != this.timestamp ) {
        v.mark = this.timestamp;
        cycle.push(v);
        v = v.match.twin;
      }
      cycles.push(cycle);
    }
    return cycles;
  }

  randomsneeded() {
    let count = this.receivers.length;
    for( let v of this.receivers )
      count += v.edges.length;
    return count;
  }

  setSeed(seed) {
    this.seed = seed;
    this.random = new JavaRandom(seed);
  }

  nextInt(bound) {
    ++this.rngcount;
    let r = this.random.nextInt(bound);
    //this.randomSequence.push(bound + "/" + r);
    return r;
  }

  shuffleit(a) {
    for( let i = a.length ; i > 1 ; i-- ) {
      let j = this.nextInt(i);
      let tmp = a[j];
      a[j] = a[i-1];
      a[i-1] = tmp;
    }
  }

  shuffle() {
    this.shuffleit(this.receivers);
    for( let v of this.receivers )
      this.shuffleit(v.edges);
  }

  elideDummies() {
    for( let v of this.receivers ) {
      while( v.match.isDummy && v.match != v.twin ) {
        let dummySender = v.match;
        let nextSender = dummySender.twin.match;
        v.match = nextSender;
        nextSender.match = v;
        dummySender.match = dummySender.twin;
        dummySender.twin.match = dummySender;
      }
    }
  }

  saveMatches() {
    for( let v of this.receivers ) {
      v.savedMatch = v.match;
      v.savedMatchCost = v.matchCost;
    }
    for( let v of this.senders )
      v.savedMatch = v.match;
  }

  restoreMatches() {
    for( let v of this.receivers ) {
      v.match = v.savedMatch;
      v.matchCost = v.savedMatchCost;
    }
    for( let v of this.senders )
      v.match = v.savedMatch;
  }

  shrink(level, verbose) {
    this.reportStats("Original", verbose);

    this.removeImpossibleEdgesAndOrphans();
    this.reportStats("Shrink 0 (SCC)", verbose);
    if( level == 0 )
      return;

    let startTime = Date.now();

    let factor = this.receivers.length + 1;

    this.scaleUpEdgeCosts(factor);

    this.findRequiredEdgesAndShrink(verbose);
    this.removeImpossibleEdgesAndOrphans();
    this.reportStats("Shrink 1 (SCC)", verbose);
    if( verbose )
      this.tm.outputln("Shrink 1 time = " + (Date.now() - startTime) + "ms");

    if( level > 1 ) {
      this.findForbiddenEdgesAndShrink(verbose);
      this.removeImpossibleEdgesAndOrphans();
      this.reportStats("Shrink 2 (SCC)", verbose);
      if( verbose )
        this.tm.outputln("Shrink 2 time = " + (Date.now() - startTime) + "ms");
      this.hasBeenFullyShrunk = true;
    }

    this.scaleDownEdgeCosts(factor);
  }

  scaleUpEdgeCosts(factor) {
    for( let v of this.senders ) {
      v.dirty = true;
      for( let e of v.edges )
        e.cost *= factor;
    }
  }

  scaleDownEdgeCosts(factor) {
    for( let v of this.senders ) {
      v.dirty = true;
      for( let e of v.edges )
        e.cost = Math.floor(e.cost/factor);
    }
  }

  findRequiredEdgesAndShrink(verbose) {
    let numRequired = this.receivers.length;
    let totalCost = 0;
    let requiredEdges = new Array(numRequired);
    let run = 1;

    if( ! verbose )
      this.tm.output("Shrink (level 1) ");

    this.findBestMatches();

    //let tradeCount = 0;

    for( let i = 0 ; i < this.receivers.length ; i++ ) {
      let v = this.receivers[i];
      let e = v.edgeMap[v.match];
      //if( v.match != v.twin )
      //  tradeCount++;
      totalCost += e.cost;
      requiredEdges[i] = e;
      e.status = REQUIRED;
      e.cost++;
      if( e.cost == e.sender.minimumInCost+1 )
        e.sender.dirty = true;
    }

    this.reportStatsOrDot("Shrink 1."+run, verbose);

    for( run = 2 ; numRequired > 0 ; run++ ) {
      this.findBestMatches();
      let currentCost = 0;
      let edgeSet = [];
      for( let v of this.receivers ) {
        let e = v.edgeMap[v.match];
        edgeSet.push(e);
        currentCost += e.cost;
        if( e.status != REQUIRED )
          e.status = OPTIONAL;
      }
      if( currentCost == totalCost + numRequired ) {
        this.reportStatsOrDot("Shrink 1."+run, verbose);
        break;
      }
      let count = 0;
      for( let i = 0 ; i < numRequired ; i++ ) {
        let e = requiredEdges[i];
        if( edgeSet.includes(e) )
          requiredEdges[count++] = e;
        else {
          e.status = OPTIONAL;
          e.cost--;
          if( e.cost == e.sender.minimumInCost-1 )
            e.sender.dirty = true;
        }
      }
      numRequired = count;
      this.reportStatsOrDot("Shrink 1."+run, verbose);
    }

    for( let i = 0 ; i < numRequired ; i++ ) {
      let e = requiredEdges[i];
      this.markEdgesForbiddenIfNotRequired(e.receiver);
      this.markEdgesForbiddenIfNotRequired(e.sender);
    }

    for( let v of this.receivers )
      this.removeEdges(v, FORBIDDEN);
    for( let v of this.senders )
      this.removeEdges(v, FORBIDDEN);

/*
    for( let i = 0 ; i < numRequired ; i++ ) {
      let e = requiredEdges[i];
      assert e.receiver.edges.length == 1;
      assert e.sender.edges.length == 1;
    }
*/

    if( verbose )
      this.reportStats("Shrink 1 complete", verbose);
    else
      this.tm.outputln("");
  }

  findForbiddenEdgesAndShrink(verbose) {
    let V = this.receivers.length;
    let run = 1;

    for( let v of this.receivers )
      for( let e of v.edges )
        if( e.status == OPTIONAL) {
          e.cost++;
          if( e.cost == e.sender.minimumInCost+1 )
            e.sender.dirty = true;
        }

    if( ! verbose )
      this.tm.output("Shrink (level 2) ");

    for( let newEdges = 999 ; newEdges > 0 ; run++ ) {
      this.findBestMatches();
      newEdges = 0;
      let edgeSet = new Array(V);
      for( let v of this.receivers ) {
        let e = v.edgeMap[v.match];
        if( e.status == UNKNOWN ) {
          e.status = OPTIONAL;
          e.cost++;
          if( e.cost == e.sender.minimumInCost+1 )
            e.sender.dirty = true;
          newEdges++;
        }
      }
      this.reportStatsOrDot("Shrink 2."+run, verbose);
    }

    for( let v of this.receivers )
      this.removeEdges(v, UNKNOWN);
    for( let v of this.senders )
      this.removeEdges(v, UNKNOWN);

    if( verbose )
      this.reportStats("Shrink level 2 complete", verbose);
    else
      this.tm.outputln("");
  }

  markEdgesForbiddenIfNotRequired(v) {
    for( let e of v.edges )
      if( e.status != REQUIRED )
        e.status = FORBIDDEN;
  }

  removeEdges(v, statusToRemove) {
    let newedges = [];

    for( let e of v.edges )
      if( e.status == statusToRemove )
        e.sender.dirty = true;
      else
        newedges.push(e);

    v.edges = newedges;
  }

  reportStatsOrDot(name, verbose) {
    if( verbose )
      this.reportStats(name, verbose);
    else
      this.tm.output(".");
  }

  reportStats(name, verbose) {
    if( ! verbose )
      return;

    let histogram = [];
    let edgeCount = 0;

    histogram[REQUIRED] = 0;
    histogram[OPTIONAL] = 0;
    histogram[UNKNOWN] = 0;

    for( let v of this.receivers )
      for( let e of v.edges ) {
        histogram[e.status]++;
        edgeCount++;
      }

    this.tm.outputln(name +
      ": V=" + this.receivers.length +
      " E=" + edgeCount +
      " REQUIRED=" + histogram[REQUIRED] +
      " OPTIONAL=" + histogram[OPTIONAL] +
      " UNKNOWN="  + histogram[UNKNOWN]);
  }

  findUnweightedMatches() {
    for( let v of this.receivers )
      v.match = null;
    for( let v of this.senders ) {
      v.match = null;
      v.price = 0; 
    }

    let n = this.receivers.length;
    let receiverStack = new Array(n);
    let indexStack = new Array(n);
    let senderStack = new Array(n);
    let time = 0;

    for( let v of this.receivers ) {
      time++;

      let pos = 0;
      receiverStack[pos] = v;
      indexStack[pos] = 0;
      v.price = time;

      while( true ) {
        let receiver = receiverStack[pos];
        let i = indexStack[pos]++;
        if( i == receiver.edges.length )
          pos--;
        else {
          let sender = receiver.edges[i].sender;
          if( sender.price == time )
            continue;

          senderStack[pos] = sender;
          if( sender.match == null )
            break;

          sender.price = time; // mark as visited
          receiverStack[++pos] = sender.match;
          indexStack[pos] = 0;
        }
      }

      for( let i = 0 ; i <= pos ; i++ ) {
        let receiver = receiverStack[i];
        let sender = senderStack[i];
        receiver.match = sender;
        sender.match = receiver;
      }
    }

    for( let v of this.receivers ) {
      let matchCost = v.edgeMap[v.match].cost;
      v.matchCost = v.match.matchCost = matchCost;
    }
  }
}

class TradeMaximizer {
  constructor() {
    this.iterations = 1;
    this.priorityScheme = NO_PRIORITIES;
    this.smallStep = 1;
    this.bigStep = 9;
    this.nonTradeCost = 1000000000; // 1 billion
    this.shrinkLevel = 0;
    this.shrinkVerbose = false;
    this.officialNames = null;
    this.usedNames = new Array();
    this.graph = null;
    this.errors = new Array();
    this.options = new Array();
    this.ITEMS = 0;
    this.DUMMY_ITEMS = 0;
    this.width = 1;

    this.caseSensitive = false;
    this.requireColons = false;
    this.requireUsernames = false;
    this.showErrors = true;
    this.showRepeats = true;
    this.showLoops = true;
    this.showSummary = true;
    this.showNonTrades = true;
    this.showStats = true;
    this.showMissing = false;
    this.sortByItem = false;
    this.allowDummies = false;
    this.showElapsedTime = false;
    this.showWants = false;
    this.verbose = false;

    this.metric = [ metricmap["CHAIN-SIZES-SOS"] ];

    this.infunc = null;
    this.outfunc = null;
    this.progress = null;
    this.fatal = null;

this.inputindex = 0;
this.outputstr = "";
  }

  readLine() {
    return this.infunc();
//if( this.inputindex >= testinput.length ) return null;
//return testinput[this.inputindex++];
  }

  output(s) {
    this.outfunc(s, false);
//this.outputstr += s;
  }

  outputln(s) {
    this.outfunc(s, true);
//this.outputstr += s + "\n";
  }

  fatalError(s) {
    if( this.fatal ) {
      this.fatal(s);
    }
    else {
      //outputln(s);
      alert(s);
    }
  }

  run(input,out,progress,fatal) {
    this.infunc = input;
    this.outfunc = out;
    this.progress = progress;
    this.fatal = fatal;

    this.outputln("TradeMaximizer Javascript " + version);
    this.outputln("Run Date: " + (new Date()).toTimeString());

    this.graph = new Graph(this);

    let wantLists = this.readWantLists();
    if( wantLists == null )
      return;

    if( this.options.length > 0 ) {
      this.output("Options:");
      for( let option of this.options )
        this.output(" " + option);
      this.outputln("");
    }

    if( this.priorityScheme != NO_PRIORITIES && (this.metric.length > 1 || this.metric[0].name != "MetricSumSquares") )
      this.outputln("Warning: using priorities with the non-default metric is normally worthless");

    let hash = md5.create();
    for( let wset of wantLists ) {
      for( let w of wset ) {
        hash.update(' ');
        hash.update(w);
      }
      hash.update("\n");
    }
    this.outputln("Input Checksum: " + hash.hex());

    this.buildGraph(wantLists);

    if( this.showErrors && this.errors.length > 0 ) {
      this.outputln("ERRORS:");
      for( let error of this.errors.sort() )
        this.outputln(error);
      this.outputln("");
    }

    let startTime = Date.now();

    if( this.iterations > 1 && this.progress != null )
      this.progress(0, this.iterations, "", "");

    this.graph.shrink(this.shrinkLevel, this.shrinkVerbose);

/*
this.outputln("Dump of graph, count="+this.graph.receivers.length);
for( let i = 0 ; i < this.graph.receivers.length ; i++ ) {
  this.outputln(i+": "+this.graph.receivers[i].name);
}
*/

/*
    if( this.iterations > 1 )
      this.outputln("Number of random numbers needed: " + this.graph.randomsneeded() * this.iterations);
*/

    let bestCycles = this.graph.findCycles();

    let bestMetric = [];
    let bestMetricStr = "";
    for( let m of this.metric ) {
      bestMetric.push(m.calculate(bestCycles));
      bestMetricStr += m.toString();
    }

    let tradeCount = 0;

    for( let cycle of bestCycles )
      tradeCount += cycle.length;

    if( this.iterations > 1 && this.progress != null )
      this.progress(1, this.iterations, bestMetricStr, tradeCount);

    this.outputln(bestMetricStr + " (iteration 0)");

    if( this.iterations > 1 ) {
      this.graph.saveMatches();
      for( let i = 1 ; i <= this.iterations-1 ; i++ ) {
        if( this.progress != null )
          this.progress(i, this.iterations, bestMetricStr, tradeCount);

        this.graph.shuffle();

/*
this.outputln("Dump of graph, count="+this.graph.receivers.length + ", iteration="+i);
for( let i = 0 ; i < this.graph.receivers.length ; i++ ) {
  this.outputln(i+": "+this.graph.receivers[i].name);
}
*/

        let cycles = this.graph.findCycles();

        //let metric = this.metric[0].calculate(cycles);

        let foundBetter = false;
        let newmetrics = [];
        let newmetricsStr = "";
        for( let i = 0 ; i < this.metric.length ; i++ ) {
          let value = this.metric[i].calculate(cycles);
          newmetrics.push(value);
          newmetricsStr += this.metric[i].toString();
          if( value < bestMetric[i] ) {
            // we found better results
            for( let j = i+1 ; j < this.metric.length ; j++ ) {
              newmetrics.push(this.metric[j].calculate(cycles));
              newmetricsStr += this.metric[j].toString();
            }
            foundBetter = true;
            break;
          }
          else if( value > bestMetric[i] )
            break;
          // else if they are equal of course go to next metric
        }

        if( foundBetter ) {
          bestCycles = cycles;
          this.graph.saveMatches();

          bestMetric = newmetrics;
          bestMetricStr = newmetricsStr;

          this.outputln(bestMetricStr + " (iteration " + i + ")");
          tradeCount = 0;
          for( let cycle of bestCycles )
            tradeCount += cycle.length;
        }
        else if( this.verbose )
          this.outputln("# " + newmetricsStr + " (iteration " + i + ")");
      }
      this.outputln("Completed " + this.iterations + " iterations.");
      this.outputln("");
      this.graph.restoreMatches();
    }
    let stopTime = Date.now();
    this.displayMatches(bestCycles);

    if (this.showElapsedTime)
      this.outputln("Elapsed time = " + (stopTime-startTime) + "ms");
  }

  sumOfSquares(cycles) {
    let sum = 0;
    for( let cycle of cycles )
      sum += cycle.length * cycle.length;
    return sum;
  }

  readWantLists() {
    let bigStepFlag = false, smallStepFlag = false;
    let readingOfficialNames = false;
    let wantLists = new Array();

    for( let lineNumber = 1 ; ; lineNumber++ ) {
      let line = this.readLine();
      if( line == null )
        return wantLists;
      line = line.trim();

      if( line.length == 0 )
        continue;
      if( line.match("#!.*") ) {
        if( wantLists.length > 0 )
          this.fatalError("Options (#!...) cannot be declared after first real want list", lineNumber);
        if( this.officialNames != null )
          this.fatalError("Options (#!...) cannot be declared after official names", lineNumber);

        let optionslist = line.toUpperCase().substring(2).trim().split(/\s+/);
        for( let option of optionslist ) {
            if (option == "CASE-SENSITIVE" )
              this.caseSensitive = true;
            else if (option == "REQUIRE-COLONS" )
              this.requireColons = true;
            else if (option == "REQUIRE-USERNAMES" )
              this.requireUsernames = true;
            else if (option == "HIDE-ERRORS" )
              this.showErrors = false;
            else if (option == "HIDE-REPEATS" )
              this.showRepeats = false;
            else if (option == "HIDE-LOOPS" )
              this.showLoops = false;
            else if (option == "HIDE-SUMMARY" )
              this.showSummary = false;
            else if (option == "HIDE-NONTRADES" )
              this.showNonTrades = false;
            else if (option == "HIDE-STATS" )
              this.showStats = false;
            else if (option == "SHOW-MISSING" )
              this.showMissing = true;
            else if (option == "SORT-BY-ITEM" )
              this.sortByItem = true;
            else if (option == "ALLOW-DUMMIES" )
              this.allowDummies = true;
            else if (option == "SHOW-ELAPSED-TIME" )
              this.showElapsedTime = true;
            else if (option == "LINEAR-PRIORITIES" )
              this.priorityScheme = LINEAR_PRIORITIES;
            else if (option == "TRIANGLE-PRIORITIES" )
              this.priorityScheme = TRIANGLE_PRIORITIES;
            else if (option == "SQUARE-PRIORITIES" )
              this.priorityScheme = SQUARE_PRIORITIES;
            else if (option == "SCALED-PRIORITIES" ) {
              this.priorityScheme = SCALED_PRIORITIES;
              //this.fatalError("SCALED-PRIORITIES no longer supported!",lineNumber);
            }
            else if (option == "EXPLICIT-PRIORITIES" )
              this.priorityScheme = EXPLICIT_PRIORITIES;
            else if (option.startsWith("SMALL-STEP=")) {
              let num = option.substring(11);
              if (!num.match(/\d+/))
                this.fatalError("SMALL-STEP argument must be a non-negative integer",lineNumber);
              this.smallStep = Number(num);
              smallStepFlag = true;
            }
            else if (option.startsWith("BIG-STEP=")) {
              let num = option.substring(9);
              if (!num.match(/\d+/))
                this.fatalError("BIG-STEP argument must be a non-negative integer",lineNumber);
              this.bigStep = Number(num);
              bigStepFlag = true;
            }
            else if (option.startsWith("NONTRADE-COST=")) {
              let num = option.substring(14);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("NONTRADE-COST argument must be a positive integer",lineNumber);
              this.nonTradeCost = Number(num);
            }
            else if (option.startsWith("ITERATIONS=")) {
              let num = option.substring(11);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("ITERATIONS argument must be a positive integer",lineNumber);
              this.iterations = Number(num);
            }
            else if (option.startsWith("SEED=")) {
              let num = option.substring(5);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("SEED argument must be a positive integer",lineNumber);
              this.graph.setSeed(Number(num));
            }
            else if (option.startsWith("SHRINK=")) {
              let num = option.substring(7);
              if (!num.match(/[0-9]/)) {
                this.fatalError("SHRINK argument must be a single digit",lineNumber);
              }
              this.shrinkLevel = Number(num);
            }
            else if (option == "SHRINK-VERBOSE") {
              this.shrinkVerbose = true;
            }
            else if (option == "SHOW-WANTS") {
              this.showWants = true;
            }
            else if (option.startsWith("METRIC=")) {
              let metric = option.substring(7);
              metric = metric.replace(/\s+/,"");
	      let metrics = metric.split(/,/);
              this.metric = [];
              for( let m of metrics ) {
                if( metricmap[m] == null )
                  this.fatalError("unknown METRIC="+m,lineNumber);
                else
                  this.metric.push(metricmap[m]);
              }
            }
            else
              this.fatalError("Unknown option \""+option+"\"",lineNumber);

            this.options.push(option);
          }
        continue;
      }
      if( line.match("#.*") ) {
        if( line.indexOf('+') == 1 ) // #+ prefixed comments copy to our output
          this.outputln(line);
        continue; // skip comment line
      }
      if( line.indexOf("#") != -1 )
        if( readingOfficialNames ) {
          if( line.split("[:\\s]")[0].indexOf("#") != -1 ) {
            this.fatalError("# symbol cannot be used in an item name",lineNumber);
          }
        }
	else {
          this.fatalError("Comments (#...) cannot be used after beginning of line",lineNumber);
        }

      if( line.search(/!BEGIN-OFFICIAL-NAMES/i) != -1 ) {
        if( this.officialNames != null )
          this.fatalError("Cannot begin official names more than once", lineNumber);
        if( wantLists.length > 0 )
          this.fatalError("Official names cannot be declared after first real want list", lineNumber);

        this.officialNames = new Array();
        readingOfficialNames = true;
        continue;
      }
      if( line.search(/!END-OFFICIAL-NAMES/i) != -1 ) {
        if( ! readingOfficialNames )
          this.fatalError("!END-OFFICIAL-NAMES without matching !BEGIN-OFFICIAL-NAMES", lineNumber);
        readingOfficialNames = false;
        continue;
      }
      if( readingOfficialNames ) {
        if( line.charAt(0) == ':' )
          fatalError("Line cannot begin with colon",lineNumber);
        if( line.charAt(0) == '%' )
          fatalError("Cannot give official names for dummy items",lineNumber);

        let toks = line.split(/\s+/);
        let name = toks[0];
        if( ! this.caseSensitive )
          name = name.toUpperCase();
        if( this.officialNames[name] )
          this.fatalError("Official name "+name+"+ already defined",lineNumber);
        this.officialNames[name] = true;
        continue;
      }

      if( line.indexOf('(') == -1 && this.requireUsername )
        fatalError("Missing username with REQUIRE-USERNAMES selected",lineNumber);
      if( line.charAt(0) == '(' ) {
        if( line.lastIndexOf('(') > 0 )
          fatalError("Cannot have more than one '(' per line",lineNumber);
        let close = line.indexOf(')');
        if( close == -1 )
          fatalError("Missing ')' in username",lineNumber);
        if (close == line.length-1)
          fatalError("Username cannot appear on a line by itself",lineNumber);
        if (line.lastIndexOf(")") > close)
          fatalError("Cannot have more than one ')' per line",lineNumber);
        if (close == 1)
          fatalError("Cannot have empty parentheses",lineNumber);

        // temporarily replace spaces in username with #'s
        if( line.indexOf(' ') < close )
          line = line.substring(0,close+1).replace(/ /g,"#") + " "
                    + line.substring(close+1);
      }

      line = line.replace(":", "").replace(";", " ; ").replace(")", ") ");

      if( ! this.caseSensitive )
        line = line.toUpperCase();

      let splitedup = line.trim().split(/\s+/);

      wantLists.push(splitedup);
    }
  }

  buildGraph(wantLists) {
    let unknowns = [];

    for( let i = 0 ; i < wantLists.length ; i++ ) {
      let list = wantLists[i];
      let name = list[0];
      let user = null;
      let offset = 0;

      if( name.charAt(0) == '(' ) {
        user = name.replace(/#/g, " ");
        list.shift(); // removes what's at index 0 and shrinks array
        wantLists[i] = list;
        name = list[0];
      }

// todo ....

      let isDummy = name.charAt(0) == '%';
      if( isDummy ) {
        if( user == null )
          this.errors.push("**** Dummy item " + name + " declared without a username.");
        else if (!this.allowDummies)
          this.errors.push("**** Dummy items not allowed. ("+name+")");
        else {
          name += " for user " + user;
          list[0] = name;
        }
      }
      if( this.officialNames != null && ! this.officialNames[name] && name.charAt(0) != '%' ) {
        this.errors.push("**** Cannot define want list for "+name+" because it is not an official name.  (Usually indicates a typo by the item owner.)");
        wantLists[i] = null;
      }
      else if( this.graph.getVertex(name) != null ) {
        this.errors.push("**** Item " + name + " has multiple want lists--ignoring all but first.  (Sometimes the result of an accidental line break in the middle of a want list.)");
        wantLists[i] = null;
      }
      else {
        this.ITEMS++;
        if( isDummy )
          this.DUMMY_ITEMS++;
        let vertex = this.graph.addVertex(name,user,isDummy);
        if( this.officialNames != null && this.officialNames[name] )
          this.usedNames.push(name);

        if( ! isDummy )
          this.width = Math.max(this.width, this.show(vertex).length);
      }
    }

    // create the edges
    for( let list of wantLists ) {
      if( list == null )
        continue;

      let fromName = list[0];
      let fromVertex = this.graph.getVertex(fromName);

      // add the "no-trade" edge to itself
      this.graph.addEdge(fromVertex,fromVertex.twin,this.nonTradeCost);

      let rank = 1;

      for( let i = 1 ; i < list.length ; i++ ) {
        let toName = list[i];

        if( toName == ";" ) {
          rank += this.bigStep;
          continue;
        }

        if( toName.indexOf('=') != -1 ) {
          if( this.priorityScheme != EXPLICIT_PRIORITIES ) {
            this.errors.push("**** Cannot use '=' annotation in item "+toName+" in want list for item "+fromName+" unless using EXPLICIT_PRIORITIES.");
            continue;
          }
          if( toName.match(/[^=]+=[0-9]+/) == null ) {
            errors.push("**** Item "+toName+" in want list for item "+fromName+" must have the format 'name=number'.");
            continue;
          }
          let parts = toName.split("=");
          let explicitCost = Number(parts[1]);
          if( explicitCost < 1 ) {
            errors.push("**** Explicit priority must be positive in item "+toName+" in want list for item "+fromName+".");
            continue;
          }
          rank = explicitCost;
          toName = parts[0];
        }
        if( toName.charAt(0) == '%' ) {
          if( fromVertex.user == null ) {
            errors.push("**** Dummy item " + toName + " used in want list for item " + fromName + ", which does not have a username.");
            continue;
          }

          toName += " for user " + fromVertex.user;
        }

        let toVertex = this.graph.getVertex(toName);
        if( toVertex == null ) {
          if( this.officialNames != null && this.officialNames[toName] ) {
            // this is an official item whose owner did not submit a want list
            rank += this.smallStep;
          }
          else {
            let occurances = unknowns[toName] ? unknowns[toName] : 0;
            unknowns[toName] = occurances + 1;
          }
          continue;
        }

        toVertex = toVertex.twin;
        if( toVertex == fromVertex.twin )
          this.errors.push("**** Item " + toName + " appears in its own want list.");
        else if( this.graph.getEdge(fromVertex,toVertex) != null ) {
          if( this.showRepeats )
            this.errors.push("**** Item " + toName + " is repeated in want list for " + fromName + ".");
        }
        else if( ! toVertex.isDummy && fromVertex.user != null && fromVertex.user == toVertex.user ) {
          this.errors.push("**** Item "+fromVertex.name +" contains item "+toVertex.name+" from the same user ("+fromVertex.user+")");
        }
        else {
          let cost = UNIT;

          switch( this.priorityScheme ) {
            case LINEAR_PRIORITIES:   cost = rank; break;
            case TRIANGLE_PRIORITIES: cost = rank*(rank+1)/2; break;
            case SQUARE_PRIORITIES:   cost = rank*rank; break;
            case SCALED_PRIORITIES:   cost = rank; break; // assign later
            case EXPLICIT_PRIORITIES: cost = rank; break;
          }

          if( fromVertex.isDummy )
            cost = this.nonTradeCost;

          this.graph.addEdge(fromVertex, toVertex, cost);

          rank += this.smallStep;
        }
      }

      // update costs for those priority schemes that need information such as
      // number of wants
      if (!fromVertex.isDummy) {
        switch (this.priorityScheme) {
          case SCALED_PRIORITIES:
            let n = fromVertex.edges.length-1;
            for (let edge of fromVertex.edges) {
              if (edge.sender != fromVertex.twin)
                edge.cost = 1 + (edge.cost-1)*2520/n;
            }
            break;
        }
      }
    }

    this.graph.freeze();

    for( let entry in unknowns ) {
      let plural = unknowns[entry] == 1 ? "" : "s";
      this.errors.push("*** Unknown item " + entry + " (" + unknowns[entry] + " occurrence" + plural + ")");
    }
  } // buildGraph

  show(vertex) {
    if( vertex.user == null || vertex.isDummy )
      return vertex.name;
//    else if( sortByItem )
//      return vertex.name + " " + vertex.user;
    else
      return vertex.user + " " + vertex.name;
  }

  displayMatches(cycles) {
    let numTrades = 0;
    let numGroups = cycles.length;
    let totalCost = 0;
    let sumOfSquares = 0;
    let groupSizes = new Array();

    let summary = new Array();
    let loops = new Array();

    let alltrades = new Array();

    for( let cycle of cycles ) {
      let size = cycle.length;
      numTrades += size;
      sumOfSquares += size*size;
      groupSizes.push(size);
      for( let v of cycle ) {
        loops.push(this.pad(this.show(v)) + " receives " + this.show(v.match.twin));
        summary.push(this.pad(this.show(v)) + " receives " + this.pad(this.show(v.match.twin)) + " and sends to " + this.show(v.twin.match));
        alltrades.push(this.show(v) + " receives " + this.show(v.match.twin));
        totalCost += v.matchCost;
      }
      loops.push("");
    }

    let resultChecksum = null;

    let hash = md5.create();
    for( let trade of alltrades.sort() ) {
      hash.update(trade);
      hash.update('\n');
    }
    resultChecksum = hash.hex();

    if( this.showNonTrades ) {
      for( let v of this.graph.receivers ) {
        if( v.match == v.twin && ! v.isDummy )
          summary.push(show(v) + "             does not trade");
      }

      for( let v of this.graph.orphans ) {
        if( ! v.isDummy )
          summary.push(this.pad(show(v)) + "             does not trade");
      }
    }

    if( this.showLoops ) {
      this.outputln("TRADE LOOPS (" + numTrades + " total trades):");
      this.outputln("");
      for( let item of loops )
        this.outputln(item);
    }

    if( this.showSummary ) {
      this.outputln("ITEM SUMMARY (" + numTrades + " total trades):");
      this.outputln("");
      for( let item of summary.sort() )
        this.outputln(item);
      this.outputln("");
    }

    this.outputln("Results Checksum: " + resultChecksum + "\n");

    if( this.showStats ) {
      this.output("Num trades   = " + numTrades + " of " + (this.ITEMS-this.DUMMY_ITEMS) + " items");
      if( this.ITEMS-this.DUMMY_ITEMS == 0 )
        this.outputln("");
      else {
        let x = numTrades/(this.ITEMS-this.DUMMY_ITEMS)*100;
        this.outputln(" (" + x.toFixed(1) + "%)");
      }
      this.output("Total cost   = " + totalCost);
      if( numTrades == 0 )
        this.outputln("");
      else {
        let avgcost = totalCost / numTrades;
        this.outputln(" (avg " + avgcost.toFixed(2) + ")");
      }
      this.outputln("Num groups   = " + numGroups);
      this.output("Group sizes  =");
      for( let groupSize of groupSizes.sort(function(a, b){return b - a}) )
        this.output(" " + groupSize);
      this.outputln("");
      this.outputln("Sum squares  = " + sumOfSquares);
    }

    if( this.graph.randomSequence.length > 0 ) {
      this.outputln("\n# Random Numbers: " + this.graph.randomSequence.length);
      let all = "";
      let line = "";
      for( let number of this.graph.randomSequence ) {
        line += " " + number;
        if( line.length > 72 ) {
          all += "#" + line + "\n";
          line = "";
        }
      }
      if( line.length > 0 )
        all += "#" + line + "\n";
      this.output(all);
    }
  } // displayMatches

  pad(name) {
    while( name.length < this.width )
      name += " ";
    return name;
  }

  nameOf(v) {
    return v.name.split(" ")[0];
  }

  printWants() {
// todo
  }
} // class TradeMaximizer

/*
var tm = new TradeMaximizer();
tm.run();
alert(tm.outputstr);
*/

//var tm = new TradeMaximizer();
var xhttp;
var url;
var input;
var lineno;
var tm;

function getaline() {
  if( lineno >= input.length )
    return null;

  return input[lineno++];
}

function outputaline(line, nl) {
  postMessage([OUTPUT, line, nl]);
}

function progress(iteration, maxiteration, metric, tradeCount) {
  postMessage([PROGRESS, iteration, maxiteration, metric, tradeCount]);
}

function fatal(error) {
  postMessage([ERROR, error, true]);
  close();
}

function gotthewants() {
  if( xhttp.readyState == 4 )
    if( xhttp.status == 200 ) {
      input = xhttp.responseText.split(/\n/g);
      lineno = 0;

      tm = new TradeMaximizer();
      tm.run(getaline, outputaline, progress, fatal);

      postMessage([DONE]);
    }
    else {
      let text = MapStatus[xhttp.status];
      if( text != null )
        text += " (" + xhttp.status + ")";
      else
        text = xhttp.status;
      postMessage([ERROR, "Can't retreive " + url + ", " + text]);
    }
}

onerror = function(error) {
  //postMessage([ERROR, error.message + ", " + error.filename + ":" + error.lineno]);
  postMessage([ERROR, error]);
}

onmessage = function(e) {
  switch( e.data[0] ) {
    case RUN :
      // plan1: accept the wants-file text directly instead of XHR-fetching a URL
      input = String(e.data[1]).split(/\n/g);
      lineno = 0;
      tm = new TradeMaximizer();
      tm.run(getaline, outputaline, progress, fatal);
      postMessage([DONE]);
      break;

    case ABORT :
      break;
  }
}
