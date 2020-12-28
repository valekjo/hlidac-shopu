/** @typedef { import("@pulumi/awsx/apigateway").Response } GatewayResponse */

/**
 * @param {string} location
 * @returns {GatewayResponse}
 */
export function movedPermanently(location) {
  return {
    statusCode: 301,
    headers: { "Location": location },
    body: ""
  };
}

/**
 * @param {Record<string, string | number>} body
 * @returns {GatewayResponse}
 */
export function notFound(body = { error: "Data not found" }) {
  return {
    statusCode: 404,
    body: JSON.stringify(body)
  };
}

/**
 * @param {Record<string, unknown> | string} body
 * @param {Record<string, boolean | number | string>} [headers]
 * @returns {GatewayResponse}
 */
export function response(body, headers) {
  return {
    statusCode: 200,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers
  };
}

/**
 * @callback ResponseTransformer
 * @param {GatewayResponse} in
 * @returns {GatewayResponse}
 */
/**
 * @param {string | string[]} methods
 * @param {string} [origin]
 * @return {ResponseTransformer}
 */
export function withCORS(methods, origin = "*") {
  const allowMethods = Array.isArray(methods) ? methods.join(",") : methods;
  return x => ({
    ...x,
    headers: {
      ...x.headers,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": allowMethods,
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token"
    }
  });
}
