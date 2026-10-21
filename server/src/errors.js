export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra) this.extra = extra;                       // more for the page to use, sent along with the message and code
  }
}
export const bad = (msg, code) => new HttpError(400, msg, code);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, code, extra) => new HttpError(409, msg, code, extra);
