import type { RequestHandler } from "express";

/** Private production HTML and API responses share these delivery restrictions. */
export const privatePilotHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cache-Control", "no-store");
  next();
};
