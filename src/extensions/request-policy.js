const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getHeaderValue(headers, headerName) {
  if (!headers) return null;

  if (typeof headers.get === "function") {
    return headers.get(headerName) || null;
  }

  if (typeof headers === "object") {
    const match = Object.keys(headers).find((k) => String(k).toLowerCase() === headerName.toLowerCase());
    return match ? headers[match] : null;
  }

  return null;
}

function extractExtensionId(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "chrome-extension:" && parsed.hostname) {
      return parsed.hostname;
    }
  } catch (e) {
    // Ignore malformed candidates.
  }
  return null;
}

export function getExtensionIdFromRequest(request) {
  const candidates = [
    request?.referrer,
    getHeaderValue(request?.headers, "origin"),
    getHeaderValue(request?.headers, "referer"),
  ];

  for (const candidate of candidates) {
    const extensionId = extractExtensionId(candidate);
    if (extensionId) return extensionId;
  }

  return null;
}

export function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || "GET").toUpperCase());
}

export async function enforceExtensionWritePolicy({
  request,
  scheme,
  isExtensionWriteAllowed,
}) {
  if (!isWriteMethod(request?.method)) return null;

  const extensionId = getExtensionIdFromRequest(request);
  if (!extensionId) return null;

  let allowed = false;
  try {
    if (typeof isExtensionWriteAllowed === "function") {
      allowed = Boolean(await isExtensionWriteAllowed({
        extensionId,
        scheme,
        method: String(request.method || "GET").toUpperCase(),
        url: request.url,
      }));
    }
  } catch (error) {
    console.warn(`[ProtocolPolicy] Failed extension write check for ${scheme}:`, error?.message || error);
    allowed = false;
  }

  if (allowed) return null;

  return new Response(
    `Extension ${extensionId} is not allowed to write ${scheme} content`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
