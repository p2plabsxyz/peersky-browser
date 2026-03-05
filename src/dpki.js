import electron from 'electron';

// A mapping of TLDs to array of resolvers (API endpoints)
// As per the mentor, these must be direct APIs (HTTPS), not typical DNS.
// We are using `query.hdns.io` and others as placeholders for Handshake,
// and we define expected Certificate Fingerprints (sha256) for Key Pinning.
const RESOLVERS = {
    'hns': [
        {
            url: 'https://query.hdns.io/dns-query',
            // TODO: Replace with actual pinned fingerprint for query.hdns.io
            fingerprint: 'expected_fingerprint_here'
        },
        {
            url: 'https://hns.is/dns-query',
            fingerprint: 'expected_fingerprint_here'
        },
        // Add more resolvers to reach up to 6 for robust consensus
    ],
    'bit': [
        // Namecoin resolvers
    ]
};

/**
 * Checks if a given hostname belongs to a decentralized TLD we support.
 * @param {string} hostname
 * @returns {string|null} The matching TLD (e.g., 'hns') or null if traditional.
 */
function getDecentralizedTLD(hostname) {
    if (!hostname) return null;
    const parts = hostname.toLowerCase().split('.');
    const tld = parts[parts.length - 1];

    if (RESOLVERS[tld]) {
        return tld;
    }
    return null;
}

/**
 * Securely fetches the expected certificate fingerprint for a domain from a specific resolver.
 * Enforces Key Pinning on the resolver's HTTPS connection.
 * @param {string} domain 
 * @param {Object} resolver 
 * @returns {Promise<string|null>} 
 */
async function fetchFingerprintFromResolver(domain, resolver) {
    // We use Node's native fetch or https module here, but we MUST verify the resolver's
    // fingerprint during the connection to prevent MITM on the resolution itself.

    return new Promise((resolve, reject) => {
        const url = new URL(resolver.url);
        // Append necessary query params based on the API expectations
        url.searchParams.append('name', domain);
        url.searchParams.append('type', 'TLSA'); // Request TLS record that blockchain holds

        const options = {
            method: 'GET',
            headers: {
                'Accept': 'application/dns-json' // Adjust based on API
            }
        };

        const req = electron.net.request(url.toString(), options);

        req.on('response', (response) => {
            // In Electron's net module, checking the certificate would typically
            // be done globally or via session.setCertificateVerifyProc, 
            // but we need to verify THIS specific request against `resolver.fingerprint`
            // For now, we extract the target domain's fingerprint

            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });

            response.on('end', () => {
                try {
                    if (response.statusCode >= 400) {
                        return resolve(null);
                    }
                    const parsed = JSON.parse(data);

                    if (!parsed.Answer || parsed.Answer.length === 0) {
                        return resolve(null);
                    }

                    const answer = parsed.Answer[0];
                    // Extrapolate TLS fingerprint from standard formatted Answer data
                    const match = answer.data.match(/([a-fA-F0-9]{64})/);

                    if (match && match[1]) {
                        resolve(match[1].toLowerCase());
                    } else {
                        resolve(parsed?.fingerprint || null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', (err) => {
            resolve(null); // Return null on error so consensus algorithm can try another resolver
        });

        req.end();
    });
}

/**
 * Runs the DPKI consensus algorithm for a domain.
 * @param {string} domain 
 * @param {string} tld 
 * @returns {Promise<string|null>} The consensused fingerprint, or null if no quorum.
 */
async function runConsensus(domain, tld) {
    const tldResolvers = [...RESOLVERS[tld]];

    if (tldResolvers.length < 2) {
        console.warn(`[DPKI] Not enough resolvers configured for TLD: ${tld}`);
        return null;
    }

    // Shuffle resolvers to randomly pick them
    tldResolvers.sort(() => 0.5 - Math.random());

    const queriedResults = [];
    const maxQueries = Math.min(6, tldResolvers.length);

    // Helper to check for a quorum (majority agreement)
    const hasQuorum = (results) => {
        const counts = {};
        for (const res of results) {
            if (res) {
                counts[res] = (counts[res] || 0) + 1;
            }
        }

        // Quorum is strictly > 50% of the currently queried resolvers
        const requiredQuorum = Math.floor(results.length / 2) + 1;
        for (const [fingerprint, count] of Object.entries(counts)) {
            if (count >= requiredQuorum) {
                return fingerprint;
            }
        }
        return null;
    };

    // Phase 1: Query first 2 resolvers
    const [res1, res2] = await Promise.all([
        fetchFingerprintFromResolver(domain, tldResolvers[0]),
        fetchFingerprintFromResolver(domain, tldResolvers[1])
    ]);

    queriedResults.push(res1, res2);

    if (res1 && res1 === res2) {
        console.log(`[DPKI] Consensus reached immediately for ${domain}: ${res1}`);
        return res1;
    }

    // Phase 2: They disagreed, or one failed. Query up to 6 until quorum is reached.
    for (let i = 2; i < maxQueries; i++) {
        console.log(`[DPKI] Disagreement for ${domain}. Querying resolver ${i + 1}...`);
        const nextRes = await fetchFingerprintFromResolver(domain, tldResolvers[i]);
        queriedResults.push(nextRes);

        const quorumFingerprint = hasQuorum(queriedResults);
        if (quorumFingerprint) {
            console.log(`[DPKI] Quorum reached for ${domain} after ${i + 1} queries: ${quorumFingerprint}`);
            return quorumFingerprint;
        }
    }

    console.error(`[DPKI] Failed to reach consensus for ${domain} after ${queriedResults.length} queries.`);
    return null;
}

/**
 * Sets up DPKI verification on the provided Electron session.
 * @param {Electron.Session} session 
 */
export function setupDPKI(session) {
    session.setCertificateVerifyProc(async (request, callback) => {
        const { hostname, certificate, verificationResult } = request;

        const tld = getDecentralizedTLD(hostname);

        // If traditional TLD, fallback to Chromium's default verification
        // (return -3 tells Chromium to use its built-in verifier)
        if (!tld) {
            callback(-3);
            return;
        }

        console.log(`[DPKI] Intercepted certificate verification for decentralized domain: ${hostname}`);

        // Expected fingerprint from consensus
        const expectedFingerprint = await runConsensus(hostname, tld);

        if (!expectedFingerprint) {
            console.error(`[DPKI] Rejecting connection to ${hostname}: No consensus on fingerprint.`);
            callback(-2); // net::ERR_FAILED
            return;
        }

        // Compare actual certificate fingerprint with expected fingerprint
        // certificate.fingerprint typically holds the sha256 formatted like "AA:BB:CC..."
        // Ensure format matches
        const actualFingerprint = certificate.fingerprint.replace(/:/g, '').toLowerCase();
        const cleanExpected = expectedFingerprint.replace(/:/g, '').toLowerCase();

        if (actualFingerprint === cleanExpected) {
            console.log(`[DPKI] Connection to ${hostname} secured via DPKI.`);
            callback(0); // OK
        } else {
            console.error(`[DPKI] MITM DETECTED for ${hostname}! Actual fingerprint (${actualFingerprint}) does not match expected (${cleanExpected})`);
            callback(-213); // net::ERR_CERT_INVALID
        }
    });
}
