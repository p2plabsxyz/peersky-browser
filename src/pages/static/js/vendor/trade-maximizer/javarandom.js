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
