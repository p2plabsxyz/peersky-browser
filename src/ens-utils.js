import contentHashLib from 'content-hash';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { base36 } from 'multiformats/bases/base36';
import { base58btc } from 'multiformats/bases/base58';

const archiveMultibaseDecoder = base32.decoder.or(base36.decoder).or(base58btc.decoder);

// Normalize a raw ENS content hash to a user-friendly ipfs://bafy… or ipns://… URL
export function normalizeEnsHash(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  try {
    // Already a protocol URL — normalise CIDv0 → v1 for ipfs:// only
    if (raw.startsWith('ipfs://') || raw.startsWith('IPFS://')) {
      const cidStr = raw.slice(7);
      const cid = CID.parse(cidStr, archiveMultibaseDecoder);
      const v1 = cid.version === 1 ? cid : cid.toV1();
      return 'ipfs://' + v1.toString(base32);
    }
    if (raw.startsWith('ipns://') || raw.startsWith('IPNS://')) {
      return raw.toLowerCase();
    }
    // Encoded content hash from ENS resolver
    const codec = contentHashLib.getCodec(raw);
    const decoded = contentHashLib.decode(raw);
    if (codec === 'ipfs-ns') {
      const cid = CID.parse(decoded, archiveMultibaseDecoder);
      const v1 = cid.version === 1 ? cid : cid.toV1();
      return 'ipfs://' + v1.toString(base32);
    }
    if (codec === 'ipns-ns') {
      return 'ipns://' + decoded;
    }
  } catch (_) {
    // Fallback: return as-is
  }
  return raw;
}
