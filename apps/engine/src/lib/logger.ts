import pino from 'pino';

/** Paths that must never reach logs. Extend, never shrink. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-spectrum-signature"]',
  'headers.authorization',
  'authorization',
  'cardToken',
  '*.cardToken',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'privateKey',
  '*.privateKey',
  'signedDelegateAction',
  '*.signedDelegateAction',
  'planSignature',
  '*.planSignature',
  'enrollCode',
  '*.enrollCode',
  'body',
  '*.body',
];

export type Logger = pino.Logger;

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { svc: 'penny-engine' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
